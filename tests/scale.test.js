'use strict';
// Release-gate tests: hundreds of traders at once, double-spend races, duplicate settlement races, duplicate payment callbacks.
process.env.DATABASE_DIR = 'memory://'; process.env.NODE_ENV = 'test'; process.env.QUIET_SMS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const seed = require('../src/seed');
const auth = require('../src/auth');
const ledger = require('../src/ledger');
const markets = require('../src/markets');
const trading = require('../src/trading');
const settlement = require('../src/settlement');
const wallet = require('../src/wallet');

const hrs = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const HASH = bcrypt.hashSync('Bulk#Pass1', 4);
let uid = 0;

// Fast bulk player creation (skips per-user bcrypt): verified, funded players with the standard role.
async function bulkPlayers(count, kes) {
  return db.tx(async (c) => {
    const role = await c.one("SELECT id FROM roles WHERE name='user'");
    const sys = await ledger.systemAccount(c, 'SYS_FUNDING');
    const out = [];
    for (let i = 0; i < count; i++) {
      const k = ++uid;
      const u = await c.one(`INSERT INTO users(username,email,phone,password_hash,display_name,date_of_birth,kyc_status) VALUES ($1,$2,$3,$4,$5,'1990-01-01','VERIFIED') RETURNING id, username`,
        [`bulk_${k}`, `bulk${k}@x.test`, `+2547${String(10000000 + k)}`, HASH, `Bulk ${k}`]);
      await c.q('INSERT INTO user_roles(user_id, role_id) VALUES ($1,$2)', [u.id, role.id]);
      await c.q('INSERT INTO responsible_gambling_profiles(user_id) VALUES ($1)', [u.id]);
      const a = await ledger.userAccounts(c, u.id);
      if (kes > 0) await ledger.post(c, { reference: `bulkfund:${u.id}`, type: 'DEPOSIT', lines: [{ account: sys, direction: 'DEBIT', amount: kes * 100 }, { account: a.AVAILABLE, direction: 'CREDIT', amount: kes * 100 }] });
      out.push({ id: u.id, username: u.username, permissions: ['market.bet', 'market.create'] });
    }
    return out;
  });
}
const staff = (name) => db.tx(async (c) => auth.publicUser(c, (await c.one('SELECT id FROM users WHERE username=$1', [name])).id));
async function openMarket() {
  const adm = await staff('admin'), sup = await staff('superadmin');
  const r = await db.tx((c) => markets.createMarket(c, adm, { title: 'Will Kenya win its next international football match?', category_slug: 'sports', initial_price_kes: 50, closes_at: hrs(2), event_at: hrs(3), resolution_source: 'FIFA match centre (fifa.com)', resolution_method: 'Full-time result, extra time ignored.' }));
  await db.tx((c) => markets.review(c, sup, r.id, 'APPROVED'));
  const o = await db.q('SELECT id, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [r.id]);
  return { id: r.id, yes: o.find((x) => x.outcome_code === 'YES').id, no: o.find((x) => x.outcome_code === 'NO').id };
}
const place = (u, m, o) => db.tx((c) => trading.placeOrder(c, u, m.id, o));
const reconciled = async () => {
  const r = await db.tx((c) => ledger.reconcile(c)); assert.equal(r.ok, true, JSON.stringify(r.balance_mismatches));
  const e = await db.tx((c) => trading.escrowCheck(c)); assert.equal(e.ok, true, JSON.stringify(e));
};

test.before(async () => { await require('./_pgreset')(); await seed.run({ demo: false }); });
test.after(async () => { await reconciled(); await db.close(); });

test('400 traders hit one market at the same instant: every pair is minted exactly once and the escrow is exact', { timeout: 290000 }, async () => {
  const players = await bulkPlayers(400, 1000);
  const m = await openMarket();
  const t0 = Date.now();
  const res = await Promise.allSettled(players.map((u, i) => place(u, m, { action: 'BUY', asset: i % 2 ? 'NO' : 'YES', limit_kes: 50, qty: 3 })));
  console.log(`  400 concurrent orders settled in ${Date.now() - t0} ms on ${db.kind()}`);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 400, res.filter((r) => r.status === 'rejected').map((r) => r.reason.message).slice(0, 3).join('; '));
  const e = await db.one('SELECT locked_minor FROM escrow_pools WHERE market_id=$1', [m.id]);
  assert.equal(e.locked_minor, 200 * 3 * 10000, '200 YES buyers × 3 contracts matched with 200 NO buyers × 3');
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM orders WHERE market_id=$1 AND status='OPEN'", [m.id])).n, 0);
  const overdrawn = await db.one(`SELECT COUNT(*)::int n FROM ledger_accounts a JOIN wallets w ON w.id=a.wallet_id JOIN users u ON u.id=w.user_id WHERE a.account_type='AVAILABLE' AND u.username LIKE 'bulk\\_%' AND a.balance_minor < 90000 - 3 * 50 * 100`);
  assert.equal(overdrawn.n, 0, 'nobody paid more than 3 contracts at 50');
  await reconciled();
});

test('one player, many simultaneous orders on different markets: cash is never double-reserved', { timeout: 200000 }, async () => {
  const [solo] = await bulkPlayers(1, 1000);        // KES 900 after deposit costs: nine reservations of KES 100
  const ms = []; for (let i = 0; i < 20; i++) ms.push(await openMarket());
  const res = await Promise.allSettled(ms.map((m) => place(solo, m, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 2 })));
  const have = (await db.tx((c) => ledger.balances(c, solo.id)));
  const ok = res.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 10, 'KES 1,000 funds exactly ten KES 100 reservations');
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => /Insufficient/.test(r.reason.message)));
  assert.equal(have.available_minor, 0); assert.equal(have.reserved_orders_minor, 100000); assert.equal(have.total_minor, 100000);
  await reconciled();
});

test('same player firing 30 identical orders at one market from many connections', { timeout: 120000 }, async () => {
  const [u] = await bulkPlayers(1, 1000); const m = await openMarket();
  const res = await Promise.allSettled(Array.from({ length: 30 }, () => place(u, m, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1 })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 20, 'KES 1,000 pays for twenty KES 50 reservations');
  const b = await db.tx((c) => ledger.balances(c, u.id));
  assert.equal(b.available_minor + b.reserved_orders_minor, 100000);
  await reconciled();
});

test('simultaneous approvals of one settlement execute it exactly once; payouts are not duplicated', { timeout: 120000 }, async () => {
  const players = await bulkPlayers(6, 1000); const m = await openMarket();
  for (let i = 0; i < 6; i++) await place(players[i], m, { action: 'BUY', asset: i < 3 ? 'YES' : 'NO', limit_kes: 50, qty: 2 });
  await db.q("UPDATE markets SET closes_at = now() - interval '1 second' WHERE id=$1", [m.id]); await db.tx((c) => markets.tick(c));
  const off = await staff('settle1'), off2 = await staff('settle2');
  const pr = await db.tx((c) => settlement.propose(c, off, m.id, { outcome_id: m.yes, evidence: [{ source_url: 'https://example.org/r' }] }));
  const res = await Promise.allSettled([off, off2, off, off2, off, off2, off, off2].map((o) => db.tx((c) => settlement.approve(c, o, pr.settlement_id, 'APPROVED'))));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM payouts WHERE settlement_id=$1 AND gross_minor > 0", [pr.settlement_id])).n, 3);
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM ledger_transactions WHERE reference=$1", [`settle:${pr.settlement_id}`])).n, 1);
  // each winner: 2 contracts → KES 200 gross, cost KES 100, profit 100 → WHT 20 + commission 10 → net KES 170
  assert.equal((await db.one('SELECT SUM(net_minor)::int s FROM payouts WHERE settlement_id=$1', [pr.settlement_id])).s, 3 * 17000);
  await reconciled();
});

test('concurrent duplicate payment callbacks, withdrawals and deposits keep the books exact', { timeout: 120000 }, async () => {
  const [u] = await bulkPlayers(1, 0);
  const pis = []; for (let i = 0; i < 5; i++) pis.push(await db.tx((c) => wallet.createDeposit(c, u.id, 100000)));
  const secret = (await db.one("SELECT value FROM settings WHERE key='payment_callback_secret'")).value;
  const evts = pis.flatMap((pi) => Array.from({ length: 4 }, () => { const body = JSON.stringify({ event_id: 'ev-' + pi.reference, reference: pi.reference, status: 'SUCCESS', amount_minor: 100000 }); return [body, wallet.signCallback(secret, body)]; }));
  const res = await Promise.allSettled(evts.map(([b, s]) => db.tx((c) => wallet.handleProviderCallback(c, b, s))));
  assert.ok(res.every((r) => r.status === 'fulfilled'));
  assert.equal(res.filter((r) => r.value.credited).length, 5);
  assert.equal((await db.tx((c) => ledger.balances(c, u.id))).available_minor, 450000);   // five KES 1,000 deposits, 90% credited
  await reconciled();
});
