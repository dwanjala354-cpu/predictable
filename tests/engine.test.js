'use strict';
process.env.DATABASE_DIR = 'memory://';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const seed = require('../src/seed');
const auth = require('../src/auth');
const ledger = require('../src/ledger');
const wallet = require('../src/wallet');
const markets = require('../src/markets');
const trading = require('../src/trading');
const settlement = require('../src/settlement');
const amm = require('../src/amm');
const tax = require('../src/tax');
const admin = require('../src/admin');

const hrs = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const SH = 10000;                                    // one contract = KES 100 = 10,000 minor units
let n = 0;
const tx = (fn) => db.tx(fn);
const U = (id) => tx((c) => auth.publicUser(c, id));
const staff = async (name) => U((await db.one('SELECT id FROM users WHERE username=$1', [name])).id);
async function player(name, kes = 10000) {
  const uname = `pl_${name}${++n}`;
  return tx(async (c) => { const id = await seed.mkUser(c, uname, name, '1990-01-01'); if (kes) await seed.fund(c, id, kes); return auth.publicUser(c, id); });
}
const bal = (u) => tx((c) => ledger.balances(c, u.id));
const avail = async (u) => (await bal(u)).available_minor;
const sysBal = async (t) => (await db.one("SELECT balance_minor::bigint b FROM ledger_accounts WHERE wallet_id IS NULL AND account_type=$1", [t])).b;
const reconciled = async () => {
  const r = await tx((c) => ledger.reconcile(c)); assert.equal(r.ok, true, JSON.stringify(r));
  const e = await tx((c) => trading.escrowCheck(c)); assert.equal(e.ok, true, JSON.stringify(e));
};
// A market proposed by staff and approved by a different officer. subsidy = KES for a platform market maker (0 = order book only).
async function mkMarket({ price = 50, subsidyKes = 0, closes = 2, title = 'Will Kenya win its next international football match?' } = {}) {
  const maker = await staff('admin'), boss = await staff('superadmin');
  const r = await tx((c) => markets.createMarket(c, maker, { title, category_slug: 'sports', initial_price_kes: price, closes_at: hrs(closes), event_at: hrs(closes + 1),
    resolution_source: 'FIFA match centre (fifa.com)', resolution_method: 'Full-time result, extra time ignored.' }));
  await tx((c) => markets.review(c, boss, r.id, 'APPROVED', 'ok', subsidyKes ? { amm_subsidy_minor: subsidyKes * 100 } : {}));
  const outs = await db.q('SELECT id, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [r.id]);
  return { id: r.id, yes: outs.find((o) => o.outcome_code === 'YES').id, no: outs.find((o) => o.outcome_code === 'NO').id };
}
const order = (u, m, o) => tx((c) => trading.placeOrder(c, u, m.id, o));
const expire = async (id) => { await db.q("UPDATE markets SET closes_at = now() - interval '1 second' WHERE id=$1", [id]); await tx((c) => markets.tick(c)); };
async function settleIt(m, outcomeId) {
  const officer = await staff('settle1'), approver = await staff('settle2');
  const pr = await tx((c) => settlement.propose(c, officer, m.id, { outcome_id: outcomeId, evidence: [{ source_url: 'https://example.org/report', note: 'official' }] }));
  return tx((c) => settlement.approve(c, approver, pr.settlement_id, 'APPROVED', 'ok'));
}

test.before(async () => { await require('./_pgreset')(); await seed.run({ demo: false }); });
test.after(async () => { await reconciled(); await db.close(); });

// ───────────── pure maths ─────────────
test('tax waterfall: deposit, withdrawal and the spec’s worked winning example', async () => {
  const r = await tx((c) => tax.rates(c));
  assert.deepEqual(tax.depositSplit(100000, r), { gross: 100000, tax: 5000, fee: 5000, net: 90000 });        // KES 1,000 → 50 + 50 + 900
  assert.deepEqual(tax.withdrawalSplit(100000, r), { gross: 100000, tax: 5000, fee: 5000, net: 90000 });
  // 10 YES bought at KES 40 pays KES 1,000: profit 600, WHT 120, commission 60, net 820
  const s = tax.profitSplit(10 * SH, 10 * 40 * 100, r);
  assert.deepEqual(s, { gross: 100000, cost: 40000, profit: 60000, tax: 12000, fee: 6000, net: 82000 });
  assert.equal(tax.profitSplit(50000, 60000, r).tax, 0, 'a loss is never taxed');
  assert.equal(tax.profitSplit(50000, 50000, r).fee, 0, 'break-even is never charged');
});

test('AMM: prices sum to 100, round trips never profit, the invariant never shrinks', () => {
  const pool = { ...amm.seed(500000, 70), subsidy_minor: 500000 };
  assert.equal(pool.r_yes + pool.held_yes, 500000); assert.equal(pool.r_no + pool.held_no, 500000);
  assert.ok(Math.abs(amm.priceKes(pool, 'YES') - 70) < 0.01);
  assert.ok(Math.abs(amm.priceKes(pool, 'YES') + amm.priceKes(pool, 'NO') - 100) < 0.02);
  const k0 = BigInt(pool.r_yes) * BigInt(pool.r_no);
  for (const side of ['YES', 'NO']) for (const q of [1, 3, 17, 60]) {
    const b = amm.quoteBuy(pool, side, q);
    assert.ok(BigInt(b.after.r_yes) * BigInt(b.after.r_no) >= k0);
    const s = amm.quoteSell({ ...pool, ...b.after }, side, q);
    assert.ok(s.proceeds_minor <= b.cost_minor, `round trip must not profit (${side} ${q})`);
    assert.ok(b.cost_minor < q * 100 * 100 && b.cost_minor > 0, 'a share costs between KES 0 and KES 100');
  }
  assert.ok(amm.quoteBuy(pool, 'YES', 10).cost_minor > 10 * 70 * 100 - 1, 'buying moves the price up, so the average is above the opening 70');
});

// ───────────── deposits / withdrawals ─────────────
test('a KES 1,000 deposit credits KES 900 and books KES 50 excise + KES 50 fee in one balanced transaction', async () => {
  const before = { kra: await sysBal('SYS_KRA_TAX_PAYABLE'), rev: await sysBal('SYS_PLATFORM_REVENUE') };
  const u = await player('dep', 1000);
  assert.equal(await avail(u), 90000);
  assert.equal(await sysBal('SYS_KRA_TAX_PAYABLE') - before.kra, 5000);
  assert.equal(await sysBal('SYS_PLATFORM_REVENUE') - before.rev, 5000);
  const ev = await db.one("SELECT * FROM tax_events WHERE user_id=$1 AND tax_type='DEPOSIT_EXCISE'", [u.id]);
  assert.equal(ev.amount_minor, 5000); assert.equal(ev.kra_remittance_status, 'PENDING');
  const t = await db.one("SELECT * FROM ledger_transactions WHERE transaction_type='DEPOSIT' ORDER BY id DESC LIMIT 1");
  assert.deepEqual([t.gross_minor, t.tax_minor, t.fee_minor, t.net_minor], [100000, 5000, 5000, 90000]);
  await reconciled();
});

test('withdrawal: gross leaves the wallet at request, 90% is disbursed, 5% WHT + 5% fee are booked on completion', async () => {
  const u = await player('wd', 2000);                     // 1,800 available
  const w = await tx((c) => wallet.requestWithdrawal(c, u.id, 100000, '0712345678'));
  assert.deepEqual([w.tax_minor, w.fee_minor, w.net_minor], [5000, 5000, 90000]);
  assert.equal((await bal(u)).pending_withdrawal_minor, 100000);
  const fin = await staff('finance');
  const kra = await sysBal('SYS_KRA_TAX_PAYABLE'), clr = await sysBal('SYS_WITHDRAWAL_CLEARING');
  await tx((c) => wallet.completeWithdrawal(c, fin.id, w.id, true));
  assert.equal(await sysBal('SYS_KRA_TAX_PAYABLE') - kra, 5000);
  assert.equal(await sysBal('SYS_WITHDRAWAL_CLEARING') - clr, 90000);
  assert.equal((await bal(u)).pending_withdrawal_minor, 0);
  await reconciled();
});

// ───────────── order book ─────────────
test('mint: a YES bid and a NO bid that add to 100 create a pair and lock KES 100 of collateral', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  const r1 = await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  assert.equal(r1.filled, 0); assert.equal(r1.resting, true);
  assert.equal((await bal(a)).reserved_orders_minor, 10 * 40 * 100);
  const r2 = await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });
  assert.equal(r2.filled, 10); assert.equal(r2.fills[0].kind, 'MINT');
  assert.equal(await avail(a), 900000 - 40000); assert.equal(await avail(b), 900000 - 60000);
  assert.equal((await bal(a)).reserved_orders_minor, 0);
  const e = await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id]);
  assert.equal(e.locked_minor, 10 * SH);
  const pa = await db.one('SELECT * FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, a.id]);
  assert.deepEqual([pa.yes_shares, pa.yes_cost_minor], [10, 40000]);
  const mk = await db.one('SELECT yes_price_kes::float8 p, last_trade_kes FROM markets WHERE id=$1', [m.id]);
  assert.equal(mk.last_trade_kes, 40);
  await reconciled();
});

test('trades execute at the RESTING price and the taker keeps the price improvement', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  const before = await avail(b);
  const r = await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 75, qty: 10 });   // would pay up to 75, but the bid at 40 means NO costs 60
  assert.equal(r.avg_price_kes, 60);
  assert.equal(before - await avail(b), 10 * 60 * 100, 'only the real price is charged; the rest of the reserve comes back');
  assert.equal((await bal(b)).reserved_orders_minor, 0);
  await reconciled();
});

test('transfer: selling YES early to a buyer moves shares and cash; a profitable exit is taxed, a loss is not', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b'), c = await player('c');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });           // a holds 10 YES at 40
  await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 70, qty: 10 });          // a offers them at 70
  assert.equal((await db.one('SELECT yes_locked FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, a.id])).yes_locked, 10);
  const cash = await avail(a);
  const r = await order(c, m, { action: 'BUY', asset: 'YES', limit_kes: 80, qty: 10 });
  assert.equal(r.fills[0].kind, 'TRANSFER_YES'); assert.equal(r.avg_price_kes, 70);
  // proceeds 700; cost 400; profit 300 → WHT 60 + commission 30 → a receives 610
  assert.equal(await avail(a) - cash, 61000);
  const pa = await db.one('SELECT * FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, a.id]);
  assert.deepEqual([pa.yes_shares, pa.yes_locked, pa.yes_cost_minor, pa.realized_pnl_minor], [0, 0, 0, 21000]);
  const t = await db.one("SELECT * FROM tax_events WHERE user_id=$1 AND tax_type='EXIT_WHT'", [a.id]);
  assert.equal(t.amount_minor, 6000);
  // now c sells at a loss: no tax
  await order(c, m, { action: 'SELL', asset: 'YES', limit_kes: 60, qty: 10, tif: 'GTC' });
  const d = await player('d');
  const before = await avail(c);
  const r2 = await order(d, m, { action: 'BUY', asset: 'YES', limit_kes: 60, qty: 10 });
  assert.equal(r2.filled, 10);
  assert.equal(await avail(c) - before, 60000, 'a loss pays out in full, untaxed');
  await reconciled();
});

test('merge: two sellers on opposite sides redeem a pair from escrow and the collateral is released', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 30, qty: 20 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 70, qty: 20 });
  await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 35, qty: 20 });          // ask YES 35
  const r = await order(b, m, { action: 'SELL', asset: 'NO', limit_kes: 60, qty: 20 });  // bid YES 40 ≥ ask 35 → merge at the resting price 35
  assert.equal(r.fills[0].kind, 'MERGE');
  assert.equal((await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id])).locked_minor, 0);
  const pb = await db.one('SELECT * FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, b.id]);
  assert.equal(pb.no_shares, 0);
  await reconciled();
});

test('NO shares transfer between users on the same book', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b'), c = await player('c');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 5 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 5 });
  await order(b, m, { action: 'SELL', asset: 'NO', limit_kes: 55, qty: 5 });             // bid YES 45
  const r = await order(c, m, { action: 'BUY', asset: 'NO', limit_kes: 55, qty: 5 });    // ask YES 45 → crosses b's bid
  assert.equal(r.fills[0].kind, 'TRANSFER_NO'); assert.equal(r.avg_price_kes, 55);
  assert.equal((await db.one('SELECT no_shares FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, c.id])).no_shares, 5);
  await reconciled();
});

test('guards: no self-trading, no overspending, no overselling, creators cannot trade, closed markets reject orders', async () => {
  const m = await mkMarket(); const a = await player('a', 2000), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  const r = await order(a, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });                  // would trade with its own bid
  assert.equal(r.filled, 0); assert.equal(r.resting, true);
  assert.equal((await db.one("SELECT status FROM orders WHERE user_id=$1 AND asset='YES'", [a.id])).status, 'CANCELLED');
  await assert.rejects(order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 99, qty: 5000 }), /Insufficient/);
  await assert.rejects(order(b, m, { action: 'SELL', asset: 'YES', limit_kes: 50, qty: 1 }), /only have 0/);
  await assert.rejects(order(await staff('admin'), m, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1 }), /cannot trade a market you created/);
  for (const bad of [{ limit_kes: 0 }, { limit_kes: 100 }, { limit_kes: 50.5 }, { qty: 0 }, { qty: 1.5 }, { action: 'HOLD' }, { asset: 'MAYBE' }])
    await assert.rejects(order(b, m, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1, ...bad }), /./);
  await expire(m.id);
  await assert.rejects(order(b, m, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1 }), /not open/);
  assert.equal((await bal(a)).reserved_orders_minor, 0, 'closing the market returns every reserve');
  await reconciled();
});

test('cancelling an order returns the reserve; cancelling a sell unlocks the shares', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  const r = await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 30, qty: 20 });
  assert.equal((await bal(a)).reserved_orders_minor, 20 * 30 * 100);
  await tx((c) => trading.cancelOrder(c, a, r.order_id));
  assert.equal((await bal(a)).reserved_orders_minor, 0); assert.equal(await avail(a), 900000);
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 4 }); await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 4 });
  const s = await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 90, qty: 4 });
  await tx((c) => trading.cancelOrder(c, a, s.order_id));
  assert.equal((await db.one('SELECT yes_locked FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, a.id])).yes_locked, 0);
  await assert.rejects(tx((c) => trading.cancelOrder(c, b, s.order_id)), /not found/i);
  await reconciled();
});

// ───────────── settlement ─────────────
test('settlement pays KES 100 per winning contract; WHT and commission apply to profit only (spec example: net KES 820)', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });
  await expire(m.id);
  const kra = await sysBal('SYS_KRA_TAX_PAYABLE'), rev = await sysBal('SYS_PLATFORM_REVENUE'), a0 = await avail(a), b0 = await avail(b);
  const officer = await staff('settle1');
  const prev = await tx((c) => settlement.preview(c, officer, m.id, m.yes));
  assert.equal(prev.total_gross_minor, 100000); assert.equal(prev.total_wht_minor, 12000); assert.equal(prev.total_commission_minor, 6000); assert.equal(prev.total_net_minor, 82000);
  await settleIt(m, m.yes);
  assert.equal(await avail(a) - a0, 82000);
  assert.equal(await avail(b) - b0, 0, 'losers receive nothing');
  assert.equal(await sysBal('SYS_KRA_TAX_PAYABLE') - kra, 12000);
  assert.equal(await sysBal('SYS_PLATFORM_REVENUE') - rev, 6000);
  assert.equal((await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id])).locked_minor, 0);
  assert.equal((await db.one('SELECT status FROM markets WHERE id=$1', [m.id])).status, 'SETTLED');
  const pa = await db.one('SELECT realized_pnl_minor FROM positions WHERE market_id=$1 AND user_id=$2', [m.id, a.id]);
  assert.equal(pa.realized_pnl_minor, 82000 - 40000);
  const wht = await db.one("SELECT * FROM tax_events WHERE user_id=$1 AND tax_type='WINNINGS_WHT'", [a.id]);
  assert.deepEqual([wht.base_minor, wht.rate_bps, wht.amount_minor, wht.kra_remittance_status], [60000, 2000, 12000, 'PENDING']);
  await assert.rejects(settleIt(m, m.no), /./, 'cannot settle twice');
  await reconciled();
});

test('a winner who bought at 99 is taxed only on the KES 10 profit', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 99, qty: 10 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 1, qty: 10 });
  await expire(m.id);
  const a0 = await avail(a);
  await settleIt(m, m.yes);
  assert.equal(await avail(a) - a0, 99700, 'profit is KES 10: WHT 2 + commission 1');
  await reconciled();
});

test('void redeems every contract at the last traded price and charges no tax', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });
  const a0 = await avail(a), b0 = await avail(b), kra = await sysBal('SYS_KRA_TAX_PAYABLE');
  const officer = await staff('settle1');
  await tx((c) => settlement.voidMarket(c, officer, m.id, 'Match abandoned'));
  assert.equal(await avail(a) - a0, 10 * 40 * 100); assert.equal(await avail(b) - b0, 10 * 60 * 100);
  assert.equal(await sysBal('SYS_KRA_TAX_PAYABLE'), kra);
  assert.equal((await db.one('SELECT status FROM markets WHERE id=$1', [m.id])).status, 'VOID');
  await reconciled();
});

test('void after trades at different prices is solvent (the case that cost-basis refunds would break)', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b'), c3 = await player('c');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 }); await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });
  await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 70, qty: 10 }); await order(c3, m, { action: 'BUY', asset: 'YES', limit_kes: 70, qty: 10 });
  const officer = await staff('settle1');
  await tx((c) => settlement.voidMarket(c, officer, m.id, 'Event cancelled'));
  const e = await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id]);
  assert.equal(e.locked_minor, 0);
  await reconciled();
});

// ───────────── market maker ─────────────
test('market maker: a market order fills against the pool; the platform’s loss is bounded by its subsidy', async () => {
  const fund0 = await sysBal('SYS_AMM_FUND');
  const m = await mkMarket({ price: 60, subsidyKes: 2000 });
  assert.equal(await sysBal('SYS_AMM_FUND') - fund0, -200000);
  assert.equal((await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id])).locked_minor, 200000);
  const a = await player('a'), b = await player('b');
  const r = await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 95, qty: 20, tif: 'IOC' });
  assert.equal(r.filled, 20); assert.ok(r.avg_price_kes > 60 && r.avg_price_kes < 99);
  assert.equal(r.fills[0].kind, 'AMM_BUY_YES');
  const px = await db.one('SELECT yes_price_kes::float8 p FROM markets WHERE id=$1', [m.id]);
  assert.ok(px.p > 60, 'buying YES pushed the price up');
  const rb = await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 95, qty: 10, tif: 'IOC' });
  assert.equal(rb.filled, 10);
  // sell back to the pool: the user gets less than they paid (the pool keeps the spread)
  const back = await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 1, qty: 20, tif: 'IOC' });
  assert.equal(back.filled, 20);
  assert.ok(back.gross_minor < r.gross_minor, 'round trip through the pool loses money');
  await reconciled();
  await expire(m.id);
  await settleIt(m, m.no);                                                                  // the YES buyer’s side lost
  const pool = await db.one('SELECT * FROM amm_pools WHERE market_id=$1', [m.id]);
  assert.ok(pool.returned_minor >= 0 && pool.returned_minor <= 2 * 200000, 'the pool returns between nothing and everything it held');
  assert.ok(await sysBal('SYS_AMM_FUND') >= fund0 - 200000, 'platform loss never exceeds the subsidy');
  await reconciled();
});

test('an order takes the cheaper of pool and book, chunk by chunk', async () => {
  const m = await mkMarket({ price: 50, subsidyKes: 2000 });
  const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 95, qty: 3, tif: 'IOC' });           // a buys 3 from the pool…
  await order(a, m, { action: 'SELL', asset: 'YES', limit_kes: 56, qty: 3 });                      // …and offers them on the book at 56 (above the pool's bid, so it rests)
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1 AND status='OPEN'", [a.id])).n, 1);
  const r = await order(b, m, { action: 'BUY', asset: 'YES', limit_kes: 90, qty: 25, tif: 'IOC' });
  assert.equal(r.filled, 25);
  const kinds = r.fills.map((f) => f.kind);
  assert.equal(kinds[0], 'AMM_BUY_YES', 'the pool is cheaper at first');
  assert.ok(kinds.includes('TRANSFER_YES'), 'once the pool reaches the book price the resting offer is taken');
  const fill = r.fills.find((f) => f.kind === 'TRANSFER_YES'); assert.equal(fill.price_kes, 56);
  await reconciled();
});

test('market-maker funding is capped per market and in total', async () => {
  const maker = await staff('admin'), boss = await staff('superadmin');
  const r = await tx((c) => markets.createMarket(c, maker, { title: 'Will it rain in Nairobi on 1 December 2026?', category_slug: 'weather', closes_at: hrs(2), event_at: hrs(3), resolution_source: 'Kenya Meteorological Department (meteo.go.ke)', resolution_method: 'Official daily rainfall record.' }));
  await assert.rejects(tx((c) => markets.review(c, boss, r.id, 'APPROVED', 'x', { amm_subsidy_minor: 999999999 })), /between KES/);
  const mod = await staff('moderator');
  await assert.rejects(tx((c) => markets.review(c, mod, r.id, 'APPROVED', 'x', { amm_subsidy_minor: 500000 })), /Only administrators/);
  await assert.rejects(tx((c) => markets.review(c, maker, r.id, 'APPROVED', 'x')), /cannot approve a market you created/);
});

// ───────────── disputes ─────────────
test('a dispute that corrects the outcome reverses the first settlement, its tax records, and re-pays the right side', async () => {
  const m = await mkMarket(); const a = await player('a'), b = await player('b');
  await order(a, m, { action: 'BUY', asset: 'YES', limit_kes: 40, qty: 10 });
  await order(b, m, { action: 'BUY', asset: 'NO', limit_kes: 60, qty: 10 });
  await expire(m.id);
  await settleIt(m, m.yes);                                                                // wrongly says YES
  const dsp = await tx((c) => settlement.fileDispute(c, b, m.id, { reason: 'The official report shows Kenya did not win.' }));
  const a1 = await avail(a);
  const rev = await staff('admin');                                                       // not involved in the settlement
  await tx((c) => settlement.resolveDispute(c, rev, dsp.id, { decision: 'CORRECT', corrected_outcome_id: m.no, resolution: 'Official report confirms NO.' }));
  assert.equal(a1 - await avail(a), 82000, 'the wrongly paid winner gives it back');
  // b held NO at 60: payout 1000, profit 400 → WHT 80, commission 40 → net 880
  assert.equal(await avail(b), 900000 - 60000 + 88000);
  const net = await db.one("SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM tax_events WHERE market_id=$1 AND tax_type='WINNINGS_WHT'", [m.id]);
  assert.equal(net.s, 8000, 'credit note cancels the first withholding; only the corrected one remains');
  await reconciled();
});

// ───────────── KRA remittance ─────────────
test('remitting tax records a receipt, moves cash from payable to remitted and cannot be repeated', async () => {
  const fin = await staff('finance');
  const pending = (await tx((c) => admin.taxSummary(c, fin))).pending_remittance_minor;
  assert.ok(pending > 0);
  const payable = await sysBal('SYS_KRA_TAX_PAYABLE'), remitted = await sysBal('SYS_KRA_REMITTED');
  const r = await tx((c) => admin.remitTax(c, fin, { receipt_ref: 'KRA-TEST-0001' }));
  assert.equal(r.amount_minor, pending);
  assert.equal(payable - await sysBal('SYS_KRA_TAX_PAYABLE'), pending); assert.equal(await sysBal('SYS_KRA_REMITTED') - remitted, pending);
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM tax_events WHERE kra_remittance_status='PENDING'")).n, 0);
  await assert.rejects(tx((c) => admin.remitTax(c, fin, { receipt_ref: 'KRA-TEST-0001' })), /already been recorded/);
  await assert.rejects(tx((c) => admin.remitTax(c, fin, { receipt_ref: 'KRA-TEST-0002' })), /no unremitted tax/);
  await assert.rejects(tx((c) => admin.remitTax(c, fin, { receipt_ref: '' })), /receipt/i);
  await reconciled();
});

// ───────────── concurrency and fuzz ─────────────
test('50 concurrent orders on one market keep the books balanced and the escrow exact', async () => {
  const m = await mkMarket({ subsidyKes: 1000 });
  const us = []; for (let i = 0; i < 10; i++) us.push(await player('cc' + i, 5000));
  const jobs = [];
  for (let i = 0; i < 50; i++) {
    const u = us[i % 10], buy = i % 3 !== 0;
    jobs.push(order(u, m, { action: 'BUY', asset: i % 2 ? 'YES' : 'NO', limit_kes: 20 + ((i * 7) % 60), qty: 1 + (i % 5), tif: buy ? 'GTC' : 'IOC' }).catch((e) => e));
  }
  const res = await Promise.all(jobs);
  assert.ok(res.filter((r) => r && r.order_id).length > 20);
  await reconciled();
});

test('fuzz: 300 random orders and cancels never break reconciliation, escrow or reserves', async () => {
  const m = await mkMarket({ price: 45, subsidyKes: 1500 });
  const us = []; for (let i = 0; i < 6; i++) us.push(await player('fz' + i, 20000));
  let seedv = 12345; const rnd = (k) => { seedv = (seedv * 1103515245 + 12345) & 0x7fffffff; return seedv % k; };
  const open = [];
  for (let i = 0; i < 300; i++) {
    const u = us[rnd(6)], roll = rnd(10);
    try {
      if (roll < 2 && open.length) { const [uu, id] = open.splice(rnd(open.length), 1)[0]; await tx((c) => trading.cancelOrder(c, uu, id)); continue; }
      const action = roll < 7 ? 'BUY' : 'SELL', asset = rnd(2) ? 'YES' : 'NO';
      const r = await order(u, m, { action, asset, limit_kes: 10 + rnd(80), qty: 1 + rnd(12), tif: rnd(3) ? 'GTC' : 'IOC' });
      if (r.resting) open.push([u, r.order_id]);
    } catch (e) { if (!/Insufficient|only have|cancel|already|too many|not found|Order is/i.test(e.message)) throw e; }
    if (i % 60 === 59) await reconciled();
  }
  await reconciled();
  const pos = await db.q('SELECT * FROM positions WHERE market_id=$1', [m.id]);
  for (const p of pos) { assert.ok(p.yes_locked <= p.yes_shares && p.no_locked <= p.no_shares); }
  const resv = await db.one("SELECT COALESCE(SUM(reserved_minor),0)::bigint s FROM orders WHERE market_id=$1 AND status='OPEN'", [m.id]);
  const held = await db.one("SELECT COALESCE(SUM(a.balance_minor),0)::bigint s FROM ledger_accounts a JOIN wallets w ON w.id=a.wallet_id WHERE a.account_type='RESERVED_ORDERS' AND w.user_id = ANY($1::bigint[])", [us.map((u) => u.id)]);
  assert.equal(held.s, resv.s, 'reserved cash equals the sum of open buy orders');
  await expire(m.id);
  assert.equal((await db.one("SELECT COALESCE(SUM(a.balance_minor),0)::bigint s FROM ledger_accounts a JOIN wallets w ON w.id=a.wallet_id WHERE a.account_type='RESERVED_ORDERS' AND w.user_id = ANY($1::bigint[])", [us.map((u) => u.id)])).s, 0);
  await settleIt(m, m.yes);
  await reconciled();
});

test('market creation: only staff and approved users, every market reviewed, creator cannot approve their own', async () => {
  const rando = await player('rando'); const boss = await staff('superadmin');
  await assert.rejects(tx((c) => markets.createMarket(c, rando, { title: 'Will Kenya win its next international football match?', category_slug: 'sports', closes_at: hrs(2), event_at: hrs(3), resolution_source: 'fifa.com', resolution_method: 'Full-time score.' })), /approved market creators/);
  await tx((c) => admin.setCreator(c, boss, rando.id, true));
  const r = await tx(async (c) => markets.createMarket(c, await auth.publicUser(c, rando.id), { title: 'Will Kenya win its next international football match?', category_slug: 'sports', closes_at: hrs(2), event_at: hrs(3), resolution_source: 'fifa.com', resolution_method: 'Full-time score.' }));
  assert.equal(r.status, 'PENDING_REVIEW');
  await assert.rejects(order(await U(rando.id), { id: r.id }, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1 }), /not open/);
});
