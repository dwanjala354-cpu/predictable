'use strict';
const express = require('express');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const wallet = require('./wallet');
const markets = require('./markets');
const settlement = require('./settlement');
const admin = require('./admin');
const ai = require('./ai');
const intel = require('./intel');
const trading = require('./trading');
const tax = require('./tax');
const security = require('./security');
const { AppError, bad, forbidden, notFound, toMinor, randToken } = require('./util');
const { getSetting, getInt, audit } = require('./common');

const kes = (v) => (v === undefined || v === null || v === '' ? undefined : toMinor(v));

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : (isNaN(+process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : +process.env.TRUST_PROXY));
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Pages use inline event handlers, so script-src needs 'unsafe-inline'. Everything else is locked to this origin.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const limitOn = process.env.RATE_LIMIT !== 'off';
  if (limitOn) {
    app.use('/api', security.rateLimit({ windowMs: 60000, max: parseInt(process.env.RATE_LIMIT_API || '600', 10) }));
    app.use(['/api/auth', '/api/appeals', '/api/payments'], security.rateLimit({ windowMs: 60000, max: parseInt(process.env.RATE_LIMIT_AUTH || '30', 10) }));
  }

  // Wrap a handler: resolves the session, enforces auth/permissions, runs inside one DB transaction.
  const h = (opts, fn) => {
    if (typeof opts === 'function') { fn = opts; opts = {}; }
    const handler = async (req, res) => {
      try {
        const out = await db.tx(async (c) => {
          const token = (req.headers.authorization || '').replace(/^Bearer /, '') || null;
          const user = await auth.userFromToken(c, token);
          if (opts.auth && !user) throw new AppError(401, 'AUTH_REQUIRED', 'Please sign in');
          if (opts.perm && !auth.can(user, opts.perm)) throw forbidden();
          if (opts.perm && !opts.noMfaGate) await security.assertStaffEnrolled(c, user);
          try { return await fn({ c, user, token, req, res }); }
          catch (e) { if (e && e.commit) return { __fail: e }; throw e; }   // commit failed-attempt counters, then report the error
        });
        if (out && out.__fail) throw out.__fail;
        if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
      } catch (e) { sendError(res, e); }
    };
    handler.meta = { auth: !!opts.auth, perm: opts.perm || null };   // read by the permission-matrix test
    return handler;
  };
  // Same checks as h, but the handler runs OUTSIDE the transaction (used where it must do network I/O, e.g. feed refresh).
  const hx = (opts, fn) => {
    const handler = async (req, res) => {
      try {
        const user = await db.tx(async (c) => {
          const u = await auth.userFromToken(c, (req.headers.authorization || '').replace(/^Bearer /, '') || null);
          if (opts.auth && !u) throw new AppError(401, 'AUTH_REQUIRED', 'Please sign in');
          if (opts.perm && !auth.can(u, opts.perm)) throw forbidden();
          if (opts.perm) await security.assertStaffEnrolled(c, u);
          return u;
        });
        res.json(await fn({ user, req }));
      } catch (e) { sendError(res, e); }
    };
    handler.meta = { auth: !!opts.auth, perm: opts.perm || null };
    return handler;
  };
  const A = { auth: true };
  const P = (perm) => ({ auth: true, perm });

  // ─────────── Public ───────────
  app.get('/api/health', (_q, res) => res.json({ ok: true, service: 'predictable', mode: 'SIMULATED_FUNDS' }));
  app.get('/api/config', h(async ({ c }) => {
    const r = await tax.rates(c);
    return {
      mode: 'SIMULATED_FUNDS', currency: 'KES', contract_value_minor: 10000, min_price_kes: 1, max_price_kes: 99,
      fees: { deposit_excise_bps: r.depositExcise, deposit_fee_bps: r.depositFee, withdrawal_wht_bps: r.withdrawalWht, withdrawal_fee_bps: r.withdrawalFee,
        winnings_wht_bps: r.winningsWht, profit_commission_bps: r.profitCommission, tax_on_exit_sales: r.taxOnExit },
      limits: { min_order_shares: await getInt(c, 'min_order_shares'), max_order_shares: await getInt(c, 'max_order_shares'), max_position_shares: await getInt(c, 'max_position_shares') },
      dual_approval_threshold_minor: await getInt(c, 'dual_approval_threshold_minor'),
      notice: 'This preview runs on simulated money. Real-money trading is not offered until the required licence and approvals are in place.',
    };
  }));
  // What a deposit or withdrawal of a given size will cost, before the user commits.
  app.get('/api/fees/quote', h(async ({ c, req }) => {
    const gross = toMinor(req.query.amount_kes), r = await tax.rates(c);
    if (!Number.isSafeInteger(gross) || gross <= 0) throw bad('BAD_AMOUNT', 'Enter an amount');
    return req.query.type === 'withdrawal' ? tax.withdrawalSplit(gross, r) : tax.depositSplit(gross, r);
  }));
  app.get('/api/categories', h(({ c }) => c.q('SELECT id, name, slug FROM categories WHERE parent_id IS NULL ORDER BY id')));
  app.get('/api/markets', h(({ c, user, req }) => markets.listMarkets(c, user, req.query)));
  app.get('/api/markets/:id/book', h(({ c, user, req }) => trading.orderBook(c, +req.params.id, user)));
  app.get('/api/markets/:id/history', h(({ c, req }) => trading.priceHistory(c, +req.params.id)));
  app.get('/api/markets/:id', h(({ c, user, req }) => markets.getMarket(c, user, +req.params.id)));
  app.get('/api/leaderboard', h(async ({ c }) => c.q(`
    SELECT u.username, u.display_name, COUNT(*) FILTER (WHERE p.realized_pnl_minor > 0)::int AS wins, COUNT(*)::int AS settled, COALESCE(SUM(p.realized_pnl_minor),0)::bigint AS net_minor
      FROM users u JOIN positions p ON p.user_id=u.id JOIN markets m ON m.id=p.market_id WHERE m.status='SETTLED' AND p.realized_pnl_minor <> 0
     GROUP BY u.id ORDER BY net_minor DESC, wins DESC LIMIT 20`)));
  app.post('/api/ai/validate', h(({ req }) => ai.validateQuestion(req.body || {})));

  // ─────────── Auth ───────────
  const ctxOf = (req) => ({ ip: req.ip, ua: req.headers['user-agent'] });
  const loginHandler = (after) => async (req, res) => {
    try {
      const out = await db.tx(async (c) => { const r = await auth.login(c, req.body || {}, ctxOf(req)); return after ? after(c, r) : r; });
      if (out.fail) throw out.fail;
      res.json(out);
    } catch (e) { sendError(res, e); }
  };
  app.post('/api/auth/register', h(async ({ c, req }) => { await auth.register(c, req.body || {}); }));   // registration only creates the account
  app.post('/api/auth/login', loginHandler());
  app.post('/api/auth/signup-login', async (req, res) => {   // register and sign in as one step for the web app
    try {
      const out = await db.tx(async (c) => { const id = await auth.register(c, req.body || {}); const r = await auth.login(c, { identifier: req.body.username, password: req.body.password }, ctxOf(req)); return { ...r, id }; });
      if (out.fail) throw out.fail; res.json(out);
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/auth/logout', h(A, ({ c, token }) => auth.logout(c, token)));
  // ─────────── Account security ───────────
  app.post('/api/me/mfa/setup', h(A, ({ c, user }) => security.setupMfa(c, user)));
  app.post('/api/me/mfa/enable', h(A, async ({ c, user, req }) => { await security.enableMfa(c, user, (req.body || {}).code); return { mfa_enabled: true }; }));
  app.post('/api/me/mfa/disable', h(A, async ({ c, user, req }) => { await security.disableMfa(c, user, (req.body || {}).code); return { mfa_enabled: false }; }));
  app.get('/api/me/sessions', h(A, ({ c, user, token }) => security.listSessions(c, user.id, require('./util').sha256(token))));
  app.delete('/api/me/sessions/:id', h(A, ({ c, user, req }) => security.revokeSession(c, user.id, +req.params.id)));
  app.post('/api/me/password', h(A, ({ c, user, token, req }) => security.changePassword(c, user.id, require('./util').sha256(token), req.body.current, req.body.next)));
  // A suspended player cannot sign in, so appeals authenticate with credentials instead of a session.
  app.post('/api/appeals', async (req, res) => {
    try {
      const out = await db.tx(async (c) => {
        const b = req.body || {}; const ctx = ctxOf(req);
        await security.assertNotLocked(c, b.identifier || '', ctx.ip);
        const u = await c.one('SELECT id, password_hash FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)', [String(b.identifier || '')]);
        const ok = u && await require('bcryptjs').compare(b.password || '', u.password_hash);
        if (!ok) { await security.recordAttempt(c, b.identifier, ctx.ip, false); return { fail: new AppError(401, 'BAD_CREDENTIALS', 'Incorrect username or password') }; }
        return security.submitAppeal(c, u.id, b.message);
      });
      if (out.fail) throw out.fail; res.json({ ok: true, id: out.id });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/me', h(A, async ({ c, user }) => ({ user, balances: await ledger.balances(c, user.id) })));
  app.post('/api/me/kyc/simulate', h(A, async ({ c, user }) => { await auth.simulateKyc(c, user.id); return { kyc_status: 'VERIFIED' }; }));
  app.get('/api/me/limits', h(A, ({ c, user }) => c.one('SELECT daily_deposit_limit_minor, daily_loss_limit_minor, self_excluded_until FROM responsible_gambling_profiles WHERE user_id=$1', [user.id])));
  app.put('/api/me/limits', h(A, async ({ c, user, req }) => {
    const b = req.body || {};
    const cur = await c.one('SELECT * FROM responsible_gambling_profiles WHERE user_id=$1', [user.id]);
    const dep = b.daily_deposit_limit_kes === '' || b.daily_deposit_limit_kes === null ? null : (b.daily_deposit_limit_kes === undefined ? cur.daily_deposit_limit_minor : toMinor(b.daily_deposit_limit_kes));
    // Limits may be lowered freely; raising an existing limit is the risky direction and is rejected in stage one.
    if (cur.daily_deposit_limit_minor != null && (dep == null || dep > cur.daily_deposit_limit_minor)) throw forbidden('A deposit limit can be lowered immediately but not raised or removed in this release', 'LIMIT_RAISE_BLOCKED');
    let until = cur.self_excluded_until;
    if (b.self_exclude_days) {
      const d = parseInt(b.self_exclude_days, 10);
      if (![1, 7, 30, 90, 180, 365].includes(d)) throw bad('BAD_PERIOD', 'Choose 1, 7, 30, 90, 180 or 365 days');
      const candidate = new Date(Date.now() + d * 86400000);
      if (!until || candidate > new Date(until)) until = candidate.toISOString();    // an exclusion can only be extended
    }
    await c.q('UPDATE responsible_gambling_profiles SET daily_deposit_limit_minor=$2, self_excluded_until=$3, updated_at=now() WHERE user_id=$1', [user.id, dep, until]);
    await audit(c, user.id, 'rg.update', 'user', user.id, { dep, until });
    return c.one('SELECT daily_deposit_limit_minor, daily_loss_limit_minor, self_excluded_until FROM responsible_gambling_profiles WHERE user_id=$1', [user.id]);
  }));

  // ─────────── Wallet ───────────
  app.get('/api/wallet', h(A, async ({ c, user }) => ({ balances: await ledger.balances(c, user.id), history: await wallet.history(c, user.id, 100),
    withdrawals: await c.q('SELECT id, reference, amount_minor, destination, status, requested_at FROM withdrawal_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [user.id]),
    deposits: await c.q('SELECT id, reference, amount_minor, status, created_at FROM payment_intents WHERE user_id=$1 ORDER BY id DESC LIMIT 20', [user.id]) })));
  app.post('/api/wallet/deposit', h(A, async ({ c, user, req }) => {
    const pi = await wallet.createDeposit(c, user.id, toMinor(req.body.amount_kes));
    return { reference: pi.reference, amount_minor: pi.amount_minor, status: pi.status };
  }));
  // Stage-one stand-in for the payment provider: builds the signed callback and sends it through the SAME verified handler production will use.
  app.post('/api/wallet/deposit/:ref/simulate-pay', h(A, async ({ c, user, req }) => {
    const pi = await c.one('SELECT * FROM payment_intents WHERE reference=$1 AND user_id=$2', [req.params.ref, user.id]);
    if (!pi) throw notFound('Deposit not found');
    const body = JSON.stringify({ event_id: 'sim-' + pi.reference, reference: pi.reference, status: 'SUCCESS', amount_minor: pi.amount_minor });
    const sig = wallet.signCallback(await getSetting(c, 'payment_callback_secret'), body);
    return wallet.handleProviderCallback(c, body, sig);
  }));
  app.post('/api/payments/callback', h(({ c, req }) => wallet.handleProviderCallback(c, req.rawBody || '', req.headers['x-signature'])));
  app.post('/api/wallet/withdraw/otp', h(A, async ({ c, user }) => { await wallet.assertCanTransact(c, user.id); return security.issueOtp(c, user, 'WITHDRAW'); }));
  app.post('/api/wallet/withdraw', h(A, async ({ c, user, req }) => {
    if (await getSetting(c, 'require_withdrawal_otp') === '1') await security.consumeOtp(c, user, 'WITHDRAW', req.body.otp);
    return wallet.requestWithdrawal(c, user.id, toMinor(req.body.amount_kes), req.body.destination);
  }));

  // ─────────── Markets & trading ───────────
  app.post('/api/markets', h(A, ({ c, user, req }) => markets.createMarket(c, user, req.body || {})));
  app.patch('/api/markets/:id', h(A, ({ c, user, req }) => markets.editMarket(c, user, +req.params.id, req.body || {})));
  app.post('/api/markets/:id/submit', h(A, ({ c, user, req }) => markets.submitForReview(c, user, +req.params.id)));
  app.post('/api/markets/:id/orders', h(A, ({ c, user, req }) => trading.placeOrder(c, user, +req.params.id, req.body || {})));
  app.post('/api/markets/:id/orders/preview', h(A, ({ c, user, req }) => trading.preview(c, user, +req.params.id, req.body || {})));
  app.delete('/api/orders/:id', h(A, ({ c, user, req }) => trading.cancelOrder(c, user, +req.params.id)));
  app.post('/api/markets/:id/report', h(A, ({ c, user, req }) => admin.report(c, user, +req.params.id, (req.body || {}).reason)));
  app.post('/api/markets/:id/dispute', h(A, ({ c, user, req }) => settlement.fileDispute(c, user, +req.params.id, req.body || {})));
  app.get('/api/markets/:id/my-payout', h(A, ({ c, user, req }) => c.q("SELECT side, shares, gross_minor, cost_basis_minor, profit_minor, wht_minor, commission_minor, net_minor, created_at FROM payouts WHERE market_id=$1 AND user_id=$2 AND status='PAID' ORDER BY id", [+req.params.id, user.id])));
  app.get('/api/my/positions', h(A, ({ c, user }) => trading.myPositions(c, user.id)));
  app.get('/api/my/orders', h(A, ({ c, user, req }) => trading.myOrders(c, user.id, req.query.status === 'ALL' ? null : (req.query.status || 'OPEN'))));
  app.get('/api/my/trades', h(A, ({ c, user }) => trading.myTrades(c, user.id)));
  app.get('/api/notifications', h(A, async ({ c, user }) => ({
    items: await c.q('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [user.id]),
    unread: (await c.one('SELECT COUNT(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL', [user.id])).n })));
  app.post('/api/notifications/read', h(A, ({ c, user }) => c.q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [user.id])));

  // ─────────── Admin console ───────────
  const AD = 'admin.dashboard';
  app.get('/api/admin/dashboard', h(P(AD), async ({ c }) => ({ metrics: await admin.dashboard(c), flags: await admin.riskFlags(c) })));
  app.get('/api/admin/markets', h(P(AD), ({ c, user }) => admin.listAllMarkets(c, user)));
  app.get('/api/admin/review-queue', h(P(AD), ({ c, user }) => admin.reviewQueue(c, user)));
  app.post('/api/admin/markets/:id/review', h(P(AD), ({ c, user, req }) => {
    const b = req.body || {};
    return markets.review(c, user, +req.params.id, b.decision, b.comments, { amm_subsidy_minor: b.amm_subsidy_kes ? kes(b.amm_subsidy_kes) : 0 });
  }));
  app.post('/api/admin/markets/:id/market-maker', h(P('market.house.manage'), async ({ c, user, req }) => {
    const m = await markets.lockMarket(c, +req.params.id);
    if (!['APPROVED', 'OPEN'].includes(m.status)) throw bad('BAD_STATE', 'A market maker can only be added to an approved or open market');
    await markets.seedAmm(c, m, user.id, kes(req.body.subsidy_kes));
    await trading.refreshPrice(c, m.id);
  }));
  app.get('/api/admin/markets/:id/escrow', h(P(AD), ({ c, req }) => trading.escrowCheck(c, +req.params.id)));
  app.post('/api/admin/markets/:id/suspend', h(P(AD), ({ c, user, req }) => markets.suspend(c, user, +req.params.id, (req.body || {}).reason)));
  app.post('/api/admin/markets/:id/resume', h(P(AD), ({ c, user, req }) => markets.resume(c, user, +req.params.id)));
  app.post('/api/admin/markets/:id/close', h(P(AD), ({ c, user, req }) => markets.closeNow(c, user, +req.params.id)));
  app.post('/api/admin/markets/:id/event-ended', h(P(AD), ({ c, user, req }) => markets.markEventEnded(c, user, +req.params.id)));
  app.post('/api/admin/markets/:id/void', h(P(AD), ({ c, user, req }) => settlement.voidMarket(c, user, +req.params.id, (req.body || {}).reason)));
  app.post('/api/admin/tick', h(P(AD), ({ c }) => markets.tick(c)));
  app.post('/api/admin/orders/:id/cancel', h(P('market.suspend'), ({ c, user, req }) => trading.cancelOrder(c, user, +req.params.id)));

  app.get('/api/admin/settlements', h(P(AD), ({ c, user }) => admin.settlementQueue(c, user)));
  app.post('/api/admin/settlements/preview', h(P(AD), ({ c, user, req }) => settlement.preview(c, user, +req.body.market_id, +req.body.outcome_id)));
  app.post('/api/admin/markets/:id/settlement', h(P(AD), ({ c, user, req }) => settlement.propose(c, user, +req.params.id, req.body || {})));
  app.post('/api/admin/settlements/:id/decision', h(P(AD), async ({ c, user, req }) => {
    if (req.body.decision === 'APPROVED') await security.requireStaffStepUp(c, user, req.body.totp);
    return settlement.approve(c, user, +req.params.id, req.body.decision, req.body.comments);
  }));
  app.post('/api/admin/disputes/:id/resolve', h(P(AD), ({ c, user, req }) => settlement.resolveDispute(c, user, +req.params.id, req.body || {})));

  // ─────────── AI intelligence (advisory only: never moves money, never settles, never publishes) ───────────
  const RM = 'research.manage';
  app.get('/api/admin/ai/ratings', h(P(AD), ({ c, user }) => intel.listRatings(c, user)));
  app.post('/api/admin/ai/ratings', h(P(RM), ({ c, user, req }) => intel.setRating(c, user, req.body || {})));
  app.get('/api/admin/ai/performance', h(P(AD), ({ c, user }) => intel.performance(c, user)));
  app.get('/api/admin/markets/:id/reference-price', h(P(AD), ({ c, user, req }) => intel.recommendOdds(c, user, +req.params.id, { persist: false })));
  app.post('/api/admin/markets/:id/reference-price', h(P(AD), ({ c, user, req }) => intel.recommendOdds(c, user, +req.params.id, { persist: true })));
  app.get('/api/admin/markets/:id/spec', h(P(AD), async ({ c, req }) => (await intel.getSpec(c, +req.params.id)) || null));
  app.post('/api/admin/markets/:id/spec', h(P(RM), ({ c, user, req }) => intel.setResolutionSpec(c, user, +req.params.id, req.body || {})));
  app.get('/api/admin/markets/:id/evidence', h(P(RM), ({ c, user, req }) => intel.evidenceList(c, user, +req.params.id)));
  app.post('/api/admin/markets/:id/evidence', h(P(RM), ({ c, user, req }) => intel.addEvidence(c, user, +req.params.id, req.body || {})));
  app.post('/api/admin/evidence/:id/retract', h(P(RM), ({ c, user, req }) => intel.retractEvidence(c, user, +req.params.id, (req.body || {}).reason)));
  app.post('/api/admin/markets/:id/ai-resolution', h(P('settlement.propose'), ({ c, user, req }) => intel.proposeResolution(c, user, +req.params.id)));
  app.post('/api/admin/ai/resolution-sweep', h(P('settlement.propose'), ({ c, user }) => intel.proposeAll(c, user)));
  app.get('/api/admin/feeds', h(P(RM), ({ c, user }) => intel.listFeeds(c, user)));
  app.post('/api/admin/feeds', h(P(RM), ({ c, user, req }) => intel.addFeed(c, user, req.body || {})));
  app.post('/api/admin/feeds/:id/refresh', hx(P(RM), ({ user, req }) => intel.refreshFeed(db, user, +req.params.id)));
  app.get('/api/admin/suggestions', h(P(RM), ({ c, user }) => intel.listSuggestions(c, user)));
  app.post('/api/admin/suggestions/:id', h(P(RM), ({ c, user, req }) => intel.decideSuggestion(c, user, +req.params.id, (req.body || {}).decision)));
  app.post('/api/admin/risk/scan', h(P('risk.view'), ({ c, user }) => intel.scanRisk(c, user)));
  app.get('/api/admin/risk/alerts', h(P('risk.view'), ({ c, user, req }) => intel.listAlerts(c, user, req.query)));
  app.post('/api/admin/risk/alerts/:id', h(P('risk.view'), ({ c, user, req }) => intel.reviewAlert(c, user, +req.params.id, (req.body || {}).decision, (req.body || {}).note)));

  app.get('/api/admin/users', h(P(AD), ({ c, user, req }) => admin.listUsers(c, user, req.query)));
  app.get('/api/admin/users/:id', h(P(AD), ({ c, user, req }) => admin.userDetail(c, user, +req.params.id)));
  app.post('/api/admin/users/:id/status', h(P(AD), ({ c, user, req }) => admin.setUserStatus(c, user, +req.params.id, req.body.status, req.body.reason)));
  app.post('/api/admin/users/:id/kyc', h(P(AD), ({ c, user, req }) => admin.setKyc(c, user, +req.params.id, req.body.status)));

  app.get('/api/admin/finance', h(P(AD), ({ c, user }) => admin.financeOverview(c, user)));
  app.get('/api/admin/tax', h(P(AD), ({ c, user }) => admin.taxSummary(c, user)));
  app.post('/api/admin/tax/remit', h(P('finance.tax'), async ({ c, user, req }) => {
    await security.requireStaffStepUp(c, user, req.body.totp);
    return admin.remitTax(c, user, req.body || {});
  }));
  app.post('/api/admin/users/:id/market-creator', h(P(AD), ({ c, user, req }) => admin.setCreator(c, user, +req.params.id, req.body.on !== false)));
  app.post('/api/admin/finance/reconcile', h(P(AD), ({ c, user }) => admin.runReconciliation(c, user)));
  app.post('/api/admin/withdrawals/:id', h(P('finance.withdrawals'), async ({ c, user, req }) => {
    if (req.body.approve === true) await security.requireStaffStepUp(c, user, req.body.totp);
    return wallet.completeWithdrawal(c, user.id, +req.params.id, req.body.approve === true);
  }));
  app.get('/api/admin/reports', h(P(AD), ({ c, user }) => admin.listReports(c, user)));
  app.post('/api/admin/reports/:id', h(P(AD), ({ c, user, req }) => admin.resolveReport(c, user, +req.params.id, req.body.status)));
  app.get('/api/admin/audit', h(P(AD), ({ c, user, req }) => admin.auditLogs(c, user, req.query)));
  app.get('/api/admin/audit/verify', h(P('audit.view'), ({ c }) => security.verifyAudit(c)));
  app.get('/api/admin/appeals', h(P('users.manage'), ({ c }) => c.q("SELECT a.*, u.username, u.display_name FROM appeals a JOIN users u ON u.id=a.user_id ORDER BY (a.status='OPEN') DESC, a.id DESC LIMIT 100")));
  app.post('/api/admin/appeals/:id', h(P('users.manage'), ({ c, user, req }) => security.decideAppeal(c, user, +req.params.id, req.body.decision, req.body.note)));
  app.get('/api/admin/staff', h(P(AD), ({ c, user }) => admin.staffList(c, user)));
  app.post('/api/admin/staff', h(P('roles.manage'), async ({ c, user, req }) => {
    const t = await c.one('SELECT id FROM users WHERE lower(username)=lower($1)', [req.body.username || '']);
    if (!t) throw notFound('No such user');
    if (t.id === user.id) throw forbidden('You cannot change your own roles', 'SELF_ACTION');
    await security.requireStaffStepUp(c, user, req.body.totp);
    await auth.changeStaffRole(c, t.id, req.body.role, req.body.grant !== false);
    await audit(c, user.id, 'staff.role', 'user', t.id, { role: req.body.role, grant: req.body.grant !== false });
  }));

  // ─────────── Static front-ends ───────────
  const pub = path.join(__dirname, '..', 'public');
  app.use('/static', express.static(path.join(pub, 'static'), { maxAge: 0 }));
  const page = (f) => (_q, res) => res.sendFile(path.join(pub, f));
  app.get('/', page('app.html'));
  app.get('/app', page('app.html'));
  app.get('/admin', page('admin.html'));
  app.use('/api', (_q, _r, next) => next(new AppError(404, 'NOT_FOUND', 'Unknown endpoint')));
  app.use((err, _req, res, _next) => sendError(res, err));
  return app;
}

function sendError(res, e) {
  if (e instanceof AppError) return res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.extra || {}) } });
  const msg = String(e && e.message || e);
  // Database-enforced integrity rules surface as clean 409s, never as stack traces.
  if (/append-only|unbalanced|terms can no longer|locked: funds|not open for trading|closed at|violates (unique|foreign|check)/i.test(msg)) {
    return res.status(409).json({ error: { code: 'INTEGRITY_RULE', message: msg.replace(/^error: /i, '') } });
  }
  console.error('[error]', e);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
}

module.exports = { createApp, sendError };
