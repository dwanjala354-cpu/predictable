'use strict';
// RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits) with no third-party code, plus sealing of stored secrets.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); }
  const bytes = []; for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
const newSecret = () => b32encode(crypto.randomBytes(20));

function hotp(secretB32, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
const stepOf = (ms = Date.now()) => Math.floor(ms / 30000);
const code = (secret, ms = Date.now()) => hotp(secret, stepOf(ms));

// Returns the matching time step (so the caller can enforce single use), or null. ±1 step tolerates clock drift.
function verify(secret, supplied, ms = Date.now()) {
  const s = String(supplied || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(s)) return null;
  const now = stepOf(ms);
  for (const d of [0, -1, 1]) {
    const a = Buffer.from(hotp(secret, now + d)), b = Buffer.from(s);
    if (crypto.timingSafeEqual(a, b)) return now + d;
  }
  return null;
}
const otpauth = (secret, account, issuer = 'Predictable') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// AES-256-GCM sealing for secrets at rest. The key comes from PREDICTABLE_SECRET_KEY (set a long random value in production).
const key = () => crypto.createHash('sha256').update(process.env.PREDICTABLE_SECRET_KEY || 'dev-only-secret-key-change-me').digest();
function seal(plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = sealed.split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { newSecret, code, verify, stepOf, otpauth, seal, open, b32encode, b32decode, hotp };
