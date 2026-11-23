'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const totp = require('./totp');
const sms = require('./sms');
const { AppError, bad, forbidden, conflict, notFound, sha256, persistFail } = require('./util');
const { getInt, getSetting, audit, notify } = require('./common');

// ───────────── Rate limiting (in-memory; use a shared store such as Redis when running several instances) ─────────────
function rateLimit({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => { const cut = Date.now() - windowMs; for (const [k, v] of hits) if (v[v.length - 1] < cut) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip || 'unknown', now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => t > now - windowMs);
    arr.push(now); hits.set(key, arr);
    if (arr.length > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' } });
    }
    next();
  };
}

// ───────────── Login lockout ─────────────
async function assertNotLocked(c, identifier, ip) {
  const maxF = await getInt(c, 'login_max_failures'), mins = await getInt(c, 'lockout_minutes');
  const byId = await c.one(`SELECT COUNT(*)::int n FROM login_attempts
      WHERE lower(identifier)=lower($1) AND success=false AND created_at > now() - ($2 || ' minutes')::interval
        AND created_at > COALESCE((SELECT MAX(created_at) FROM login_attempts WHERE lower(identifier)=lower($1) AND success=true), 'epoch'::timestamptz)`, [identifier, String(mins)]);
  if (byId.n >= maxF) throw new AppError(429, 'ACCOUNT_LOCKED', `Too many failed sign-in attempts. Try again in ${mins} minutes.`);
  if (ip) {
    const byIp = await c.one("SELECT COUNT(*)::int n FROM login_attempts WHERE ip=$1 AND success=false AND created_at > now() - ($2 || ' minutes')::interval", [ip, String(mins)]);
    if (byIp.n >= maxF * 4) throw new AppError(429, 'IP_LOCKED', 'Too many failed attempts from this network. Try again later.');
  }
}
const recordAttempt = (c, identifier, ip, success) => c.q('INSERT INTO login_attempts(identifier, ip, success) VALUES ($1,$2,$3)', [String(identifier || '').slice(0, 120), ip || null, success]);

// ───────────── MFA (TOTP) ─────────────
async function mfaState(c, userId) { return c.one('SELECT * FROM user_mfa WHERE user_id=$1', [userId]); }
async function isMfaEnabled(c, userId) { const m = await mfaState(c, userId); return !!(m && m.enabled); }

// Verifies a code and burns its time step so it cannot be replayed.
async function consumeTotp(c, userId, code) {
  const m = await c.one('SELECT * FROM user_mfa WHERE user_id=$1 FOR UPDATE', [userId]);
  if (!m) return false;
  const step = totp.verify(totp.open(m.secret_sealed), code);
  if (step == null || step <= Number(m.last_used_step)) return false;
  await c.q('UPDATE user_mfa SET last_used_step=$2 WHERE user_id=$1', [userId, step]);
  return true;
}
async function setupMfa(c, user) {
  if (await isMfaEnabled(c, user.id)) throw conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on');
  const secret = totp.newSecret();
  await c.q(`INSERT INTO user_mfa(user_id, secret_sealed, enabled) VALUES ($1,$2,false)
             ON CONFLICT (user_id) DO UPDATE SET secret_sealed=$2, enabled=false, last_used_step=0`, [user.id, totp.seal(secret)]);
  const uri = totp.otpauth(secret, user.email);
  const QR = require('qrcode');
  return { secret, otpauth: uri, qr_svg: await QR.toString(uri, { type: 'svg', margin: 1, width: 180 }) };
}
async function enableMfa(c, user, code) {
  const m = await mfaState(c, user.id);
  if (!m) throw bad('MFA_NOT_STARTED', 'Start setup first');
  if (m.enabled) throw conflict('MFA_ALREADY_ENABLED', 'Two-step verification is already on');
  if (!(await consumeTotp(c, user.id, code))) throw bad('BAD_CODE', 'That code is not right. Check the 6-digit code in your authenticator app.');
  await c.q('UPDATE user_mfa SET enabled=true WHERE user_id=$1', [user.id]);
  await audit(c, user.id, 'mfa.enable', 'user', user.id);
}
async function disableMfa(c, user, code) {
  if (await getSetting(c, 'require_staff_mfa') === '1' && user.permissions.includes('admin.dashboard')) throw forbidden('Staff accounts must keep two-step verification on', 'MFA_REQUIRED_FOR_STAFF');
  if (!(await guessGuard(c, `stepup:${user.id}`, () => consumeTotp(c, user.id, code)))) throw persistFail(bad('BAD_CODE', 'That code is not right.'));
  await c.q('DELETE FROM user_mfa WHERE user_id=$1', [user.id]);
  await audit(c, user.id, 'mfa.disable', 'user', user.id);
}

// Sensitive staff actions (approving settlements, paying withdrawals, changing roles) need a fresh authenticator code.
// Counts wrong codes under a per-user key so guessing a 6-digit code is locked out like password guessing.
async function guessGuard(c, key, check) {
  await assertNotLocked(c, key, null);
  const ok = await check();
  await recordAttempt(c, key, null, ok);
  return ok;
}
async function requireStaffStepUp(c, user, code) {
  if (await getSetting(c, 'require_staff_mfa') !== '1') return;
  if (!(await isMfaEnabled(c, user.id))) throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Turn on two-step verification before using this action');
  if (!code) throw new AppError(403, 'STEP_UP_REQUIRED', 'Enter the 6-digit code from your authenticator app');
  if (!(await guessGuard(c, `stepup:${user.id}`, () => consumeTotp(c, user.id, code)))) throw persistFail(new AppError(403, 'STEP_UP_FAILED', 'That code is wrong or was already used. Wait for the next code and try again.'));
}
// Staff must be enrolled before they can use the admin API at all.
async function assertStaffEnrolled(c, user) {
  if (await getSetting(c, 'require_staff_mfa') !== '1') return;
  if (!(await isMfaEnabled(c, user.id))) throw new AppError(403, 'MFA_ENROLLMENT_REQUIRED', 'Staff accounts must turn on two-step verification before using the console');
}

// ───────────── One-time codes for users (SMS) ─────────────
async function issueOtp(c, user, purpose) {
  const recent = await c.one("SELECT COUNT(*)::int n FROM step_up_codes WHERE user_id=$1 AND created_at > now() - interval '10 minutes'", [user.id]);
  if (recent.n >= 5) throw new AppError(429, 'OTP_RATE_LIMIT', 'Too many codes requested. Wait a few minutes.');
  await c.q('UPDATE step_up_codes SET used_at=now() WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL', [user.id, purpose]);
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const ttl = await getInt(c, 'otp_ttl_minutes');
  await c.q("INSERT INTO step_up_codes(user_id, purpose, code_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)", [user.id, purpose, sha256(`${user.id}:${purpose}:${code}`), String(ttl)]);
  await sms.send(c, user, `Your Predictable code is ${code}. It expires in ${ttl} minutes. Never share it.`);
  return { sent: true, expires_in_minutes: ttl };
}
async function consumeOtp(c, user, purpose, code) {
  const row = await c.one('SELECT * FROM step_up_codes WHERE user_id=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1 FOR UPDATE', [user.id, purpose]);
  if (!row) throw new AppError(403, 'OTP_REQUIRED', 'Request a verification code first');
  if (row.attempts >= 5) { await c.q('UPDATE step_up_codes SET used_at=now() WHERE id=$1', [row.id]); throw persistFail(new AppError(403, 'OTP_LOCKED', 'Too many wrong codes. Request a new one.')); }
  const a = Buffer.from(sha256(`${user.id}:${purpose}:${String(code || '').trim()}`)), b = Buffer.from(row.code_hash);
  if (!crypto.timingSafeEqual(a, b)) { await c.q('UPDATE step_up_codes SET attempts=attempts+1 WHERE id=$1', [row.id]); throw persistFail(new AppError(403, 'OTP_INVALID', 'That code is not right')); }
  await c.q('UPDATE step_up_codes SET used_at=now() WHERE id=$1', [row.id]);
}

// ───────────── Tamper-evident audit chain ─────────────
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const rowHash = (prev, r) => sha256(stable([prev, Number(r.id), r.actor_id == null ? null : Number(r.actor_id), r.action, r.entity_type, r.entity_id == null ? null : Number(r.entity_id), r.details, new Date(r.created_at).toISOString()]));
async function sealAudit(c) {
  await c.q('SELECT pg_advisory_xact_lock(727002)');
  const last = await c.one('SELECT seq, hash FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1');
  const rows = await c.q('SELECT * FROM audit_logs WHERE seq IS NULL ORDER BY id LIMIT 2000');
  let prev = last ? last.hash : 'GENESIS', seq = last ? Number(last.seq) : 0;
  for (const r of rows) {
    seq++; const h = rowHash(prev, r);
    await c.q('UPDATE audit_logs SET seq=$1, prev_hash=$2, hash=$3 WHERE id=$4', [seq, prev, h, r.id]);
    prev = h;
  }
  return rows.length;
}
async function verifyAudit(c) {
  await sealAudit(c);
  const rows = await c.q('SELECT * FROM audit_logs WHERE seq IS NOT NULL ORDER BY seq');
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== rowHash(prev, r)) return { ok: false, sealed: rows.length, first_break_seq: Number(r.seq), first_break_id: Number(r.id) };
    prev = r.hash;
  }
  const un = await c.one('SELECT COUNT(*)::int n FROM audit_logs WHERE seq IS NULL');
  return { ok: true, sealed: rows.length, unsealed: un.n, head: prev };
}

// ───────────── Sessions & passwords ─────────────
async function listSessions(c, userId, tokenHash) {
  const rows = await c.q('SELECT id, ip, user_agent, created_at, last_seen, expires_at, token_hash FROM user_sessions WHERE user_id=$1 AND expires_at > now() ORDER BY id DESC', [userId]);
  return rows.map(({ token_hash, ...r }) => ({ ...r, current: token_hash === tokenHash }));
}
async function revokeSession(c, userId, sessionId) { await c.q('DELETE FROM user_sessions WHERE id=$1 AND user_id=$2', [sessionId, userId]); }
async function changePassword(c, userId, tokenHash, current, next) {
  const u = await c.one('SELECT password_hash FROM users WHERE id=$1', [userId]);
  await assertNotLocked(c, `pwchange:${userId}`, null);
  const okPw = await bcrypt.compare(current || '', u.password_hash);
  await recordAttempt(c, `pwchange:${userId}`, null, okPw);
  if (!okPw) throw persistFail(new AppError(403, 'BAD_PASSWORD', 'Your current password is not right'));
  const weak = passwordProblem(next); if (weak) throw bad('WEAK_PASSWORD', weak);
  await c.q('UPDATE users SET password_hash=$2 WHERE id=$1', [userId, await bcrypt.hash(next, 10)]);
  await c.q('DELETE FROM user_sessions WHERE user_id=$1 AND token_hash <> $2', [userId, tokenHash]);
  await audit(c, userId, 'password.change', 'user', userId);
}
function passwordProblem(p) {
  if (!p || p.length < 8) return 'Password must be at least 8 characters';
  if (/^(password|12345678|qwerty|letmein|admin)\d*$/i.test(p)) return 'That password is too easy to guess';
  if (!/[a-zA-Z]/.test(p) || !/\d/.test(p)) return 'Use letters and at least one number';
  return null;
}

// ───────────── Appeals against account restrictions ─────────────
async function submitAppeal(c, userId, message) {
  const u = await c.one('SELECT status FROM users WHERE id=$1', [userId]);
  if (u.status !== 'SUSPENDED') throw conflict('NOT_SUSPENDED', 'Only suspended accounts can appeal');
  if (!message || message.trim().length < 10) throw bad('MESSAGE_REQUIRED', 'Tell us why the suspension should be lifted (at least 10 characters)');
  if (await c.one("SELECT 1 FROM appeals WHERE user_id=$1 AND status='OPEN'", [userId])) throw conflict('APPEAL_OPEN', 'You already have an appeal under review');
  const a = await c.one('INSERT INTO appeals(user_id, message) VALUES ($1,$2) RETURNING id', [userId, message.trim().slice(0, 2000)]);
  await audit(c, userId, 'appeal.submit', 'appeal', a.id);
  return a;
}
async function decideAppeal(c, actor, id, decision, note) {
  const a = await c.one('SELECT * FROM appeals WHERE id=$1 FOR UPDATE', [id]);
  if (!a) throw notFound('Appeal not found');
  if (a.status !== 'OPEN') throw conflict('ALREADY_PROCESSED', 'Appeal already decided');
  if (a.user_id === actor.id) throw forbidden('You cannot decide your own appeal', 'SELF_ACTION');
  if (!note || note.trim().length < 5) throw bad('NOTE_REQUIRED', 'Write a short explanation for the player');
  const status = decision === 'REINSTATE' ? 'REINSTATED' : 'UPHELD';
  await c.q('UPDATE appeals SET status=$2, reviewed_by=$3, decision_note=$4, reviewed_at=now() WHERE id=$1', [id, status, actor.id, note.trim()]);
  if (status === 'REINSTATED') await c.q("UPDATE users SET status='ACTIVE' WHERE id=$1", [a.user_id]);
  await audit(c, actor.id, 'appeal.decide', 'appeal', id, { status });
  return { status };
}

module.exports = { rateLimit, assertNotLocked, recordAttempt, mfaState, isMfaEnabled, consumeTotp, setupMfa, enableMfa, disableMfa, requireStaffStepUp, assertStaffEnrolled, issueOtp, consumeOtp, sealAudit, verifyAudit, listSessions, revokeSession, changePassword, passwordProblem, submitAppeal, decideAppeal };
