'use strict';
const crypto = require('crypto');

class AppError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
// Mark an error so the request wrapper COMMITS the transaction before returning it (used to keep failed-attempt counters).
const persistFail = (e) => { e.commit = true; return e; };
const bad = (code, msg, extra) => new AppError(400, code, msg, extra);
const forbidden = (msg = 'You do not have permission to do that', code = 'FORBIDDEN') => new AppError(403, code, msg);
const notFound = (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg);
const conflict = (code, msg, extra) => new AppError(409, code, msg, extra);

// ─────────── Money: integer minor units only ───────────
function toMinor(kes) {
  // Accepts "1000", "1000.50", 1000.5; rejects anything with >2 decimals.
  const s = String(kes).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad('INVALID_AMOUNT', 'Amount must be a positive number with at most 2 decimals');
  const [w, f = ''] = s.split('.');
  const minor = parseInt(w, 10) * 100 + parseInt((f + '00').slice(0, 2), 10);
  if (!Number.isSafeInteger(minor)) throw bad('INVALID_AMOUNT', 'Amount too large');
  return minor;
}
function fmtKES(minor) {
  const neg = minor < 0 ? '-' : '';
  const a = Math.abs(minor);
  const w = Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = String(a % 100).padStart(2, '0');
  return `${neg}KES ${w}${f === '00' ? '' : '.' + f}`;
}

// Gross house payout. Stake is included. Rounded DOWN to the minor unit (house-favourable, deterministic).
function houseGrossPayout(stakeMinor, oddsMilli) {
  return Math.floor((stakeMinor * oddsMilli) / 1000);
}

// Deterministic largest-remainder allocation: splits `total` across `weights` so the parts sum EXACTLY
// to `total`. Leftover minor units go to the largest fractional remainders; ties go to the lowest key.
// This is the explicit residual-cent rule for P2P settlement.
function allocate(total, items) {
  // items: [{ key, weight }]  (weight > 0, integers)
  const sumW = items.reduce((s, i) => s + i.weight, 0);
  if (sumW <= 0) throw new Error('allocate: zero total weight');
  const base = items.map((i) => {
    const num = BigInt(total) * BigInt(i.weight);
    return { key: i.key, floor: Number(num / BigInt(sumW)), rem: Number(num % BigInt(sumW)) };
  });
  let left = total - base.reduce((s, b) => s + b.floor, 0);
  const order = [...base].sort((a, b) => b.rem - a.rem || (a.key < b.key ? -1 : 1));
  for (let i = 0; left > 0; i++, left--) order[i % order.length].floor += 1;
  return new Map(base.map((b) => [b.key, b.floor]));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randToken = (n = 32) => crypto.randomBytes(n).toString('hex');

module.exports = { persistFail, AppError, bad, forbidden, notFound, conflict, toMinor, fmtKES, houseGrossPayout, allocate, sha256, randToken };
