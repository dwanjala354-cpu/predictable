'use strict';
const { bad, forbidden, notFound, conflict } = require('./util');
const ledger = require('./ledger');
const amm = require('./amm');
const { getInt, audit, notify } = require('./common');
const { can } = require('./auth');
const ai = require('./ai');

const MIN_LEAD_MS = 60 * 1000;

// Market lifecycle (spec §8). SUSPENDED is a pause that restores the previous state.
const TRANSITIONS = {
  DRAFT: ['PENDING_REVIEW', 'CANCELLED'],
  PENDING_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['OPEN', 'CANCELLED'],
  OPEN: ['LOCKED', 'SUSPENDED', 'VOID'],
  LOCKED: ['EVENT_PENDING', 'RESULT_PENDING', 'SUSPENDED', 'VOID'],
  EVENT_PENDING: ['RESULT_PENDING', 'SUSPENDED', 'VOID'],
  RESULT_PENDING: ['SETTLED', 'VOID', 'SUSPENDED'],
  SETTLED: ['DISPUTED'],
  DISPUTED: ['SETTLED', 'VOID'],
  SUSPENDED: ['OPEN', 'LOCKED', 'EVENT_PENDING', 'RESULT_PENDING'],
  REJECTED: [], CANCELLED: [], VOID: [],
};

async function lockMarket(c, id) {
  const m = await c.one('SELECT * FROM markets WHERE id=$1 FOR UPDATE', [id]);
  if (!m) throw notFound('Market not found');
  return m;
}

async function setStatus(c, m, to, actorId, note) {
  const ok = TRANSITIONS[m.status] && TRANSITIONS[m.status].includes(to);
  if (!ok) throw conflict('BAD_TRANSITION', `Market cannot move from ${m.status} to ${to}`);
  if (m.status === 'SUSPENDED' && to !== m.suspended_from) throw conflict('BAD_TRANSITION', `Market must resume to ${m.suspended_from}`);
  await c.q('UPDATE markets SET status=$2, suspended_from=$3, updated_at=now() WHERE id=$1', [m.id, to, to === 'SUSPENDED' ? m.status : null]);
  await audit(c, actorId, 'market.status', 'market', m.id, { from: m.status, to, note: note || null });
  m.status = to;
  return m;
}

const snapshot = async (c, id) => {
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [id]);
  const outcomes = await c.q('SELECT id, outcome_name, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [id]);
  const rules = await c.one('SELECT * FROM market_rules WHERE market_id=$1', [id]);
  return { market: m, outcomes, rules };
};
async function recordVersion(c, id, userId) {
  const m = await c.one('SELECT version FROM markets WHERE id=$1', [id]);
  await c.q('INSERT INTO market_versions(market_id, version_number, snapshot, changed_by) VALUES ($1,$2,$3::jsonb,$4)', [id, m.version, JSON.stringify(await snapshot(c, id)), userId]);
}

async function categoryId(c, input) {
  const cat = input.category_id
    ? await c.one('SELECT id FROM categories WHERE id=$1', [input.category_id])
    : await c.one('SELECT id FROM categories WHERE slug=$1', [input.category_slug || '']);
  if (!cat) throw bad('BAD_CATEGORY', 'Choose a valid category');
  return cat.id;
}

function parseDates(input) {
  const closes = new Date(input.closes_at), event = new Date(input.event_at);
  if (isNaN(closes) || isNaN(event)) throw bad('BAD_DATES', 'Enter valid closing and event date/times');
  if (closes.getTime() < Date.now() + MIN_LEAD_MS) throw bad('BAD_DATES', 'Trading must close at least a minute from now');
  if (event < closes) throw bad('BAD_DATES', 'The event cannot start before trading closes');
  return { closes: closes.toISOString(), event: event.toISOString() };
}

const DEFAULT_RULES = {
  cancellation_rules: 'If the event is cancelled or abandoned, the market is voided and every contract is redeemed at the last traded price. No commission or withholding tax is charged on voided markets.',
  postponement_rules: 'If the event is postponed beyond 7 days of the scheduled date, the market is voided and every contract is redeemed at the last traded price.',
};

async function insertRules(c, id, input, payoutDefault) {
  await c.q(
    `INSERT INTO market_rules(market_id, resolution_source, resolution_method, cancellation_rules, postponement_rules, payout_rules)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.resolution_source.trim(), input.resolution_method.trim(),
      (input.cancellation_rules || DEFAULT_RULES.cancellation_rules).trim(),
      (input.postponement_rules || DEFAULT_RULES.postponement_rules).trim(),
      (input.payout_rules || payoutDefault).trim()]);
}

// ───────────── Market creation (staff and approved users; every market is reviewed before it opens) ─────────────
async function createMarket(c, user, input) {
  if (!can(user, 'market.create')) throw forbidden();
  const staff = isStaff(user);
  const row = await c.one('SELECT market_creator FROM users WHERE id=$1', [user.id]);
  if (!staff && !(row && row.market_creator)) throw forbidden('Only approved market creators can propose markets. Ask support to apply.', 'NOT_APPROVED_CREATOR');
  if (!staff && user.kyc_status !== 'VERIFIED') throw forbidden('Complete identity and age verification before creating a market', 'KYC_REQUIRED');
  const v = ai.validateQuestion({ ...input, outcomes: ['Yes', 'No'] });
  const hardErrors = v.issues.filter((i) => i.severity === 'BLOCK' || i.severity === 'ERROR');
  if (hardErrors.length) throw bad('VALIDATION_FAILED', hardErrors.map((e) => e.message).join(' '), { issues: v.issues });
  const p0 = input.initial_price_kes === undefined || input.initial_price_kes === '' ? 50 : Number(input.initial_price_kes);
  if (!Number.isInteger(p0) || p0 < 1 || p0 > 99) throw bad('BAD_PRICE', 'Your opening estimate must be a whole number of shillings from 1 to 99 (the chance the answer is Yes, in percent)');
  const { closes, event } = parseDates(input);
  const cat = await categoryId(c, input);
  const m = await c.one(
    `INSERT INTO markets(creator_id, category_id, title, description, status, initial_price_kes, yes_price_kes, no_price_kes, opens_at, closes_at, event_at, dispute_window_hours)
     VALUES ($1,$2,$3,$4,$5,$6::smallint,$6::numeric,100-$6::numeric,$7,$8,$9,$10) RETURNING *`,
    [user.id, cat, input.title.trim(), (input.description || '').trim(), input.submit === false ? 'DRAFT' : 'PENDING_REVIEW', p0,
      input.opens_at ? new Date(input.opens_at).toISOString() : null, closes, event, await getInt(c, 'default_dispute_window_hours')]);
  await c.q("INSERT INTO market_outcomes(market_id, outcome_name, outcome_code) VALUES ($1,'Yes','YES'), ($1,'No','NO')", [m.id]);
  await insertRules(c, m.id, input, 'Each contract pays KES 100 if its side is right and KES 0 if not. Winning profit is subject to withholding tax and the platform commission shown on the market page.');
  await recordVersion(c, m.id, user.id);
  await c.q("INSERT INTO ai_analyses(market_id, analysis_type, model_version, summary) VALUES ($1,'QUESTION_VALIDATION',$2,$3::jsonb)", [m.id, ai.MODEL_VERSION, JSON.stringify(v)]);
  await audit(c, user.id, 'market.create', 'market', m.id, {});
  return { id: m.id, status: m.status, warnings: v.issues };
}

// Platform-funded liquidity. Bounded: the platform can lose at most what it puts in. Staff only, per-market and global caps.
async function seedAmm(c, m, actorId, subsidy) {
  const max = await getInt(c, 'amm_max_subsidy_minor'), cap = await getInt(c, 'amm_max_total_exposure_minor');
  if (!Number.isSafeInteger(subsidy) || subsidy < 100000 || subsidy > max) throw bad('BAD_SUBSIDY', `Market-maker funding must be between KES 1,000 and KES ${max / 100}`);
  const live = (await c.one('SELECT COALESCE(SUM(subsidy_minor),0)::bigint s FROM amm_pools WHERE returned_minor IS NULL')).s;
  if (live + subsidy > cap) throw conflict('AMM_EXPOSURE_CAP', `Total market-maker exposure would exceed the platform cap of KES ${cap / 100}`);
  if (await c.one('SELECT 1 AS x FROM amm_pools WHERE market_id=$1', [m.id])) throw conflict('AMM_EXISTS', 'This market already has a market maker');
  const seed = amm.seed(subsidy, m.initial_price_kes);
  await ledger.post(c, { reference: `amm-seed:${m.id}`, type: 'AMM_FUNDING', description: `Market-maker funding for market #${m.id}`, marketId: m.id, createdBy: actorId,
    lines: [{ account: await ledger.systemAccount(c, 'SYS_AMM_FUND'), direction: 'DEBIT', amount: subsidy }, { account: await ledger.systemAccount(c, 'SYS_ESCROW'), direction: 'CREDIT', amount: subsidy }] });
  await c.q('INSERT INTO escrow_pools(market_id, locked_minor) VALUES ($1,$2) ON CONFLICT (market_id) DO UPDATE SET locked_minor = escrow_pools.locked_minor + $2', [m.id, subsidy]);
  await c.q('INSERT INTO amm_pools(market_id, subsidy_minor, r_yes, r_no, held_yes, held_no) VALUES ($1,$2,$3,$4,$5,$6)', [m.id, subsidy, seed.r_yes, seed.r_no, seed.held_yes, seed.held_no]);
  await audit(c, actorId, 'amm.seed', 'market', m.id, { subsidy_minor: subsidy, price: m.initial_price_kes });
}

// Creator edits are allowed only before the first participant commits funds, and every edit is versioned.
async function editMarket(c, user, id, patch) {
  const m = await lockMarket(c, id);
  if (m.creator_id !== user.id && !can(user, 'market.review')) throw forbidden();
  if (!['DRAFT', 'PENDING_REVIEW', 'OPEN', 'APPROVED'].includes(m.status)) throw conflict('NOT_EDITABLE', `Market is ${m.status} and can no longer be edited`);
  const bets = await c.one('SELECT COUNT(*)::int n FROM trades WHERE market_id=$1', [id]);
  if (bets.n > 0) throw conflict('LOCKED_BY_FUNDS', 'Contracts are already held: the question, dates and resolution rules can no longer change');
  const sets = [], vals = [id];
  const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
  if (patch.title) add('title', String(patch.title).trim());
  if (patch.description != null) add('description', String(patch.description).trim());
  if (patch.closes_at || patch.event_at) {
    const d = parseDates({ closes_at: patch.closes_at || m.closes_at, event_at: patch.event_at || m.event_at });
    add('closes_at', d.closes); add('event_at', d.event);
  }
  if (!sets.length && !patch.rules) throw bad('NOTHING_TO_EDIT', 'Nothing to change');
  if (sets.length) await c.q(`UPDATE markets SET ${sets.join(',')}, version=version+1, updated_at=now() WHERE id=$1`, vals);
  else await c.q('UPDATE markets SET version=version+1, updated_at=now() WHERE id=$1', [id]);
  if (patch.rules) {
    for (const k of ['resolution_source', 'resolution_method', 'cancellation_rules', 'postponement_rules', 'payout_rules']) {
      if (patch.rules[k]) await c.q(`UPDATE market_rules SET ${k}=$2 WHERE market_id=$1`, [id, String(patch.rules[k]).trim()]);
    }
  }
  await recordVersion(c, id, user.id);
  await audit(c, user.id, 'market.edit', 'market', id, { fields: Object.keys(patch) });
  return { ok: true };
}

async function submitForReview(c, user, id) {
  const m = await lockMarket(c, id);
  if (m.creator_id !== user.id) throw forbidden();
  await setStatus(c, m, 'PENDING_REVIEW', user.id);
}

// ───────────── Review & publish (four-eyes: creator never approves their own market) ─────────────
async function review(c, user, id, decision, comments, opts = {}) {
  const m = await lockMarket(c, id);
  if (!can(user, 'market.review')) throw forbidden();
  if (m.creator_id === user.id) throw forbidden('You cannot approve a market you created', 'SELF_APPROVAL');
  if (m.status !== 'PENDING_REVIEW') throw conflict('BAD_STATE', `Market is ${m.status}, not pending review`);
  if (!['APPROVED', 'REJECTED', 'RETURNED'].includes(decision)) throw bad('BAD_DECISION', 'Decision must be APPROVED, REJECTED or RETURNED');
  await c.q('INSERT INTO market_reviews(market_id, reviewer_id, decision, comments) VALUES ($1,$2,$3,$4)', [id, user.id, decision, comments || null]);
  if (decision === 'APPROVED') {
    if (opts.amm_subsidy_minor) { if (!can(user, 'market.house.manage')) throw forbidden('Only administrators can fund a market maker', 'AMM_NOT_ALLOWED'); await seedAmm(c, m, user.id, opts.amm_subsidy_minor); }
    await setStatus(c, m, 'APPROVED', user.id, comments);
    if (!m.opens_at || new Date(m.opens_at) <= new Date()) await setStatus(c, m, 'OPEN', user.id, 'published');
    await notify(c, m.creator_id, 'MARKET', 'Market approved', `"${m.title}" ${m.status === 'OPEN' ? 'is now live.' : 'is approved and will open at its scheduled time.'}`);
  } else if (decision === 'REJECTED') {
    await setStatus(c, m, 'REJECTED', user.id, comments);
    await notify(c, m.creator_id, 'MARKET', 'Market rejected', `"${m.title}" was rejected${comments ? ': ' + comments : '.'}`);
  } else {
    await setStatus(c, m, 'DRAFT', user.id, comments);
    await notify(c, m.creator_id, 'MARKET', 'Market returned for changes', `"${m.title}": ${comments || 'please revise and resubmit.'}`);
  }
  return { status: m.status };
}

// ───────────── Operational controls ─────────────
async function suspend(c, user, id, reason) {
  if (!can(user, 'market.suspend')) throw forbidden();
  const m = await lockMarket(c, id);
  await setStatus(c, m, 'SUSPENDED', user.id, reason);
}
async function resume(c, user, id) {
  if (!can(user, 'market.suspend')) throw forbidden();
  const m = await lockMarket(c, id);
  if (m.status !== 'SUSPENDED') throw conflict('BAD_STATE', 'Market is not suspended');
  await setStatus(c, m, m.suspended_from, user.id, 'resumed');
}
// Close trading immediately (operational need).
async function closeNow(c, user, id) {
  if (!can(user, 'market.suspend')) throw forbidden();
  const m = await lockMarket(c, id);
  if (m.status !== 'OPEN') throw conflict('BAD_STATE', 'Only open markets can be closed');
  await c.q('UPDATE markets SET closes_at = LEAST(now(), closes_at), event_at = GREATEST(event_at, LEAST(now(), closes_at)) WHERE id=$1', [id]);
  await lockForTrading(c, id, user.id);
}
async function markEventEnded(c, user, id) {
  if (!can(user, 'settlement.propose') && !can(user, 'market.suspend')) throw forbidden();
  const m = await lockMarket(c, id);
  if (!['LOCKED', 'EVENT_PENDING'].includes(m.status)) throw conflict('BAD_STATE', 'Trading must be closed first');
  await setStatus(c, m, 'RESULT_PENDING', user.id, 'event ended');
}

// OPEN → LOCKED: trading stops and every resting order is cancelled so no cash or shares stay reserved.
async function lockForTrading(c, id, actorId = null) {
  const m = await lockMarket(c, id);
  if (m.status !== 'OPEN') return m;
  await setStatus(c, m, 'LOCKED', actorId, 'trading closed');
  await require('./trading').cancelAllForMarket(c, id, 'Trading closed');
  return m;
}

// Time-driven transitions. Called by the server ticker (and by tests).
async function tick(c) {
  const opened = await c.q("SELECT id FROM markets WHERE status='APPROVED' AND opens_at IS NOT NULL AND opens_at <= now()");
  for (const r of opened) { const m = await lockMarket(c, r.id); if (m.status === 'APPROVED') await setStatus(c, m, 'OPEN', null, 'scheduled open'); }
  const due = await c.q("SELECT id FROM markets WHERE status='OPEN' AND closes_at <= now()");
  for (const r of due) await lockForTrading(c, r.id, null);
  const started = await c.q("SELECT id FROM markets WHERE status='LOCKED' AND event_at <= now()");
  for (const r of started) { const m = await lockMarket(c, r.id); if (m.status === 'LOCKED') await setStatus(c, m, 'EVENT_PENDING', null, 'event started'); }
  return { opened: opened.length, locked: due.length, started: started.length };
}

// ───────────── Reading ─────────────
const isStaff = (u) => !!u && u.permissions.includes('admin.dashboard');

async function canSee(c, m, user) {
  return ['OPEN', 'LOCKED', 'EVENT_PENDING', 'RESULT_PENDING', 'SETTLED', 'VOID', 'DISPUTED', 'SUSPENDED'].includes(m.status) || (user && (m.creator_id === user.id || isStaff(user)));
}

const BASE_SELECT = `
  SELECT m.id, m.creator_id, m.category_id, m.title, m.description, m.status, m.initial_price_kes, m.yes_price_kes::float8 AS yes_price_kes, m.no_price_kes::float8 AS no_price_kes,
         m.last_trade_kes, m.volume_minor, m.trade_count, m.opens_at, m.closes_at, m.event_at, m.dispute_window_hours, m.version, m.created_at,
         u.display_name AS creator_name, u.username AS creator_username, c.name AS category_name, c.slug AS category_slug,
         COALESCE(e.locked_minor,0)::bigint AS open_interest_minor,
         (SELECT COUNT(*)::int FROM positions p WHERE p.market_id=m.id AND (p.yes_shares>0 OR p.no_shares>0)) AS holders
    FROM markets m JOIN users u ON u.id=m.creator_id JOIN categories c ON c.id=m.category_id LEFT JOIN escrow_pools e ON e.market_id=m.id`;

async function listMarkets(c, user, { category, status, q, mine, limit = 60 } = {}) {
  const where = [], vals = [];
  const ph = (v) => { vals.push(v); return '$' + vals.length; };
  if (category) where.push(`c.slug = ${ph(category)}`);
  if (status) where.push(`m.status = ${ph(status)}`);
  if (q) { const p = ph('%' + q + '%'); where.push(`(m.title ILIKE ${p} OR m.description ILIKE ${p})`); }
  if (mine && user) { const p = ph(user.id); where.push(`(m.creator_id = ${p} OR EXISTS (SELECT 1 FROM positions x WHERE x.market_id=m.id AND x.user_id=${p}) OR EXISTS (SELECT 1 FROM orders o WHERE o.market_id=m.id AND o.user_id=${p}))`); }
  const sql = `${BASE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (m.status='OPEN') DESC, m.volume_minor DESC, m.closes_at ASC LIMIT ${Math.min(parseInt(limit, 10) || 60, 200)}`;
  const rows = await c.q(sql, vals);
  const out = [];
  for (const m of rows) if (await canSee(c, m, user)) out.push(m);
  return out;
}

async function getMarket(c, user, id) {
  const m = await c.one(`${BASE_SELECT} WHERE m.id=$1`, [id]);
  if (!m) throw notFound('Market not found');
  if (!(await canSee(c, m, user))) throw notFound('Market not found');
  const trading = require('./trading'), tax = require('./tax');
  const rules = await c.one('SELECT * FROM market_rules WHERE market_id=$1', [id]);
  const out = { ...m, rules, outcomes: await c.q('SELECT id, outcome_name, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [id]) };
  out.book = await trading.orderBook(c, id, user);
  const r = await tax.rates(c);
  out.fees = { winnings_wht_bps: r.winningsWht, profit_commission_bps: r.profitCommission, tax_on_exit_sales: r.taxOnExit };
  if (user) {
    out.my_position = await trading.getPos(c, id, user.id, false);
    out.is_creator = m.creator_id === user.id;
  }
  out.settlement = await c.one("SELECT id, outcome_id, status, executed_at, summary, reason FROM settlements WHERE market_id=$1 AND status IN ('EXECUTED','PROPOSED') ORDER BY id DESC LIMIT 1", [id]);
  out.analysis = (await c.one("SELECT summary, model_version, generated_at FROM ai_analyses WHERE market_id=$1 AND analysis_type='QUESTION_VALIDATION' ORDER BY id DESC LIMIT 1", [id])) || null;
  out.research = await require('./intel').researchPanel(c, m);
  if (isStaff(user)) {
    out.reviews = await c.q('SELECT r.*, u.display_name AS reviewer FROM market_reviews r JOIN users u ON u.id=r.reviewer_id WHERE market_id=$1 ORDER BY r.id', [id]);
    out.versions = await c.q('SELECT version_number, changed_by, created_at FROM market_versions WHERE market_id=$1 ORDER BY version_number', [id]);
    out.amm = await c.one('SELECT * FROM amm_pools WHERE market_id=$1', [id]);
    out.escrow = await trading.escrowCheck(c, id);
  }
  return out;
}

module.exports = {
  TRANSITIONS, lockMarket, setStatus, createMarket, seedAmm, editMarket, submitForReview, review,
  suspend, resume, closeNow, markEventEnded, lockForTrading, tick, listMarkets, getMarket, canSee, isStaff,
};
