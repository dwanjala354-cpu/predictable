'use strict';
const ledger = require('./ledger');
const markets = require('./markets');
const tax = require('./tax');
const { bad, forbidden, notFound, conflict, sha256 } = require('./util');
const { getInt, audit, notify } = require('./common');
const { can } = require('./auth');

const SHARE = 10000;                                   // minor units a winning contract pays (KES 100)

async function holdings(c, marketId) {
  return c.q('SELECT * FROM positions WHERE market_id=$1 AND (yes_shares>0 OR no_shares>0) ORDER BY user_id', [marketId]);
}
async function escrowLocked(c, marketId) {
  const e = await c.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [marketId]);
  return e ? e.locked_minor : 0;
}

// ───────────── Pure calculation (no database writes) ─────────────
// The plan is exactly what the ledger will post, used for the officer's preview AND for execution.
// Winning contracts pay KES 100 each. Tax and commission apply to gross profit (payout − cost basis); a loss is never taxed.
async function buildPlan(c, m, outcomeId) {
  const out = await c.one('SELECT outcome_code FROM market_outcomes WHERE id=$1 AND market_id=$2', [outcomeId, m.id]);
  if (!out) throw bad('BAD_OUTCOME', 'Choose the winning outcome of this market');
  const win = out.outcome_code === 'YES' ? 'yes' : 'no', lose = win === 'yes' ? 'no' : 'yes';
  const r = await tax.rates(c), locked = await escrowLocked(c, m.id);
  const pool = await c.one('SELECT * FROM amm_pools WHERE market_id=$1 AND returned_minor IS NULL', [m.id]);
  const payouts = [];
  let losers = 0, lostCost = 0;
  for (const p of await holdings(c, m.id)) {
    if (p[win + '_shares'] > 0) {
      const gross = p[win + '_shares'] * SHARE, sp = tax.profitSplit(gross, p[win + '_cost_minor'], r);
      payouts.push({ user_id: p.user_id, side: win.toUpperCase(), shares: p[win + '_shares'], gross_minor: gross, cost_basis_minor: p[win + '_cost_minor'], profit_minor: sp.profit, wht_minor: sp.tax, commission_minor: sp.fee, net_minor: sp.net });
    }
    if (p[lose + '_shares'] > 0) { losers++; lostCost += p[lose + '_cost_minor']; payouts.push({ user_id: p.user_id, side: lose.toUpperCase(), shares: p[lose + '_shares'], gross_minor: 0, cost_basis_minor: p[lose + '_cost_minor'], profit_minor: 0, wht_minor: 0, commission_minor: 0, net_minor: 0 }); }
  }
  const sum = (k) => payouts.reduce((a, x) => a + x[k], 0);
  const ammReturn = pool ? pool['r_' + win] + pool['held_' + win] : 0;
  const plan = { mode: 'PAYOUT', outcome_id: outcomeId, winning_side: win.toUpperCase(), collateral_minor: locked,
    winners: payouts.filter((x) => x.gross_minor > 0).length, losing_positions: losers, losing_cost_basis_minor: lostCost,
    total_gross_minor: sum('gross_minor'), total_wht_minor: sum('wht_minor'), total_commission_minor: sum('commission_minor'), total_net_minor: sum('net_minor'),
    amm_return_minor: ammReturn, amm_subsidy_minor: pool ? pool.subsidy_minor : 0, amm_result_minor: pool ? ammReturn - pool.subsidy_minor : 0, payouts, warnings: [] };
  if (plan.total_gross_minor + ammReturn !== locked) throw conflict('ESCROW_MISMATCH', `Escrow (${locked}) does not equal the winning contracts (${plan.total_gross_minor + ammReturn}). Do not settle — run the escrow check.`);
  return plan;
}

// Void: every contract is redeemed at the last traded price (YES at p, NO at 100−p), so holders keep what the market said it was worth.
async function buildVoidPlan(c, m) {
  const p = m.last_trade_kes != null ? m.last_trade_kes : m.initial_price_kes;
  const locked = await escrowLocked(c, m.id);
  const pool = await c.one('SELECT * FROM amm_pools WHERE market_id=$1 AND returned_minor IS NULL', [m.id]);
  const payouts = [];
  for (const q of await holdings(c, m.id)) {
    for (const [side, px] of [['yes', p * 100], ['no', (100 - p) * 100]]) {
      const sh = q[side + '_shares']; if (!sh) continue;
      const gross = sh * px;
      payouts.push({ user_id: q.user_id, side: side.toUpperCase(), shares: sh, gross_minor: gross, cost_basis_minor: q[side + '_cost_minor'], profit_minor: 0, wht_minor: 0, commission_minor: 0, net_minor: gross });
    }
  }
  const users = payouts.reduce((a, x) => a + x.gross_minor, 0);
  const ammReturn = locked - users;                       // the pool takes the remainder (includes sub-cent rounding)
  if (ammReturn < 0 || (!pool && ammReturn !== 0)) throw conflict('ESCROW_MISMATCH', 'Escrow does not match outstanding contracts — run the escrow check before voiding');
  return { mode: 'REFUND', void: true, void_price_kes: p, collateral_minor: locked, total_gross_minor: users, total_net_minor: users, total_wht_minor: 0, total_commission_minor: 0,
    amm_return_minor: ammReturn, amm_subsidy_minor: pool ? pool.subsidy_minor : 0, amm_result_minor: pool ? ammReturn - pool.subsidy_minor : 0, payouts, warnings: [] };
}

// Posts a plan to the ledger and updates positions, payouts, tax records and notifications. Shared by settlement and void.
async function postPlan(c, m, s, plan, actorId, label) {
  const trading = require('./trading');
  await trading.cancelAllForMarket(c, m.id, 'Market closed out');
  const escrow = await ledger.systemAccount(c, 'SYS_ESCROW'), kra = await ledger.systemAccount(c, 'SYS_KRA_TAX_PAYABLE'), rev = await ledger.systemAccount(c, 'SYS_PLATFORM_REVENUE'), fund = await ledger.systemAccount(c, 'SYS_AMM_FUND');
  const net = new Map();
  for (const x of plan.payouts) net.set(x.user_id, (net.get(x.user_id) || 0) + x.net_minor);
  const lines = [];
  if (plan.collateral_minor > 0) lines.push({ account: escrow, direction: 'DEBIT', amount: plan.collateral_minor });
  for (const [uid, amt] of net) if (amt > 0) lines.push({ account: (await ledger.userAccounts(c, uid)).AVAILABLE, direction: 'CREDIT', amount: amt });
  if (plan.total_wht_minor) lines.push({ account: kra, direction: 'CREDIT', amount: plan.total_wht_minor });
  if (plan.total_commission_minor) lines.push({ account: rev, direction: 'CREDIT', amount: plan.total_commission_minor });
  if (plan.amm_return_minor) lines.push({ account: fund, direction: 'CREDIT', amount: plan.amm_return_minor });
  const ref = `settle:${s.id}`;
  let tx = null;
  if (lines.length) tx = await ledger.post(c, { reference: ref, type: label, description: `${label === 'SETTLEMENT' ? 'Settlement' : 'Void'} of market #${m.id}`, marketId: m.id, createdBy: actorId,
    split: { gross: plan.total_gross_minor, tax: plan.total_wht_minor, fee: plan.total_commission_minor, net: plan.total_net_minor }, lines });
  await c.q('UPDATE escrow_pools SET locked_minor=0, updated_at=now() WHERE market_id=$1', [m.id]);
  await c.q('UPDATE amm_pools SET returned_minor=$2 WHERE market_id=$1 AND returned_minor IS NULL', [m.id, plan.amm_return_minor]);
  const rates = await tax.rates(c);
  for (const x of plan.payouts) {
    await c.q(`INSERT INTO payouts(settlement_id, market_id, user_id, side, shares, gross_minor, cost_basis_minor, profit_minor, wht_minor, commission_minor, net_minor)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [s.id, m.id, x.user_id, x.side, x.shares, x.gross_minor, x.cost_basis_minor, x.profit_minor, x.wht_minor, x.commission_minor, x.net_minor]);
    await c.q('UPDATE positions SET realized_pnl_minor = realized_pnl_minor + $3, updated_at=now() WHERE market_id=$1 AND user_id=$2', [m.id, x.user_id, x.net_minor - x.cost_basis_minor]);
    await tax.recordTax(c, { type: 'WINNINGS_WHT', userId: x.user_id, marketId: m.id, base: x.profit_minor, rate: rates.winningsWht, amount: x.wht_minor, ref });
    await tax.recordRevenue(c, { kind: 'PROFIT_COMMISSION', userId: x.user_id, marketId: m.id, amount: x.commission_minor, ref });
  }
  const per = new Map();
  for (const x of plan.payouts) { const e = per.get(x.user_id) || { net: 0, gross: 0, wht: 0, comm: 0 }; e.net += x.net_minor; e.gross += x.gross_minor; e.wht += x.wht_minor; e.comm += x.commission_minor; per.set(x.user_id, e); }
  for (const [uid, e] of per) {
    if (plan.void) await notify(c, uid, 'REFUND', 'Market voided — contracts redeemed', `"${m.title}": ${plan.void_price_kes ? `contracts redeemed at the last price (YES KES ${plan.void_price_kes}, NO KES ${100 - plan.void_price_kes})` : 'closed out'}. KES ${e.net / 100} credited.`);
    else if (e.gross > 0) await notify(c, uid, 'RESULT', 'You won!', `"${m.title}" — payout KES ${e.gross / 100}, less KES ${e.wht / 100} withholding tax and KES ${e.comm / 100} commission = KES ${e.net / 100} credited.`);
    else await notify(c, uid, 'RESULT', 'Market settled', `"${m.title}" has been settled. Your contracts expired worthless.`);
  }
  return tx;
}

// ───────────── Void / cancel — contracts redeemed at the last traded price ─────────────
async function voidAll(c, m, reason, actorId, settlementId = null) {
  let s = settlementId ? await c.one('SELECT * FROM settlements WHERE id=$1', [settlementId]) : null;
  const plan = await buildVoidPlan(c, m);
  if (!s) s = await c.one("INSERT INTO settlements(market_id, outcome_id, status, proposed_by, approved_by, summary, reason, executed_at) VALUES ($1,NULL,'EXECUTED',$2,$2,$3::jsonb,$4, now()) RETURNING *", [m.id, actorId, JSON.stringify({ ...plan, payouts: undefined }), reason]);
  await postPlan(c, m, s, plan, actorId, 'MARKET_VOID');
  await c.q("UPDATE markets SET status='VOID', suspended_from=NULL, updated_at=now() WHERE id=$1", [m.id]);
  await audit(c, actorId, 'market.void', 'market', m.id, { reason, void_price_kes: plan.void_price_kes, holders: new Set(plan.payouts.map((p) => p.user_id)).size });
  m.status = 'VOID';
  return plan;
}
const refundAll = voidAll;

async function voidMarket(c, user, marketId, reason) {
  if (!can(user, 'settlement.propose') && !can(user, 'market.suspend')) throw forbidden();
  const m = await markets.lockMarket(c, marketId);
  if (!['OPEN', 'LOCKED', 'EVENT_PENDING', 'RESULT_PENDING', 'SUSPENDED', 'APPROVED', 'PENDING_REVIEW'].includes(m.status)) throw conflict('BAD_STATE', `A ${m.status} market cannot be voided here`);
  if (!reason || reason.trim().length < 5) throw bad('REASON_REQUIRED', 'Give a reason for voiding the market');
  const r = await voidAll(c, m, reason.trim(), user.id);
  return { voided: true, void_price_kes: r.void_price_kes, total_redeemed_minor: r.total_net_minor };
}

// ───────────── Propose → (approve) → execute ─────────────
async function propose(c, user, marketId, { outcome_id, void: isVoid, evidence, reason }) {
  if (!can(user, 'settlement.propose')) throw forbidden();
  const m = await markets.lockMarket(c, marketId);
  if (!['LOCKED', 'EVENT_PENDING', 'RESULT_PENDING'].includes(m.status)) throw conflict('BAD_STATE', `Market is ${m.status}; trading must have closed before a result can be proposed`);
  const live = await c.one("SELECT id FROM settlements WHERE market_id=$1 AND status='PROPOSED'", [marketId]);
  if (live) throw conflict('ALREADY_PROPOSED', 'A settlement proposal is already awaiting approval');
  let outcomeId = null;
  if (!isVoid) {
    const o = await c.one('SELECT id FROM market_outcomes WHERE id=$1 AND market_id=$2', [outcome_id, marketId]);
    if (!o) throw bad('BAD_OUTCOME', 'Choose the winning outcome of this market');
    outcomeId = o.id;
    if (!Array.isArray(evidence) || !evidence.length || !evidence.every((e) => e.source_url && String(e.source_url).trim())) throw bad('EVIDENCE_REQUIRED', 'Attach at least one evidence source (URL) for the result');
  } else if (!reason || reason.trim().length < 5) throw bad('REASON_REQUIRED', 'Give a reason for voiding the market');

  const plan = isVoid ? await buildVoidPlan(c, m) : await buildPlan(c, m, outcomeId);
  const s = await c.one(
    `INSERT INTO settlements(market_id, outcome_id, status, proposed_by, summary, reason) VALUES ($1,$2,'PROPOSED',$3,$4::jsonb,$5) RETURNING *`,
    [marketId, outcomeId, user.id, JSON.stringify({ ...plan, payouts: undefined, payout_count: plan.payouts.length }), reason || null]);
  for (const e of evidence || []) {
    const captured = new Date().toISOString();
    await c.q('INSERT INTO settlement_evidence(settlement_id, source_url, note, evidence_hash, captured_at) VALUES ($1,$2,$3,$4,$5)',
      [s.id, String(e.source_url).trim(), e.note || null, sha256(`${e.source_url}|${e.note || ''}|${captured}`), captured]);
  }
  if (m.status !== 'RESULT_PENDING') await markets.setStatus(c, m, 'RESULT_PENDING', user.id, 'result proposed');
  await audit(c, user.id, 'settlement.propose', 'settlement', s.id, { market_id: marketId, outcome_id: outcomeId, void: !!isVoid });
  const threshold = await getInt(c, 'dual_approval_threshold_minor');
  return { settlement_id: s.id, plan, requires_second_approver: (plan.collateral_minor || 0) >= threshold };
}

async function approve(c, user, settlementId, decision, comments) {
  if (!can(user, 'settlement.approve')) throw forbidden();
  const s0 = await c.one('SELECT * FROM settlements WHERE id=$1', [settlementId]);
  if (!s0) throw notFound('Settlement not found');
  const m = await markets.lockMarket(c, s0.market_id);
  const s = await c.one('SELECT * FROM settlements WHERE id=$1 FOR UPDATE', [settlementId]);
  if (s.status !== 'PROPOSED') throw conflict('ALREADY_PROCESSED', `This settlement is already ${s.status}`);
  const plan = s.summary;
  const threshold = await getInt(c, 'dual_approval_threshold_minor');
  if ((plan.collateral_minor || 0) >= threshold && s.proposed_by === user.id) {
    throw forbidden(`Settlements moving KES ${threshold / 100} or more of collateral need a second, different officer to approve`, 'SECOND_APPROVER_REQUIRED');
  }
  if (s.origin === 'AI_ASSISTED' && s.proposed_by === user.id) throw forbidden('An AI-assisted result must be approved by a different officer than the one who ran the check', 'INDEPENDENT_APPROVER_REQUIRED');
  if (await c.one('SELECT 1 AS x FROM settlement_approvals WHERE settlement_id=$1 AND approver_id=$2', [s.id, user.id])) throw conflict('ALREADY_DECIDED', 'You have already recorded a decision on this settlement');
  await c.q('INSERT INTO settlement_approvals(settlement_id, approver_id, decision, comments) VALUES ($1,$2,$3,$4)', [s.id, user.id, decision === 'APPROVED' ? 'APPROVED' : 'REJECTED', comments || null]);
  if (decision !== 'APPROVED') {
    await c.q("UPDATE settlements SET status='REJECTED', approved_by=$2 WHERE id=$1", [s.id, user.id]);
    await audit(c, user.id, 'settlement.reject', 'settlement', s.id, { comments });
    return { status: 'REJECTED' };
  }
  const have = (await c.one("SELECT COUNT(*)::int n FROM settlement_approvals WHERE settlement_id=$1 AND decision='APPROVED'", [s.id])).n;
  if (have < (s.required_approvals || 1)) {
    await audit(c, user.id, 'settlement.approve_partial', 'settlement', s.id, { approvals: have, required: s.required_approvals });
    return { status: 'AWAITING_MORE_APPROVALS', approvals: have, required: s.required_approvals };
  }
  await execute(c, m, s, user.id);
  return { status: 'EXECUTED' };
}

// Executes the settlement. Re-derives the plan from live data so the numbers always reconcile.
async function execute(c, m, s, actorId) {
  if (!['RESULT_PENDING', 'DISPUTED'].includes(m.status)) throw conflict('BAD_STATE', `Market is ${m.status}`);
  const done = await c.one("SELECT id FROM settlements WHERE market_id=$1 AND status='EXECUTED'", [m.id]);
  if (done) throw conflict('ALREADY_SETTLED', 'This market has already been settled');
  if (s.outcome_id == null) {
    const r = await voidAll(c, m, s.reason || 'Market voided by settlement officer', actorId, s.id);
    await c.q("UPDATE settlements SET status='EXECUTED', approved_by=$2, executed_at=now() WHERE id=$1", [s.id, actorId]);
    return r;
  }
  const plan = await buildPlan(c, m, s.outcome_id);
  const tx = await postPlan(c, m, s, plan, actorId, 'SETTLEMENT');
  await c.q("UPDATE settlements SET status='EXECUTED', approved_by=$2, executed_at=now(), summary=$3::jsonb WHERE id=$1", [s.id, actorId, JSON.stringify({ ...plan, payouts: undefined, payout_count: plan.payouts.length })]);
  await c.q("UPDATE markets SET status='SETTLED', updated_at=now() WHERE id=$1", [m.id]);
  await audit(c, actorId, 'settlement.execute', 'settlement', s.id, { market_id: m.id, ledger_tx: tx && tx.id, gross_minor: plan.total_gross_minor, wht_minor: plan.total_wht_minor, commission_minor: plan.total_commission_minor });
  await require('./intel').onSettled(c, m, s);             // rating update; isolated by a savepoint so it can never affect the money above
  return { ...plan, payouts: undefined };
}

// ───────────── Preview for officers ─────────────
async function preview(c, user, marketId, outcomeId) {
  if (!can(user, 'settlement.propose')) throw forbidden();
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [marketId]);
  if (!m) throw notFound('Market not found');
  return buildPlan(c, m, outcomeId);
}

// ───────────── Disputes: original records are kept; corrections are new, reversing transactions ─────────────
async function fileDispute(c, user, marketId, { reason, evidence }) {
  const m = await markets.lockMarket(c, marketId);
  const s = await c.one("SELECT * FROM settlements WHERE market_id=$1 AND status='EXECUTED'", [marketId]);
  if (!s || !['SETTLED', 'DISPUTED'].includes(m.status)) throw conflict('NOT_DISPUTABLE', 'Only settled markets can be disputed');
  const deadline = new Date(new Date(s.executed_at).getTime() + m.dispute_window_hours * 3600 * 1000);
  if (new Date() > deadline) throw conflict('WINDOW_CLOSED', 'The dispute window for this market has closed');
  const part = await c.one('SELECT 1 AS x FROM positions WHERE market_id=$1 AND user_id=$2 AND (yes_shares>0 OR no_shares>0)', [marketId, user.id]);
  if (!part) throw forbidden('Only contract holders can dispute a settlement', 'NOT_PARTICIPANT');
  if (!reason || reason.trim().length < 10) throw bad('REASON_REQUIRED', 'Explain the issue (at least 10 characters)');
  const open = await c.one("SELECT 1 FROM disputes WHERE market_id=$1 AND user_id=$2 AND status='OPEN'", [marketId, user.id]);
  if (open) throw conflict('ALREADY_OPEN', 'You already have an open dispute on this market');
  const d = await c.one('INSERT INTO disputes(market_id, user_id, reason, evidence) VALUES ($1,$2,$3,$4) RETURNING id', [marketId, user.id, reason.trim(), evidence || null]);
  if (m.status === 'SETTLED') await markets.setStatus(c, m, 'DISPUTED', user.id, 'dispute filed');
  await audit(c, user.id, 'dispute.file', 'dispute', d.id, { market_id: marketId });
  return d;
}

// decision: 'REJECT' (original stands) | 'CORRECT' (new outcome) | 'VOID' (refund everyone)
async function resolveDispute(c, user, disputeId, { decision, corrected_outcome_id, resolution }) {
  if (!can(user, 'disputes.resolve')) throw forbidden();
  const d = await c.one('SELECT * FROM disputes WHERE id=$1 FOR UPDATE', [disputeId]);
  if (!d) throw notFound('Dispute not found');
  if (d.status !== 'OPEN') throw conflict('ALREADY_PROCESSED', 'Dispute already resolved');
  if (!resolution || resolution.trim().length < 5) throw bad('RESOLUTION_REQUIRED', 'Write a short explanation for the participants');
  const m = await markets.lockMarket(c, d.market_id);
  const s = await c.one("SELECT * FROM settlements WHERE market_id=$1 AND status='EXECUTED'", [m.id]);
  // Independent reviewer: whoever proposed or approved the settlement cannot review the dispute against it.
  if (s.proposed_by === user.id || s.approved_by === user.id) throw forbidden('A dispute must be reviewed by someone who was not involved in the settlement', 'NOT_INDEPENDENT');

  let status;
  if (decision === 'REJECT') status = 'REJECTED';
  else if (decision === 'CORRECT' || decision === 'VOID') {
    const original = await c.one('SELECT id FROM ledger_transactions WHERE reference=$1', [`settle:${s.id}`]);
    if (original) await ledger.reverse(c, original.id, { reference: `reverse-settle:${s.id}`, description: `Correction after dispute #${d.id}`, createdBy: user.id });
    // Restore the pre-settlement state; the old settlement stays as REVERSED history and every tax/revenue record gets a credit note.
    await c.q("UPDATE settlements SET status='REVERSED' WHERE id=$1", [s.id]);
    for (const x of await c.q("SELECT * FROM payouts WHERE settlement_id=$1 AND status='PAID'", [s.id])) {
      await c.q('UPDATE positions SET realized_pnl_minor = realized_pnl_minor - $3 WHERE market_id=$1 AND user_id=$2', [m.id, x.user_id, x.net_minor - x.cost_basis_minor]);
    }
    await c.q("UPDATE payouts SET status='REVERSED' WHERE settlement_id=$1", [s.id]);
    for (const t of await c.q('SELECT * FROM tax_events WHERE ledger_reference=$1 AND amount_minor > 0', [`settle:${s.id}`])) await tax.recordTax(c, { type: t.tax_type, userId: t.user_id, marketId: m.id, base: -t.base_minor, rate: t.rate_bps, amount: -t.amount_minor, ref: `reverse-settle:${s.id}` });
    for (const t of await c.q('SELECT * FROM revenue_events WHERE ledger_reference=$1 AND amount_minor > 0', [`settle:${s.id}`])) await tax.recordRevenue(c, { kind: t.kind, userId: t.user_id, marketId: m.id, amount: -t.amount_minor, ref: `reverse-settle:${s.id}` });
    const wasVoid = s.outcome_id == null;
    await c.q('UPDATE escrow_pools SET locked_minor=$2 WHERE market_id=$1', [m.id, (s.summary && s.summary.collateral_minor) || 0]);
    await c.q('UPDATE amm_pools SET returned_minor=NULL WHERE market_id=$1', [m.id]);
    if (wasVoid) await c.q("UPDATE markets SET status='RESULT_PENDING' WHERE id=$1", [m.id]);
    if (decision === 'VOID') {
      await voidAll(c, m, `Dispute #${d.id} upheld — market voided`, user.id);
      status = 'VOIDED';
    } else {
      const o = await c.one('SELECT id FROM market_outcomes WHERE id=$1 AND market_id=$2', [corrected_outcome_id, m.id]);
      if (!o) throw bad('BAD_OUTCOME', 'Choose the corrected winning outcome');
      m.status = 'RESULT_PENDING';
      await c.q("UPDATE markets SET status='RESULT_PENDING' WHERE id=$1", [m.id]);
      const ns = await c.one("INSERT INTO settlements(market_id, outcome_id, status, proposed_by, summary, reason) VALUES ($1,$2,'PROPOSED',$3,$4::jsonb,$5) RETURNING *",
        [m.id, o.id, user.id, JSON.stringify({ from_dispute: d.id }), `Correction after dispute #${d.id}`]);
      await execute(c, m, ns, user.id);
      status = 'CORRECTED';
    }
  } else throw bad('BAD_DECISION', 'Decision must be REJECT, CORRECT or VOID');

  await c.q('UPDATE disputes SET status=$2 WHERE id=$1', [d.id, status]);
  await c.q('INSERT INTO dispute_resolutions(dispute_id, resolution, reviewer_id) VALUES ($1,$2,$3)', [d.id, resolution.trim(), user.id]);
  const stillOpen = await c.one("SELECT 1 FROM disputes WHERE market_id=$1 AND status='OPEN'", [m.id]);
  const fresh = await c.one('SELECT * FROM markets WHERE id=$1', [m.id]);
  if (!stillOpen && fresh.status === 'DISPUTED') await markets.setStatus(c, fresh, 'SETTLED', user.id, 'dispute resolved');
  await notify(c, d.user_id, 'DISPUTE', 'Your dispute was reviewed', `Decision: ${status}. ${resolution.trim()}`);
  await audit(c, user.id, 'dispute.resolve', 'dispute', d.id, { decision, status });
  return { status };
}

module.exports = { buildPlan, buildVoidPlan, voidAll, refundAll, voidMarket, propose, approve, execute, preview, fileDispute, resolveDispute };
