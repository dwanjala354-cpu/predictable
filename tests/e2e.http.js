'use strict';
// End-to-end over HTTP against a running server (prediction-market edition):  BASE=http://localhost:3000 node tests/e2e.http.js
// Needs a freshly seeded demo database. Covers MFA-enforced staff, step-up approvals, the AI-proposes/admin-approves flow,
// the 5%/5% deposit waterfall, contract trading against the order book and market maker, settlement with tax, KRA remittance, and OTP-confirmed withdrawals.
const BASE = process.env.BASE || 'http://localhost:3000';
const PW = process.env.PREDICTABLE_STAFF_PASSWORD || 'Predictable#2026';
const assert = require('node:assert/strict'); const totp = require('../src/totp');
const call = async (tok, method, path, body) => {
  const r = await fetch(BASE + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const ok = async (...a) => { const r = await call(...a); assert.ok(r.status < 300, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.j)}`); return r.j; };
const sfx = Date.now().toString(36).slice(-5); const hrs = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const secrets = {};
async function staff(u) {                                       // enrol on first use, then sign in with a code
  let r = await ok(null, 'POST', '/auth/login', { identifier: u, password: PW });
  if (r.token) { const s = await ok(r.token, 'POST', '/me/mfa/setup'); secrets[u] = s.secret; await ok(r.token, 'POST', '/me/mfa/enable', { code: totp.code(s.secret) }); }
  r = await ok(null, 'POST', '/auth/login', { identifier: u, password: PW }); assert.equal(r.mfa_required, true, u + ' must be asked for a code');
  r = await ok(null, 'POST', '/auth/login', { identifier: u, password: PW, totp: totp.code(secrets[u], Date.now() + 30000) }); return r.token;
}
const code = (u) => totp.code(secrets[u], Date.now() + 30000);   // one step ahead of the code used at sign-in (replay protection), still inside the accepted window
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const [admin, sup, s1, s2, fin] = [await staff('admin'), await staff('superadmin'), await staff('settle1'), await staff('settle2'), await staff('finance')]; console.log('ok  staff sign in with two-step verification');
  assert.equal((await call(null, 'GET', '/admin/dashboard')).status, 401);
  const weak = await call(null, 'POST', '/auth/register', { username: 'weak_' + sfx, email: `w${sfx}@x.com`, phone: '0711111111', password: 'password1', date_of_birth: '1990-01-01', accept_terms: true }); assert.equal(weak.status >= 400, true); console.log('ok  weak password refused');
  const reg = await ok(null, 'POST', '/auth/signup-login', { username: 'pl_' + sfx, email: `pl${sfx}@x.com`, phone: '07' + String(10000000 + Math.floor(Math.random() * 8e7)), password: 'Sup3rSecret', display_name: 'Pl', date_of_birth: '1992-02-02', accept_terms: true });
  const pl = reg.token; await ok(pl, 'POST', '/me/kyc/simulate');
  const fee = await ok(pl, 'GET', '/fees/quote?type=deposit&amount_kes=2000'); assert.deepEqual([fee.tax, fee.fee, fee.net], [10000, 10000, 180000]);
  const dep = await ok(pl, 'POST', '/wallet/deposit', { amount_kes: 2000 }); const paid = await ok(pl, 'POST', `/wallet/deposit/${dep.reference}/simulate-pay`);
  assert.equal(paid.net_minor, 180000); assert.equal((await ok(pl, 'GET', '/me')).balances.available_minor, 180000); console.log('ok  KES 2,000 deposit credits KES 1,800 (5% excise + 5% fee)');
  // a staff-proposed market, approved by a different officer with a funded market maker
  const mk = async (title) => { const m = await ok(admin, 'POST', '/markets', { title, description: 'FT', category_slug: 'sports', initial_price_kes: 55, closes_at: hrs(1), event_at: hrs(2), resolution_source: 'FKF (fkf.co.ke)', resolution_method: 'Full time' });
    assert.equal((await call(admin, 'POST', `/admin/markets/${m.id}/review`, { decision: 'APPROVED' })).status, 403);   // cannot approve your own market
    await ok(sup, 'POST', `/admin/markets/${m.id}/review`, { decision: 'APPROVED', amm_subsidy_kes: 1000 }); const d = await ok(null, 'GET', '/markets/' + m.id);
    return { id: m.id, yes: d.outcomes.find((x) => x.outcome_code === 'YES').id, no: d.outcomes.find((x) => x.outcome_code === 'NO').id, d }; };
  const A = await mk(`Will Kenya beat Uganda on 6 December 2026? (${sfx})`);
  assert.equal(A.d.yes_price_kes, 55); assert.equal(A.d.no_price_kes, 45); assert.equal(A.d.book.amm.yes_price_kes > 54.9, true); console.log('ok  market opens at 55/45 with a market maker');
  const unlicensed = await call(pl, 'POST', '/markets', { title: 'Will it rain in Nairobi on 9 December 2026?', category_slug: 'weather', closes_at: hrs(1), event_at: hrs(2), resolution_source: 'meteo.go.ke', resolution_method: 'Daily record' }); assert.equal(unlicensed.status, 403);
  // trading: preview, buy, resting sell, positions
  const pv = await ok(pl, 'POST', `/markets/${A.id}/orders/preview`, { action: 'BUY', asset: 'YES', limit_kes: 80, qty: 5 }); assert.equal(pv.filled, 5); assert.ok(pv.avg_price_kes >= 55 && pv.avg_price_kes <= 80);
  assert.equal((await ok(pl, 'GET', '/my/positions')).length, 0, 'a preview changes nothing');
  const buy = await ok(pl, 'POST', `/markets/${A.id}/orders`, { action: 'BUY', asset: 'YES', limit_kes: 80, qty: 5, tif: 'IOC' }); assert.equal(buy.filled, 5);
  const pos = await ok(pl, 'GET', '/my/positions'); assert.equal(pos[0].yes.shares, 5); assert.equal(pos[0].yes.max_payout_minor, 50000);
  const sell = await ok(pl, 'POST', `/markets/${A.id}/orders`, { action: 'SELL', asset: 'YES', limit_kes: 95, qty: 2 }); assert.equal(sell.resting, true);
  const book = await ok(null, 'GET', `/markets/${A.id}/book`); assert.equal(book.asks[0].price_kes, 95);
  assert.equal((await call(pl, 'POST', `/markets/${A.id}/orders`, { action: 'SELL', asset: 'YES', limit_kes: 95, qty: 4 })).status, 409, 'only 3 unlocked contracts remain');
  assert.equal((await call(admin, 'POST', `/markets/${A.id}/orders`, { action: 'BUY', asset: 'YES', limit_kes: 60, qty: 1 })).status, 403, 'the creator cannot trade'); console.log('ok  trading, previews, resting orders, creator ban');
  await ok(pl, 'DELETE', `/orders/${sell.order_id}`);
  // close, resolve with evidence, two approvals with step-up codes, then the winner is paid net of tax
  await ok(admin, 'POST', `/admin/markets/${A.id}/spec`, { kind: 'THRESHOLD', params: { yes_outcome: A.yes, no_outcome: A.no, op: '>=', threshold: 1 } });
  await ok(admin, 'POST', `/admin/markets/${A.id}/evidence`, { kind: 'RESULT', claim: 'Kenya scored 2 goals in the match', source_name: 'FKF', source_url: 'https://www.fkf.co.ke/m/1', fact: { value: 2 } });
  await ok(admin, 'POST', `/admin/markets/${A.id}/close`); assert.equal((await ok(null, 'GET', '/markets/' + A.id)).status, 'LOCKED');
  assert.equal((await call(pl, 'POST', `/markets/${A.id}/orders`, { action: 'BUY', asset: 'YES', limit_kes: 60, qty: 1 })).status, 409);
  await sleep(31000);   // let the authenticator step advance past the sign-in codes
  const prop = await ok(s1, 'POST', `/admin/markets/${A.id}/ai-resolution`); assert.equal(prop.proposed, true); assert.equal(prop.outcome_id, A.yes);
  const before = (await ok(pl, 'GET', '/me')).balances.available_minor;
  const d1 = await ok(s2, 'POST', `/admin/settlements/${prop.settlement_id}/decision`, { decision: 'APPROVED', totp: code('settle2') }); assert.equal(d1.status, 'AWAITING_MORE_APPROVALS');
  const d2 = await ok(sup, 'POST', `/admin/settlements/${prop.settlement_id}/decision`, { decision: 'APPROVED', totp: code('superadmin') }); assert.equal(d2.status, 'EXECUTED');
  const after = (await ok(pl, 'GET', '/me')).balances.available_minor; const gain = after - before; assert.ok(gain > 0 && gain < 100000 && gain % 1 === 0);
  const pay = (await ok(pl, 'GET', '/my/positions'))[0]; assert.equal(pay.status, 'SETTLED'); console.log('ok  settled: winner credited KES ' + gain / 100 + ' after withholding tax and commission');
  // finance records the KRA remittance (step-up code), then the books reconcile
  const taxes = await ok(fin, 'GET', '/admin/tax'); assert.ok(taxes.pending_remittance_minor > 0);
  assert.equal((await call(fin, 'POST', '/admin/tax/remit', { receipt_ref: 'KRA-E2E-' + sfx })).status >= 400, true, 'no step-up code, no remittance');
  const rem = await ok(fin, 'POST', '/admin/tax/remit', { receipt_ref: 'KRA-E2E-' + sfx, totp: code('finance') }); assert.equal(rem.amount_minor, taxes.pending_remittance_minor); console.log('ok  KRA remittance recorded');
  const fo = await ok(fin, 'GET', '/admin/finance'); assert.equal(fo.reconciliation.ok, true); assert.equal(fo.escrow.ok, true); console.log('ok  ledger and escrow reconcile');
  const adminMk = await ok(admin, 'GET', '/admin/markets'); assert.ok(adminMk.length >= 3);
  const reco = await ok(admin, 'GET', `/admin/markets/${A.id}/reference-price`); assert.equal(reco.available, false); console.log('ok  no model attached to a non-football market (stays manual)');
  const rsk = await ok((await staff('risk')), 'POST', '/admin/risk/scan'); assert.ok(rsk.note); console.log('ok  risk scan advisory only');
  assert.equal((await call(pl, 'POST', '/admin/risk/scan')).status, 403); assert.equal((await call(pl, 'GET', '/admin/ai/ratings')).status, 403);
  // OTP-confirmed withdrawal
  assert.equal((await call(pl, 'POST', '/wallet/withdraw', { amount_kes: 50, destination: '0712345678' })).status >= 400, true);
  await ok(pl, 'POST', '/wallet/withdraw/otp'); const n = await ok(pl, 'GET', '/notifications'); const otp = n.items.find((x) => x.type === 'OTP').body.match(/\d{6}/)[0];
  assert.equal((await call(pl, 'POST', '/wallet/withdraw', { amount_kes: 50, destination: '0712345678', otp: otp === '000000' ? '111111' : '000000' })).status >= 400, true);
  const wd = await ok(pl, 'POST', '/wallet/withdraw', { amount_kes: 50, destination: '0712345678', otp }); assert.deepEqual([wd.tax_minor, wd.fee_minor, wd.net_minor], [250, 250, 4500]); console.log('ok  withdrawal needs the one-time code');
  const v = await ok(admin, 'GET', '/admin/audit/verify'); assert.equal(v.ok, true); console.log('ok  audit chain verifies');
  console.log('E2E PASSED');
})().catch((e) => { console.error('E2E FAILED', e.message); process.exit(1); });
