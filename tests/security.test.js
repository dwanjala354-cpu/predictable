'use strict';
process.env.DATABASE_DIR = 'memory://'; process.env.RATE_LIMIT = 'off'; process.env.NODE_ENV = 'test'; process.env.QUIET_SMS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const db = require('../src/db');
const seed = require('../src/seed');
const auth = require('../src/auth');
const security = require('../src/security');
const totp = require('../src/totp');
const wallet = require('../src/wallet');
const { createApp } = require('../src/server');
const PW = seed.STAFF_PASSWORD;
let n = 0, server, base;
const tx = (fn) => db.tx(fn);
const player = (name = 'sp') => tx(async (c) => { const id = await seed.mkUser(c, `s_${name}${++n}`, name, '1990-01-01'); return auth.publicUser(c, id); });
const staff = async (name) => tx(async (c) => auth.publicUser(c, (await c.one('SELECT id FROM users WHERE username=$1', [name])).id));
const resetStep = (id) => db.q('UPDATE user_mfa SET last_used_step=0 WHERE user_id=$1', [id]);
async function call(token, method, path, body) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && !['GET', 'HEAD'].includes(method) ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
const login = async (u, pw = PW, extra = {}) => (await call(null, 'POST', '/auth/login', { identifier: u, password: pw, ...extra }));

test.before(async () => {
  await require('./_pgreset')(); await seed.run({ demo: false });
  server = http.createServer(createApp()); await new Promise((r) => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('TOTP matches the RFC 6238 test vector; secrets are sealed at rest; codes are single-use', async () => {
  assert.equal(totp.code('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  assert.equal(totp.open(totp.seal('SECRET123')), 'SECRET123');
  assert.notEqual(totp.seal('SECRET123'), totp.seal('SECRET123'), 'fresh IV each time');
  const u = await player('mf');
  const { secret } = await tx((c) => security.setupMfa(c, u));
  const stored = await db.one('SELECT secret_sealed FROM user_mfa WHERE user_id=$1', [u.id]);
  assert.ok(!stored.secret_sealed.includes(secret), 'plaintext secret is never stored');
  await assert.rejects(tx((c) => security.enableMfa(c, u, '000000')), /not right/);
  const code = totp.code(secret);
  await tx((c) => security.enableMfa(c, u, code));
  await assert.rejects(tx((c) => security.consumeTotp(c, u.id, code).then((ok) => { if (!ok) throw new Error('replay refused'); })), /replay refused/);
});

test('login: wrong passwords lock the account after 5 failures; failed attempts persist; success resets', async () => {
  const u = await player('lk');
  for (let i = 0; i < 5; i++) { const r = await tx((c) => auth.login(c, { identifier: u.username, password: 'wrong-pass-1' }, { ip: '9.9.9.9' })); assert.equal(r.fail.code, 'BAD_CREDENTIALS'); }
  await assert.rejects(tx((c) => auth.login(c, { identifier: u.username, password: PW }, { ip: '9.9.9.9' })), /Too many failed/);
  assert.equal((await login(u.username)).status, 429, 'even the right password is refused while locked');
  await db.q("UPDATE login_attempts SET created_at = now() - interval '20 minutes' WHERE lower(identifier)=lower($1)", [u.username]);
  assert.ok((await login(u.username)).j.token, 'lock expires');
  // unknown user and wrong password are indistinguishable
  const a = await login('nobody_here_1'), b = await login(u.username, 'wrong-pass-1');
  assert.equal(a.j.error.message, b.j.error.message);
});

test('MFA login flow: password alone is not enough; replayed codes are refused', async () => {
  const u = await player('ml');
  const { secret } = await tx((c) => security.setupMfa(c, u));
  await tx((c) => security.enableMfa(c, u, totp.code(secret)));
  const r1 = await login(u.username); assert.equal(r1.j.mfa_required, true); assert.equal(r1.j.token, undefined);
  await resetStep(u.id);
  const next = totp.code(secret);
  const r2 = await login(u.username, PW, { totp: next }); assert.ok(r2.j.token);
  const r3 = await login(u.username, PW, { totp: next }); assert.equal(r3.status, 401, 'same code cannot be used twice');
  await resetStep(u.id);
  assert.equal((await login(u.username, PW, { totp: '123456' })).status, 401);
});

test('staff need two-step verification: console blocked until enrolled; sensitive actions need a fresh code', async () => {
  const sess = (await login('settle1')).j.token;
  const blocked = await call(sess, 'GET', '/admin/dashboard');
  assert.equal(blocked.status, 403); assert.equal(blocked.j.error.code, 'MFA_ENROLLMENT_REQUIRED');
  assert.equal((await call(sess, 'GET', '/me')).status, 200, 'account and enrolment endpoints stay reachable');
  const setup = await call(sess, 'POST', '/me/mfa/setup'); assert.ok(setup.j.qr_svg.startsWith('<svg') || setup.j.qr_svg.includes('<svg'));
  assert.equal((await call(sess, 'POST', '/me/mfa/enable', { code: '111111' })).status, 400);
  assert.equal((await call(sess, 'POST', '/me/mfa/enable', { code: totp.code(setup.j.secret) })).status, 200);
  assert.equal((await call(sess, 'GET', '/admin/dashboard')).status, 200);
  assert.equal((await call(sess, 'POST', '/me/mfa/disable', { code: totp.code(setup.j.secret, Date.now() + 30000) })).j.error.code, 'MFA_REQUIRED_FOR_STAFF');
  // step-up on a sensitive action
  const fin = (await login('finance')).j.token; const fsetup = await call(fin, 'POST', '/me/mfa/setup'); await call(fin, 'POST', '/me/mfa/enable', { code: totp.code(fsetup.j.secret) });
  const player1 = await player('wd'); await tx((c) => seed.fund(c, player1.id, 1200));
  const w = await tx((c) => wallet.requestWithdrawal(c, player1.id, 100000, '0712345678'));
  const no = await call(fin, 'POST', `/admin/withdrawals/${w.id}`, { approve: true }); assert.equal(no.j.error.code, 'STEP_UP_REQUIRED');
  const bad = await call(fin, 'POST', `/admin/withdrawals/${w.id}`, { approve: true, totp: '000000' }); assert.equal(bad.j.error.code, 'STEP_UP_FAILED');
  await resetStep((await staff('finance')).id);
  const good = await call(fin, 'POST', `/admin/withdrawals/${w.id}`, { approve: true, totp: totp.code(fsetup.j.secret) }); assert.equal(good.status, 200);
  const user = await db.one('SELECT status FROM withdrawal_requests WHERE id=$1', [w.id]); assert.equal(user.status, 'COMPLETED');
});

test('withdrawals need a one-time code sent by SMS; wrong codes lock it; codes are single-use', async () => {
  const u = await player('otp'); await tx((c) => seed.fund(c, u.id, 1000));
  const t = (await login(u.username)).j.token;
  const none = await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: '123456' });
  assert.equal(none.j.error.code, 'OTP_REQUIRED');
  await call(t, 'POST', '/wallet/withdraw/otp');
  const msg = (await db.one("SELECT body FROM notifications WHERE user_id=$1 AND type='OTP' ORDER BY id DESC LIMIT 1", [u.id])).body;
  const code = msg.match(/code is (\d{6})/)[1];
  assert.equal((await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: code === '000000' ? '111111' : '000000' })).j.error.code, 'OTP_INVALID');
  assert.equal((await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: code })).status, 200);
  assert.equal((await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: code })).j.error.code, 'OTP_REQUIRED', 'used code is dead');
  await call(t, 'POST', '/wallet/withdraw/otp');
  for (let i = 0; i < 5; i++) await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: '999999' });
  assert.ok(['OTP_LOCKED', 'OTP_REQUIRED'].includes((await call(t, 'POST', '/wallet/withdraw', { amount_kes: '100', destination: '0712345678', otp: '999999' })).j.error.code));
});

test('audit log is a tamper-evident hash chain; edits and deletes are refused; a bypassing edit is detected', async () => {
  const u = await player('au');
  await tx((c) => auth.simulateKyc(c, u.id));
  const sup = await staff('superadmin');
  await tx((c) => require('../src/common').audit(c, sup.id, 'test.event', 'thing', 1, { a: 1, b: { z: 2, y: 3 } }));
  const v1 = await tx((c) => security.verifyAudit(c)); assert.equal(v1.ok, true); assert.ok(v1.sealed > 0);
  await assert.rejects(db.q("UPDATE audit_logs SET action='x' WHERE hash IS NULL OR hash IS NOT NULL"), /append-only/);
  await assert.rejects(db.q('DELETE FROM audit_logs'), /append-only/);
  const row = await db.one("SELECT id, seq FROM audit_logs WHERE action='test.event'");
  await db.q('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_immutable');          // simulate a privileged attacker with raw DB access
  await db.q("UPDATE audit_logs SET details='{\"a\":999}'::jsonb WHERE id=$1", [row.id]);
  await db.q('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_immutable');
  const v2 = await tx((c) => security.verifyAudit(c));
  assert.equal(v2.ok, false); assert.equal(v2.first_break_id, row.id);
  await db.q('ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_immutable');
  await db.q("UPDATE audit_logs SET details='{\"a\":1,\"b\":{\"z\":2,\"y\":3}}'::jsonb WHERE id=$1", [row.id]);   // restore so later tests are unaffected
  await db.q('ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_immutable');
  assert.equal((await tx((c) => security.verifyAudit(c))).ok, true);
});

test('suspended players can appeal with their credentials; a different officer decides', async () => {
  const u = await player('ap'); const adm = await staff('admin'); const risk = await staff('risk');
  await tx((c) => require('../src/admin').setUserStatus(c, risk, u.id, 'SUSPENDED', 'risk review'));
  const l = await login(u.username); assert.equal(l.status, 403); assert.equal(l.j.error.code, 'ACCOUNT_SUSPENDED');
  assert.equal((await call(null, 'POST', '/appeals', { identifier: u.username, password: 'wrong-pass-9', message: 'please let me back in, I did nothing' })).status, 401);
  assert.equal((await call(null, 'POST', '/appeals', { identifier: u.username, password: PW, message: 'short' })).status, 400);
  const a = await call(null, 'POST', '/appeals', { identifier: u.username, password: PW, message: 'I shared a phone with a relative who also plays.' });
  assert.equal(a.status, 200);
  assert.equal((await call(null, 'POST', '/appeals', { identifier: u.username, password: PW, message: 'Second attempt while the first is open.' })).status, 409);
  await assert.rejects(tx((c) => security.decideAppeal(c, adm, a.j.id, 'REINSTATE', 'ok')), /explanation/);
  await tx((c) => security.decideAppeal(c, adm, a.j.id, 'REINSTATE', 'Reviewed the evidence; account reinstated.'));
  assert.ok((await login(u.username)).j.token);
});

test('sessions: listed, revocable; password change signs out other devices', async () => {
  const u = await player('ss');
  const t1 = (await login(u.username)).j.token, t2 = (await login(u.username)).j.token;
  const list = await call(t1, 'GET', '/me/sessions'); assert.equal(list.j.length, 2); assert.equal(list.j.filter((s) => s.current).length, 1);
  assert.equal((await call(t1, 'POST', '/me/password', { current: 'nope-nope-1', next: 'Another#Pass9' })).status, 403);
  assert.equal((await call(t1, 'POST', '/me/password', { current: PW, next: 'password' })).status, 400);
  assert.equal((await call(t1, 'POST', '/me/password', { current: PW, next: 'Another#Pass9' })).status, 200);
  assert.equal((await call(t2, 'GET', '/me')).status, 401, 'other session is dead');
  assert.equal((await call(t1, 'GET', '/me')).status, 200);
  assert.equal((await login(u.username, 'Another#Pass9')).status, 200);
});

test('permission matrix: every protected route refuses anonymous users, players, and staff without the permission', async () => {
  const app = createApp();
  const routes = [];
  for (const layer of (app.router || app._router).stack) {
    if (!layer.route) continue;
    const meta = layer.route.stack[0].handle.meta; if (!meta) continue;
    for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path, ...meta });
  }
  assert.ok(routes.filter((r) => r.perm).length >= 30, 'found the admin routes');
  const player1 = await player('mx'); const pt = (await login(player1.username)).j.token;
  const roleTokens = {};
  await tx(async (c) => { await c.q('DELETE FROM user_mfa'); await c.q("UPDATE settings SET value='0' WHERE key='require_staff_mfa'"); });   // earlier tests enrolled some staff; this test is about permissions only
  for (const name of ['moderator', 'settle1', 'finance', 'risk', 'admin']) {
    const lg = await login(name); roleTokens[name] = { token: lg.j.token, perms: (await staff(name)).permissions };
  }
  let checked = 0;
  for (const r of routes) {
    const url = r.path.replace(/^\/api/, '').replace(/:id/g, '1');
    if (r.auth || r.perm) assert.equal((await call(null, r.method, url, {})).status, 401, `anonymous ${r.method} ${r.path}`);
    if (r.perm) {
      assert.equal((await call(pt, r.method, url, {})).status, 403, `player ${r.method} ${r.path}`);
      const lacking = Object.values(roleTokens).find((x) => !x.perms.includes(r.perm));
      if (lacking) assert.equal((await call(lacking.token, r.method, url, {})).status, 403, `staff without ${r.perm} on ${r.method} ${r.path}`);
      checked++;
    }
  }
  assert.ok(checked >= 30);
  // role escalation by a player
  assert.equal((await call(pt, 'POST', '/admin/staff', { username: player1.username, role: 'super_administrator' })).status, 403);
  assert.deepEqual((await tx((c) => auth.publicUser(c, player1.id))).roles, ['user']);
});

test('IDOR: a player cannot read another player\'s unpublished market, positions or wallet data', async () => {
  const a = await player('ia'), b = await player('ib');
  await db.q('UPDATE users SET market_creator=true WHERE id=$1', [a.id]);
  const at = (await login(a.username)).j.token, bt = (await login(b.username)).j.token;
  const hrs = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const m = await tx(async (c) => require('../src/markets').createMarket(c, await auth.publicUser(c, a.id), { title: 'Will Kenya score two goals in its next match?', category_slug: 'sports', closes_at: hrs(2), event_at: hrs(3), resolution_source: 'Football Kenya Federation official report (fkf.co.ke)', resolution_method: 'Goals in regular time.' }));
  assert.equal((await call(at, 'GET', `/markets/${m.id}`)).status, 200, 'the proposer sees the draft');
  assert.equal((await call(bt, 'GET', `/markets/${m.id}`)).status, 404, 'another player does not');
  assert.equal((await call(null, 'GET', `/markets/${m.id}`)).status, 404);
  assert.equal((await call(bt, 'GET', '/admin/users/' + a.id)).status, 403);
  const list = await call(bt, 'GET', '/markets?limit=200'); assert.ok(!list.j.some((x) => x.id === m.id));
  assert.equal((await call(bt, 'POST', `/markets/${m.id}/orders`, { action: 'BUY', asset: 'YES', limit_kes: 50, qty: 1 })).status, 409, 'unpublished markets cannot be traded');
  assert.equal((await call(null, 'GET', '/my/positions')).status, 401);
  assert.equal((await call(bt, 'DELETE', '/orders/999999')).status, 404);
});

test('rate limiting returns 429 with Retry-After once the budget is spent', async () => {
  process.env.RATE_LIMIT = 'on'; process.env.RATE_LIMIT_AUTH = '3';
  const s2 = http.createServer(createApp()); await new Promise((r) => s2.listen(0, r));
  const url = `http://localhost:${s2.address().port}/api/auth/login`;
  const codes = []; let retry = null;
  for (let i = 0; i < 6; i++) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'rl_user', password: 'x' }) }); codes.push(r.status); if (r.status === 429) retry = r.headers.get('retry-after'); }
  s2.close(); process.env.RATE_LIMIT = 'off'; delete process.env.RATE_LIMIT_AUTH;
  assert.deepEqual(codes.slice(0, 3), [401, 401, 401]); assert.equal(codes[5], 429); assert.ok(Number(retry) > 0);
});

test('security headers are set; API responses are not cached', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-powered-by'), null);
});
