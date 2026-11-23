'use strict';
const bcrypt = require('bcryptjs');
const { bad, forbidden, conflict, AppError, sha256, randToken } = require('./util');
const ledger = require('./ledger');
const security = require('./security');
const totp = require('./totp');

const SESSION_HOURS = 24 * 7;

// Role → permission matrix (spec §5). Creating a market never grants any of these.
const PERMISSIONS = {
  'market.create': 'Propose prediction markets',
  'market.bet': 'Trade contracts',
  'market.review': 'Review and approve/reject proposed markets',
  'market.house.manage': 'Fund market makers (platform liquidity) when approving a market',
  'market.suspend': 'Suspend or close markets',
  'settlement.propose': 'Verify outcomes and propose settlements',
  'settlement.approve': 'Approve settlements (second officer)',
  'finance.view': 'View ledger, reconciliation and revenue reports',
  'finance.withdrawals': 'Review and complete withdrawals',
  'finance.tax': 'Record KRA tax remittances',
  'risk.view': 'Monitor exposure and suspicious activity',
  'users.manage': 'View and manage user accounts, KYC and restrictions',
  'disputes.resolve': 'Resolve disputes',
  'audit.view': 'View audit logs',
  'admin.dashboard': 'Open the admin console',
  'roles.manage': 'Manage staff roles and system configuration',
  'research.manage': 'Add and retract research evidence, manage feeds and suggestions',
};
const ROLES = {
  user: { d: 'Registered user', p: ['market.create', 'market.bet'] },
  moderator: { d: 'Moderator', p: ['admin.dashboard', 'market.review', 'market.suspend', 'disputes.resolve', 'research.manage'] },
  settlement_officer: { d: 'Settlement officer', p: ['admin.dashboard', 'settlement.propose', 'settlement.approve', 'disputes.resolve', 'research.manage'] },
  finance_officer: { d: 'Finance officer', p: ['admin.dashboard', 'finance.view', 'finance.withdrawals', 'finance.tax'] },
  risk_officer: { d: 'Risk officer', p: ['admin.dashboard', 'risk.view', 'market.suspend', 'users.manage'] },
  administrator: { d: 'Administrator', p: ['admin.dashboard', 'market.review', 'market.house.manage', 'market.suspend', 'settlement.propose', 'settlement.approve', 'finance.view', 'users.manage', 'disputes.resolve', 'audit.view', 'risk.view', 'research.manage'] },
  super_administrator: { d: 'Super administrator', p: Object.keys(PERMISSIONS) },
};

async function seedRbac(c) {
  for (const [code, d] of Object.entries(PERMISSIONS)) await c.q('INSERT INTO permissions(code, description) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [code, d]);
  for (const [name, r] of Object.entries(ROLES)) {
    await c.q('INSERT INTO roles(name, description) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, r.d]);
    for (const p of r.p) {
      await c.q(`INSERT INTO role_permissions(role_id, permission_id)
                 SELECT r.id, p.id FROM roles r, permissions p WHERE r.name=$1 AND p.code=$2 ON CONFLICT DO NOTHING`, [name, p]);
    }
  }
}

function ageYears(dob, now = new Date()) {
  const d = new Date(dob);
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a;
}
const normPhone = (p) => {
  const s = String(p || '').replace(/[\s-]/g, '');
  if (/^(\+?254|0)(7|1)\d{8}$/.test(s)) return '+254' + s.slice(-9);
  throw bad('INVALID_PHONE', 'Enter a valid Kenyan mobile number, e.g. 0712 345 678');
};

async function register(c, { username, email, phone, password, display_name, date_of_birth, accept_terms }) {
  if (!accept_terms) throw bad('TERMS_REQUIRED', 'You must accept the terms and responsible-gambling policy');
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username || '')) throw bad('INVALID_USERNAME', 'Username: 3–24 letters, numbers or underscores');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw bad('INVALID_EMAIL', 'Enter a valid email address');
  const weak = security.passwordProblem(password); if (weak) throw bad('WEAK_PASSWORD', weak);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date_of_birth || '')) throw bad('INVALID_DOB', 'Enter your date of birth');
  if (ageYears(date_of_birth) < 18) throw bad('UNDERAGE', 'PREDICTABLE is for adults aged 18 and above');
  const ph = normPhone(phone);
  const dup = await c.one('SELECT 1 FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($2) OR phone=$3', [username, email, ph]);
  if (dup) throw conflict('ALREADY_REGISTERED', 'Username, email or phone is already registered');
  const hash = await bcrypt.hash(password, 10);
  const u = await c.one(
    `INSERT INTO users(username,email,phone,password_hash,display_name,date_of_birth) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [username, email.toLowerCase(), ph, hash, display_name || username, date_of_birth]);
  await c.q("INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE name='user'", [u.id]);
  await c.q('INSERT INTO responsible_gambling_profiles(user_id) VALUES ($1)', [u.id]);
  await ledger.ensureWallet(c, u.id);
  return u.id;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
// Returns { token, user } | { mfa_required: true } | { fail: AppError }. Failures are RETURNED (not thrown) so the
// failed-attempt record commits instead of rolling back with the request.
async function login(c, { identifier, password, totp: code }, ctx = {}) {
  identifier = String(identifier || '').trim();
  await security.assertNotLocked(c, identifier, ctx.ip);
  const u = await c.one('SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1)', [identifier]);
  const okPw = await bcrypt.compare(password || '', u ? u.password_hash : DUMMY_HASH);   // constant work whether or not the user exists
  if (!u || !okPw) { await security.recordAttempt(c, identifier, ctx.ip, false); return { fail: new AppError(401, 'BAD_CREDENTIALS', 'Incorrect username or password') }; }
  if (u.status !== 'ACTIVE') return { fail: new AppError(403, u.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_INACTIVE', u.status === 'SUSPENDED' ? 'This account is suspended. You can appeal the decision.' : 'This account is not active') };
  if (await security.isMfaEnabled(c, u.id)) {
    if (!code) return { mfa_required: true };
    if (!(await security.consumeTotp(c, u.id, code))) { await security.recordAttempt(c, identifier, ctx.ip, false); return { fail: new AppError(401, 'BAD_CODE', 'That code is wrong or was already used. Wait for the next code and try again.') }; }
  }
  await security.recordAttempt(c, identifier, ctx.ip, true);
  const token = randToken(32);
  await c.q(`INSERT INTO user_sessions(user_id, token_hash, expires_at, ip, user_agent) VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4, $5)`,
    [u.id, sha256(token), String(SESSION_HOURS), ctx.ip || null, String(ctx.ua || '').slice(0, 200)]);
  return { token, user: await publicUser(c, u.id) };
}

async function logout(c, token) { await c.q('DELETE FROM user_sessions WHERE token_hash=$1', [sha256(token)]); }

async function publicUser(c, id) {
  const u = await c.one('SELECT id, username, email, phone, display_name, status, kyc_status, date_of_birth, created_at FROM users WHERE id=$1', [id]);
  if (!u) return null;
  const roles = (await c.q('SELECT r.name FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1', [id])).map((r) => r.name);
  const perms = (await c.q(`SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
                            JOIN permissions p ON p.id=rp.permission_id WHERE ur.user_id=$1`, [id])).map((r) => r.code);
  const mfa = await c.one('SELECT enabled FROM user_mfa WHERE user_id=$1', [id]);
  return { ...u, roles, permissions: perms, mfa_enabled: !!(mfa && mfa.enabled) };
}

async function userFromToken(c, token) {
  if (!token) return null;
  const s = await c.one('SELECT id, user_id, last_seen FROM user_sessions WHERE token_hash=$1 AND expires_at > now()', [sha256(token)]);
  if (!s) return null;
  if (Date.now() - new Date(s.last_seen).getTime() > 300000) await c.q('UPDATE user_sessions SET last_seen=now() WHERE id=$1', [s.id]);
  const u = await publicUser(c, s.user_id);
  return u && u.status === 'ACTIVE' ? u : null;
}

// Simulated identity & age verification (stage one runs on simulated money). In production this
// calls the KYC provider and the user stays PENDING until a signed provider result arrives.
async function simulateKyc(c, userId) {
  const u = await c.one('SELECT date_of_birth, kyc_status FROM users WHERE id=$1', [userId]);
  if (ageYears(u.date_of_birth) < 18) throw bad('UNDERAGE', 'Must be 18+');
  await c.q("UPDATE users SET kyc_status='VERIFIED' WHERE id=$1", [userId]);
  await c.q("INSERT INTO kyc_records(user_id, verification_provider, status, verified_at, notes) VALUES ($1,'SIMULATOR','VERIFIED', now(), 'Simulated verification — stage one')", [userId]);
}

async function changeStaffRole(c, targetId, role, grant) {
  if (!ROLES[role] || role === 'user') throw bad('BAD_ROLE', 'Unknown staff role');
  if (grant) await c.q('INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE name=$2 ON CONFLICT DO NOTHING', [targetId, role]);
  else await c.q('DELETE FROM user_roles WHERE user_id=$1 AND role_id=(SELECT id FROM roles WHERE name=$2)', [targetId, role]);
}

const can = (user, perm) => !!user && user.permissions.includes(perm);

module.exports = { PERMISSIONS, ROLES, seedRbac, register, login, logout, userFromToken, publicUser, simulateKyc, changeStaffRole, can, ageYears };
