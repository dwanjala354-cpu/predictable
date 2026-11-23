'use strict';
const ledger = require('./ledger');
const markets = require('./markets');
const { bad, forbidden, notFound, conflict } = require('./util');
const { audit, notify, getSetting, getInt } = require('./common');
const { can, publicUser } = require('./auth');

// Dashboard metrics. Volume and escrow are NOT revenue: revenue is only the fees and commission the platform has booked.
async function dashboard(c) {
  const n = async (sql, p = []) => (await c.one(sql, p)).n;
  const bal = async (t) => (await c.one('SELECT balance_minor::bigint b FROM ledger_accounts WHERE wallet_id IS NULL AND account_type=$1', [t])).b;
  const users = await n("SELECT COUNT(*)::int n FROM users WHERE id NOT IN (SELECT user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.name <> 'user')");
  const verified = await n("SELECT COUNT(*)::int n FROM users WHERE kyc_status='VERIFIED'");
  const active = await n("SELECT COUNT(DISTINCT user_id)::int n FROM orders WHERE created_at > now() - interval '30 days'");
  const vol = await c.one('SELECT COALESCE(SUM(volume_minor),0)::bigint v, COALESCE(SUM(trade_count),0)::int t FROM markets');
  const oi = await c.one("SELECT COALESCE(SUM(e.locked_minor),0)::bigint s FROM escrow_pools e JOIN markets m ON m.id=e.market_id WHERE m.status NOT IN ('SETTLED','VOID')");
  const dep = await c.one("SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM payment_intents WHERE status='SUCCEEDED'");
  const wd = await c.one("SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM withdrawal_requests WHERE status='COMPLETED'");
  const amm = await c.one('SELECT COALESCE(SUM(subsidy_minor) FILTER (WHERE returned_minor IS NULL),0)::bigint live, COALESCE(SUM(returned_minor - subsidy_minor) FILTER (WHERE returned_minor IS NOT NULL),0)::bigint pnl, COUNT(*) FILTER (WHERE returned_minor IS NULL)::int pools FROM amm_pools');
  const flags = await riskFlags(c);
  const kraPending = await c.one("SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM tax_events WHERE kra_remittance_status='PENDING'");
  return {
    total_registered_users: users, verified_users: verified, active_traders_30d: active,
    volume_minor: vol.v, trades: vol.t, open_interest_minor: oi.s,
    active_markets: await n("SELECT COUNT(*)::int n FROM markets WHERE status='OPEN'"),
    pending_review: await n("SELECT COUNT(*)::int n FROM markets WHERE status='PENDING_REVIEW'"),
    pending_settlements: await n("SELECT COUNT(*)::int n FROM markets WHERE status IN ('LOCKED','EVENT_PENDING','RESULT_PENDING')"),
    pending_withdrawals: await n("SELECT COUNT(*)::int n FROM withdrawal_requests WHERE status='PENDING'"),
    open_disputes: await n("SELECT COUNT(*)::int n FROM disputes WHERE status='OPEN'"),
    platform_revenue_minor: await bal('SYS_PLATFORM_REVENUE'),
    kra_payable_minor: await bal('SYS_KRA_TAX_PAYABLE'), kra_unremitted_events_minor: kraPending.s, kra_remitted_minor: await bal('SYS_KRA_REMITTED'),
    amm_live_exposure_minor: amm.live, amm_live_pools: amm.pools, amm_realised_result_minor: amm.pnl,
    deposits_minor: dep.s, withdrawals_minor: wd.s,
    suspicious_flags: flags.length,
    simulated_money: true,
  };
}

// Rule-based risk flags. These ALWAYS need a human risk officer — nothing here suspends anyone automatically.
async function riskFlags(c) {
  const flags = [];
  const conc = await c.q(`
    SELECT p.market_id, p.user_id, u.username, m.title, p.yes_shares, p.no_shares, e.locked_minor
      FROM positions p JOIN users u ON u.id=p.user_id JOIN markets m ON m.id=p.market_id JOIN escrow_pools e ON e.market_id=p.market_id
     WHERE m.status IN ('OPEN','LOCKED','EVENT_PENDING','RESULT_PENDING') AND e.locked_minor >= 1000000
       AND (SELECT COUNT(*) FROM positions x WHERE x.market_id=p.market_id AND (x.yes_shares>0 OR x.no_shares>0)) >= 3
       AND (p.yes_shares * 10000 * 100 > e.locked_minor * 60 OR p.no_shares * 10000 * 100 > e.locked_minor * 60)`);
  for (const r of conc) flags.push({ type: 'POSITION_CONCENTRATION', user_id: r.user_id, market_id: r.market_id, detail: `${r.username} holds more than 60% of one side of "${r.title}"` });
  const wash = await c.q(`
    SELECT u.id, u.username, w.amount_minor FROM withdrawal_requests w JOIN users u ON u.id=w.user_id
     WHERE w.status='PENDING' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id=u.id)`);
  for (const r of wash) flags.push({ type: 'WITHDRAWAL_WITHOUT_PLAY', user_id: r.id, detail: `${r.username} requested a withdrawal but has never placed an order` });
  const big = await c.q("SELECT w.id, u.id AS uid, u.username, w.amount_minor FROM withdrawal_requests w JOIN users u ON u.id=w.user_id WHERE w.status='PENDING' AND w.amount_minor >= 5000000");
  for (const r of big) flags.push({ type: 'LARGE_WITHDRAWAL', user_id: r.uid, detail: `${r.username} requested a withdrawal of KES ${r.amount_minor / 100}` });
  return flags;
}

async function listUsers(c, user, { q, limit = 100 } = {}) {
  if (!can(user, 'users.manage')) throw forbidden();
  const rows = await c.q(`
    SELECT u.id, u.username, u.display_name, u.email, u.phone, u.status, u.kyc_status, u.market_creator, u.created_at,
           COALESCE((SELECT string_agg(r.name, ', ') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.name <> 'user'),'') AS staff_roles
      FROM users u WHERE ($1::text IS NULL OR u.username ILIKE $1 OR u.email ILIKE $1 OR u.display_name ILIKE $1)
     ORDER BY u.id DESC LIMIT $2`, [q ? '%' + q + '%' : null, Math.min(limit, 300)]);
  for (const r of rows) r.balances = await ledger.balances(c, r.id);
  return rows;
}

async function setUserStatus(c, actor, userId, status, reason) {
  if (!can(actor, 'users.manage')) throw forbidden();
  if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw bad('BAD_STATUS', 'Status must be ACTIVE or SUSPENDED');
  if (userId === actor.id) throw forbidden('You cannot change your own status', 'SELF_ACTION');
  const u = await c.one('SELECT id FROM users WHERE id=$1', [userId]);
  if (!u) throw notFound('User not found');
  await c.q('UPDATE users SET status=$2 WHERE id=$1', [userId, status]);
  if (status === 'SUSPENDED') await c.q('DELETE FROM user_sessions WHERE user_id=$1', [userId]);
  await audit(c, actor.id, 'user.status', 'user', userId, { status, reason: reason || null });
}

async function setKyc(c, actor, userId, status) {
  if (!can(actor, 'users.manage')) throw forbidden();
  if (!['VERIFIED', 'REJECTED', 'UNVERIFIED'].includes(status)) throw bad('BAD_STATUS', 'Invalid KYC status');
  await c.q('UPDATE users SET kyc_status=$2 WHERE id=$1', [userId, status]);
  await c.q("INSERT INTO kyc_records(user_id, verification_provider, status, verified_at, notes) VALUES ($1,'MANUAL',$2, now(), $3)", [userId, status, 'Set by ' + actor.username]);
  await audit(c, actor.id, 'user.kyc', 'user', userId, { status });
}

async function userDetail(c, actor, userId) {
  if (!can(actor, 'users.manage') && !can(actor, 'finance.view')) throw forbidden();
  const u = await publicUser(c, userId);
  if (!u) throw notFound('User not found');
  const wallet = require('./wallet');
  return { user: u, balances: await ledger.balances(c, userId), transactions: await wallet.history(c, userId, 50),
    positions: await require('./trading').myPositions(c, userId), orders: await require('./trading').myOrders(c, userId, null), trades: await require('./trading').myTrades(c, userId), limits: await c.one('SELECT * FROM responsible_gambling_profiles WHERE user_id=$1', [userId]) };
}

async function financeOverview(c, user) {
  if (!can(user, 'finance.view')) throw forbidden();
  const recon = await ledger.reconcile(c);
  const recent = await c.q(`SELECT t.id, t.reference, t.transaction_type, t.description, t.created_at, t.market_id, t.gross_minor, t.tax_minor, t.fee_minor, t.net_minor,
        (SELECT COUNT(*)::int FROM ledger_entries e WHERE e.transaction_id=t.id) AS lines,
        (SELECT SUM(amount_minor)::bigint FROM ledger_entries e WHERE e.transaction_id=t.id AND e.direction='DEBIT') AS amount_minor
      FROM ledger_transactions t ORDER BY t.id DESC LIMIT 60`);
  const withdrawals = await c.q(`SELECT w.*, u.username FROM withdrawal_requests w JOIN users u ON u.id=w.user_id ORDER BY (w.status='PENDING') DESC, w.id DESC LIMIT 50`);
  return { reconciliation: recon, escrow: await require('./trading').escrowCheck(c), recent_transactions: recent, withdrawals, tax: await taxSummary(c, user) };
}

// Tax position: what has been withheld, what is still owed to KRA, and the monthly 15% GGR tax (due by the 20th of the next month).
// GGR here = platform revenue (fees + commissions) booked in the month; finance must confirm the statutory GGR definition for this product.
async function taxSummary(c, user) {
  if (!can(user, 'finance.view') && !can(user, 'finance.tax')) throw forbidden();
  const tax = require('./tax');
  const byType = await c.q(`SELECT period, tax_type, kra_remittance_status AS status, COUNT(*)::int events, SUM(amount_minor)::bigint amount_minor FROM tax_events GROUP BY 1,2,3 ORDER BY period DESC, tax_type`);
  const revenue = await c.q(`SELECT period, kind, SUM(amount_minor)::bigint amount_minor FROM revenue_events GROUP BY 1,2 ORDER BY period DESC, kind`);
  const bps = await getInt(c, 'ggr_tax_bps');
  const months = [...new Set(revenue.map((r) => r.period))];
  const ggr = months.map((p) => { const g = revenue.filter((r) => r.period === p).reduce((a, r) => a + r.amount_minor, 0); return { period: p, ggr_minor: g, ggr_tax_minor: tax.bps(Math.max(0, g), bps), due_date: tax.ggrDueDate(p) }; });
  const pending = await c.one("SELECT COALESCE(SUM(amount_minor),0)::bigint s, COUNT(*)::int n FROM tax_events WHERE kra_remittance_status='PENDING'");
  const remittances = await c.q('SELECT r.*, u.username FROM kra_remittances r JOIN users u ON u.id=r.remitted_by ORDER BY r.id DESC LIMIT 20');
  const recent = await c.q("SELECT id, tax_type, user_id, market_id, base_minor, rate_bps, amount_minor, period, kra_remittance_status, receipt_ref, created_at FROM tax_events ORDER BY id DESC LIMIT 50");
  return { by_type: byType, revenue, ggr, ggr_tax_bps: bps, pending_remittance_minor: pending.s, pending_events: pending.n, remittances, recent_events: recent };
}

// Marks every pending tax event as paid to KRA under one receipt and moves the cash from "payable" to "remitted".
async function remitTax(c, user, { receipt_ref, period }) {
  if (!can(user, 'finance.tax')) throw forbidden();
  const ref = String(receipt_ref || '').trim();
  if (ref.length < 4) throw bad('RECEIPT_REQUIRED', 'Enter the KRA payment receipt reference');
  if (await c.one('SELECT 1 AS x FROM kra_remittances WHERE receipt_ref=$1', [ref])) throw conflict('RECEIPT_USED', 'That receipt reference has already been recorded');
  const events = await c.q("SELECT id, amount_minor FROM tax_events WHERE kra_remittance_status='PENDING' AND ($1::text IS NULL OR period=$1) ORDER BY id FOR UPDATE", [period || null]);
  const total = events.reduce((a, e) => a + e.amount_minor, 0);
  if (!events.length || total <= 0) throw bad('NOTHING_TO_REMIT', 'There is no unremitted tax for that selection');
  await ledger.post(c, { reference: `kra-remit:${ref}`, type: 'KRA_REMITTANCE', description: `KRA remittance ${ref}`, createdBy: user.id,
    lines: [{ account: await ledger.systemAccount(c, 'SYS_KRA_TAX_PAYABLE'), direction: 'DEBIT', amount: total }, { account: await ledger.systemAccount(c, 'SYS_KRA_REMITTED'), direction: 'CREDIT', amount: total }] });
  await c.q("UPDATE tax_events SET kra_remittance_status='REMITTED', receipt_ref=$2, remitted_at=now(), remitted_by=$3 WHERE id = ANY($1::bigint[])", [events.map((e) => e.id), ref, user.id]);
  await c.q('INSERT INTO kra_remittances(receipt_ref, period, amount_minor, events, remitted_by) VALUES ($1,$2,$3,$4,$5)', [ref, period || null, total, events.length, user.id]);
  await audit(c, user.id, 'tax.remit', 'kra', null, { receipt_ref: ref, amount_minor: total, events: events.length, period: period || null });
  return { receipt_ref: ref, amount_minor: total, events: events.length };
}

async function runReconciliation(c, user) {
  if (!can(user, 'finance.view')) throw forbidden();
  const r = await ledger.reconcile(c);
  await c.q('INSERT INTO financial_reconciliations(run_by, variance_minor, status, report) VALUES ($1,$2,$3,$4::jsonb)', [user.id, r.net_of_all_accounts_minor, r.ok ? 'BALANCED' : 'VARIANCE', JSON.stringify(r)]);
  await audit(c, user.id, 'finance.reconcile', 'ledger', null, { ok: r.ok });
  return r;
}

async function settlementQueue(c, user) {
  if (!can(user, 'settlement.propose') && !can(user, 'settlement.approve') && !can(user, 'disputes.resolve')) throw forbidden();
  const awaiting = await c.q(`
    SELECT m.id, m.title, m.status, m.closes_at, m.event_at, m.yes_price_kes::float8 AS yes_price_kes,
           COALESCE((SELECT locked_minor FROM escrow_pools e WHERE e.market_id=m.id),0)::bigint AS open_interest_minor,
           (SELECT COUNT(*)::int FROM positions p WHERE p.market_id=m.id AND (p.yes_shares>0 OR p.no_shares>0)) AS holders,
           (SELECT id FROM settlements s WHERE s.market_id=m.id AND s.status='PROPOSED') AS proposal_id
      FROM markets m WHERE m.status IN ('LOCKED','EVENT_PENDING','RESULT_PENDING') ORDER BY m.event_at`);
  for (const m of awaiting) {
    m.outcomes = await c.q('SELECT id, outcome_name FROM market_outcomes WHERE market_id=$1 ORDER BY id', [m.id]);
    m.rules = await c.one('SELECT resolution_source, resolution_method FROM market_rules WHERE market_id=$1', [m.id]);
    if (m.proposal_id) {
      m.proposal = await c.one('SELECT s.*, u.display_name AS proposer FROM settlements s JOIN users u ON u.id=s.proposed_by WHERE s.id=$1', [m.proposal_id]);
      m.evidence = await c.q('SELECT source_url, note, evidence_hash, captured_at FROM settlement_evidence WHERE settlement_id=$1', [m.proposal_id]);
    }
  }
  const disputes = await c.q(`SELECT d.*, m.title, u.username FROM disputes d JOIN markets m ON m.id=d.market_id JOIN users u ON u.id=d.user_id WHERE d.status='OPEN' ORDER BY d.id`);
  for (const d of disputes) {
    d.outcomes = await c.q('SELECT id, outcome_name FROM market_outcomes WHERE market_id=$1 ORDER BY id', [d.market_id]);
    d.settlement = await c.one("SELECT id, outcome_id, proposed_by, approved_by, summary FROM settlements WHERE market_id=$1 AND status='EXECUTED'", [d.market_id]);
  }
  const recent = await c.q(`SELECT s.id, s.market_id, s.status, s.executed_at, s.summary, m.title FROM settlements s JOIN markets m ON m.id=s.market_id WHERE s.status IN ('EXECUTED','REVERSED','REJECTED') ORDER BY s.id DESC LIMIT 15`);
  return { awaiting, disputes, recent, dual_approval_threshold_minor: await getInt(c, 'dual_approval_threshold_minor') };
}

async function reviewQueue(c, user) {
  if (!can(user, 'market.review')) throw forbidden();
  const rows = await c.q(`SELECT m.id, m.title, m.description, m.created_at, m.closes_at, m.event_at, m.initial_price_kes, u.username AS creator, c.name AS category,
      (SELECT summary FROM ai_analyses a WHERE a.market_id=m.id AND a.analysis_type='QUESTION_VALIDATION' ORDER BY id DESC LIMIT 1) AS ai
      FROM markets m JOIN users u ON u.id=m.creator_id JOIN categories c ON c.id=m.category_id WHERE m.status='PENDING_REVIEW' ORDER BY m.id`);
  for (const r of rows) r.rules = await c.one('SELECT resolution_source, resolution_method FROM market_rules WHERE market_id=$1', [r.id]);
  return rows;
}

async function listAllMarkets(c, user) {
  return c.q(`SELECT m.id, m.title, m.status, m.closes_at, m.event_at, u.username AS creator, m.yes_price_kes::float8 AS yes_price_kes, m.volume_minor, m.trade_count,
      COALESCE((SELECT locked_minor FROM escrow_pools e WHERE e.market_id=m.id),0)::bigint AS open_interest_minor,
      (SELECT COUNT(*)::int FROM positions p WHERE p.market_id=m.id AND (p.yes_shares>0 OR p.no_shares>0)) AS holders,
      (SELECT subsidy_minor FROM amm_pools a WHERE a.market_id=m.id) AS amm_subsidy_minor
      FROM markets m JOIN users u ON u.id=m.creator_id ORDER BY m.id DESC LIMIT 200`);
}

async function setCreator(c, actor, userId, on) {
  if (!can(actor, 'users.manage')) throw forbidden();
  const u = await c.one('SELECT id FROM users WHERE id=$1', [userId]); if (!u) throw notFound('User not found');
  await c.q('UPDATE users SET market_creator=$2 WHERE id=$1', [userId, !!on]);
  await audit(c, actor.id, 'user.market_creator', 'user', userId, { on: !!on });
}

async function auditLogs(c, user, { limit = 150 } = {}) {
  if (!can(user, 'audit.view')) throw forbidden();
  return c.q(`SELECT a.*, u.username AS actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT $1`, [Math.min(limit, 500)]);
}

async function listReports(c, user) {
  if (!can(user, 'market.review') && !can(user, 'market.suspend')) throw forbidden();
  return c.q(`SELECT r.*, m.title, u.username AS reporter FROM market_reports r JOIN markets m ON m.id=r.market_id JOIN users u ON u.id=r.reporter_id ORDER BY (r.status='OPEN') DESC, r.id DESC LIMIT 100`);
}
async function resolveReport(c, user, id, status) {
  if (!can(user, 'market.review') && !can(user, 'market.suspend')) throw forbidden();
  if (!['ACTIONED', 'DISMISSED'].includes(status)) throw bad('BAD_STATUS', 'Invalid status');
  await c.q('UPDATE market_reports SET status=$2 WHERE id=$1', [id, status]);
  await audit(c, user.id, 'report.resolve', 'report', id, { status });
}
async function report(c, user, marketId, reason) {
  if (!reason || reason.trim().length < 5) throw bad('REASON_REQUIRED', 'Tell us what is wrong with this market');
  const m = await c.one('SELECT id FROM markets WHERE id=$1', [marketId]);
  if (!m) throw notFound('Market not found');
  await c.q('INSERT INTO market_reports(market_id, reporter_id, reason) VALUES ($1,$2,$3)', [marketId, user.id, reason.trim()]);
}

async function staffList(c, user) {
  if (!can(user, 'roles.manage')) throw forbidden();
  return c.q(`SELECT u.id, u.username, u.display_name, (SELECT string_agg(r.name, ', ') FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.name<>'user') AS roles
              FROM users u WHERE EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=u.id AND r.name<>'user') ORDER BY u.id`);
}

module.exports = { taxSummary, remitTax, setCreator, dashboard, riskFlags, listUsers, setUserStatus, setKyc, userDetail, financeOverview, runReconciliation, settlementQueue, reviewQueue, listAllMarkets, auditLogs, listReports, resolveReport, report, staffList };
