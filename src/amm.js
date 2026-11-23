'use strict';
// Constant-product automatic market maker for a binary contract. Integer (BigInt) arithmetic only — no floats touch money.
//
// The pool holds r_yes and r_no outcome tokens, measured in minor units of payout (a token pays 1 minor unit if its
// side wins, so one 100-shilling share = 10,000 tokens). Invariant: r_yes × r_no never decreases.
//   price(YES) = r_no / (r_yes + r_no)         price(NO) = r_yes / (r_yes + r_no)         — they always add to 1.
// Buying y shares: the buyer pays n minor units, which mint n YES + n NO tokens into the pool; the pool then hands
// y×10,000 tokens of the bought side to the buyer, and n is the smallest integer that keeps the invariant.
// Selling is the mirror image: the pool takes the shares, merges n token pairs back into cash, and pays n out.
// Rounding always favours the pool, so repeated trades can only grow the invariant.
const SHARE = 10000n;                 // minor units paid by one winning share (KES 100)
const B = (x) => BigInt(x);

function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

const sides = (pool, side) => (side === 'YES' ? { rS: B(pool.r_yes), rO: B(pool.r_no) } : { rS: B(pool.r_no), rO: B(pool.r_yes) });
const pack = (side, rS, rO) => (side === 'YES' ? { r_yes: Number(rS), r_no: Number(rO) } : { r_yes: Number(rO), r_no: Number(rS) });

// Opening reserves for a pool funded with `subsidy` minor units at prior probability p0 (whole KES 1..99).
// The tokens that do not fit the target price are kept by the platform (held_*), so the pool opens exactly at p0.
function seed(subsidy, p0) {
  const M = B(subsidy), p = B(p0);
  if (p >= 50n) { const rYes = (M * (100n - p)) / p; return { r_yes: Number(rYes), r_no: Number(M), held_yes: Number(M - rYes), held_no: 0 }; }
  const rNo = (M * p) / (100n - p);
  return { r_yes: Number(M), r_no: Number(rNo), held_yes: 0, held_no: Number(M - rNo) };
}

// Marginal price of a side as a fraction num/den (KES = 100 × num/den).
function fraction(pool, side) {
  const den = B(pool.r_yes) + B(pool.r_no);
  return { num: side === 'YES' ? B(pool.r_no) : B(pool.r_yes), den };
}
const priceKes = (pool, side) => { const f = fraction(pool, side); return Number((f.num * 10000n) / f.den) / 100; };   // 2 d.p., for display
// Compare marginal price of `side` with a whole-KES price: returns -1, 0, 1.
function cmp(pool, side, kes) {
  const f = fraction(pool, side), l = f.num * 100n, r = B(kes) * f.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

// Cost in minor units to buy `shares` of `side`, and the reserves afterwards.
function quoteBuy(pool, side, shares) {
  const { rS, rO } = sides(pool, side);
  const k = rS * rO, Y = B(shares) * SHARE;
  const a = rS - Y, b = rO;
  const D = (a - b) * (a - b) + 4n * k;
  const s = isqrt(D);
  let n = (s - (a + b)) / 2n - 2n;
  if (n < 0n) n = 0n;
  const need = 1n - a;                                   // the pool must keep at least one token of the bought side
  if (n < need) n = need > 0n ? need : n;
  while ((a + n) < 1n || (a + n) * (b + n) < k) n += 1n;
  return { cost_minor: Number(n), after: pack(side, a + n, b + n) };
}

// Proceeds in minor units for selling `shares` of `side` to the pool, and the reserves afterwards.
function quoteSell(pool, side, shares) {
  const { rS, rO } = sides(pool, side);
  const k = rS * rO, Y = B(shares) * SHARE;
  const a = rS + Y, b = rO;
  const D = (a - b) * (a - b) + 4n * k;
  const s = isqrt(D);
  let n = ((a + b) - s) / 2n + 2n;
  const cap = (a < b ? a : b) - 1n;
  if (n > cap) n = cap;
  while (n > 0n && (a - n) * (b - n) < k) n -= 1n;
  if (n < 0n) n = 0n;
  return { proceeds_minor: Number(n), after: pack(side, a - n, b - n) };
}

// Largest number of shares (≤ maxShares) the pool can sell while the buyer's side stays at or below `boundaryKes`.
// Always allows one share when the pool's current price is within the boundary and that share is affordable at it.
function maxBuyChunk(pool, side, maxShares, boundaryKes) {
  if (cmp(pool, side, boundaryKes) > 0) return 0;
  const ok = (y) => { const q = quoteBuy(pool, side, y); return cmpAfter(q.after, side, boundaryKes) <= 0; };
  let lo = 0, hi = maxShares;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; }
  if (lo === 0) { const q = quoteBuy(pool, side, 1); if (q.cost_minor <= boundaryKes * 100) lo = 1; }
  return lo;
}
// Largest number of shares the pool can buy while the seller's side stays at or above `boundaryKes`.
function maxSellChunk(pool, side, maxShares, boundaryKes) {
  if (cmp(pool, side, boundaryKes) < 0) return 0;
  const ok = (y) => { const q = quoteSell(pool, side, y); return q.proceeds_minor > 0 && cmpAfter(q.after, side, boundaryKes) >= 0; };
  let lo = 0, hi = maxShares;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; }
  if (lo === 0) { const q = quoteSell(pool, side, 1); if (q.proceeds_minor > 0 && q.proceeds_minor >= boundaryKes * 100) lo = 1; }
  return lo;
}
const cmpAfter = (after, side, kes) => cmp(after, side, kes);

// Worst-case loss for the platform on a pool: everything it put in, because the winning side could drain the pool.
const maxLoss = (pool) => pool.subsidy_minor;

module.exports = { SHARE, seed, fraction, priceKes, cmp, quoteBuy, quoteSell, maxBuyChunk, maxSellChunk, maxLoss, isqrt };
