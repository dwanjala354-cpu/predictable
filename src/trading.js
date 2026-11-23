'use strict';
// Trading engine for binary KES contracts.
//
//   • One contract pays KES 100 if its side wins, KES 0 otherwise. A price of KES 1–99 is the market's probability in percent.
//   • Everything is expressed on a single order book of YES prices. Buying NO at q is the same as offering YES at 100−q;
//     selling NO at q is the same as bidding YES at 100−q. That is what lets a YES buyer and a NO buyer create new contracts.
//   • Four kinds of match, all executed at the RESTING order's price:
//       BUY YES × SELL YES  → TRANSFER_YES   shares change hands
//       BUY YES × BUY NO    → MINT           both pay, KES 100 per pair moves into escrow, a YES and a NO share are created
//       SELL NO × SELL YES  → MERGE          escrow releases KES 100 per pair, both shares are destroyed
//       SELL NO × BUY NO    → TRANSFER_NO    shares change hands
//   • An optional platform-funded AMM quotes against the book. An order takes whichever source is cheaper, chunk by chunk.
//   • Cash for a buy order is reserved when it is placed, so a resting order can never fail for lack of funds.
//     Shares for a sell order are locked, so nothing can be sold twice.
//   • No money is created or lost: every trade is ONE balanced ledger transaction, and the escrow pool always equals
//     KES 100 × outstanding pairs (including the AMM's tokens).
const ledger = require('./ledger');
const amm = require('./amm');
const tax = require('./tax');
const wallet = require('./wallet');
const { bad, forbidden, notFound, conflict } = require('./util');
const { getInt, audit, notify } = require('./common');
const { can } = require('./auth');

const SHARE = 10000;                      // minor units paid by one winning contract (KES 100)
const KES = 100;                          // minor units per shilling

class Lines {                             // collects ledger lines, merging duplicates, ignoring zeros
  constructor() { this.m = new Map(); }
  add(acct, direction, amount) {
    if (!amount) return;
    const key = acct.id + direction;
    const cur = this.m.get(key);
    if (cur) cur.amount += amount; else this.m.set(key, { account: acct, direction, amount });
  }
  list() { return [...this.m.values()]; }
}

const sys = async (c, t) => ledger.systemAccount(c, t);

async function getPos(c, marketId, userId, lock = true) {
  await c.q('INSERT INTO positions(market_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [marketId, userId]);
  return c.one(`SELECT * FROM positions WHERE market_id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [marketId, userId]);
}

// Mapping of a user's intent onto the YES book.
function bookFields(action, asset, limit) {
  const bookSide = (action === 'BUY') === (asset === 'YES') ? 'BID' : 'ASK';
  return { bookSide, priceYes: asset === 'YES' ? limit : 100 - limit };
}

// ───────────── order lifecycle ─────────────
async function release(c, o, status, reason) {
  const remaining = o.qty - o.filled;
  if (o.action === 'BUY' && o.reserved_minor > 0) {
    const a = await ledger.userAccounts(c, o.user_id);
    await ledger.post(c, { reference: `ord:${o.id}:release`, type: 'ORDER_RELEASE', description: `Order #${o.id} ${status.toLowerCase()} — reserve returned`, marketId: o.market_id,
      lines: [{ account: a.RESERVED_ORDERS, direction: 'DEBIT', amount: o.reserved_minor }, { account: a.AVAILABLE, direction: 'CREDIT', amount: o.reserved_minor }] });
  }
  if (o.action === 'SELL' && remaining > 0) {
    const col = o.asset === 'YES' ? 'yes_locked' : 'no_locked';
    await c.q(`UPDATE positions SET ${col} = ${col} - $3, updated_at=now() WHERE market_id=$1 AND user_id=$2`, [o.market_id, o.user_id, remaining]);
  }
  await c.q("UPDATE orders SET status=$2, reserved_minor=0, cancel_reason=$3, updated_at=now() WHERE id=$1", [o.id, status, reason || null]);
}

async function cancelOrder(c, user, orderId, reason = 'Cancelled by you') {
  const o = await c.one('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!o || (o.user_id !== user.id && !can(user, 'market.suspend'))) throw notFound('Order not found');
  if (o.status !== 'OPEN') throw conflict('NOT_OPEN', `Order is already ${o.status.toLowerCase()}`);
  await release(c, o, 'CANCELLED', o.user_id === user.id ? reason : `Cancelled by staff (${user.username})`);
  return { id: o.id, status: 'CANCELLED' };
}

// Used when trading stops (market locked / voided / settled): every resting order is cancelled and every reserve returned.
async function cancelAllForMarket(c, marketId, reason) {
  const open = await c.q("SELECT * FROM orders WHERE market_id=$1 AND status='OPEN' ORDER BY id FOR UPDATE", [marketId]);
  for (const o of open) await release(c, o, 'CANCELLED', reason);
  return open.length;
}

// ───────────── placing and matching ─────────────
async function placeOrder(c, user, marketId, input, opts = {}) {
  if (!can(user, 'market.bet')) throw forbidden();
  const action = String(input.action || '').toUpperCase(), asset = String(input.asset || '').toUpperCase();
  const tif = String(input.tif || 'GTC').toUpperCase();
  const limit = Number(input.limit_kes), qty = Number(input.qty);
  if (!['BUY', 'SELL'].includes(action)) throw bad('BAD_ACTION', 'Choose Buy or Sell');
  if (!['YES', 'NO'].includes(asset)) throw bad('BAD_ASSET', 'Choose Yes or No');
  if (!['GTC', 'IOC'].includes(tif)) throw bad('BAD_TIF', 'Order type must be GTC or IOC');
  if (!Number.isInteger(limit) || limit < 1 || limit > 99) throw bad('BAD_PRICE', 'Price must be a whole number of shillings from 1 to 99');
  const minQ = await getInt(c, 'min_order_shares'), maxQ = await getInt(c, 'max_order_shares');
  if (!Number.isSafeInteger(qty) || qty < minQ || qty > maxQ) throw bad('BAD_QUANTITY', `Quantity must be between ${minQ} and ${maxQ} contracts`);

  const m = await c.one('SELECT * FROM markets WHERE id=$1 FOR UPDATE', [marketId]);
  if (!m) throw notFound('Market not found');
  if (m.status !== 'OPEN' || new Date(m.closes_at) <= new Date()) throw conflict('MARKET_NOT_OPEN', 'Trading is not open on this market');
  if (m.creator_id === user.id) throw forbidden('You cannot trade a market you created', 'CREATOR_CANNOT_TRADE');
  await wallet.assertCanTransact(c, user.id);

  const pos = await getPos(c, marketId, user.id);
  const open = (await c.one("SELECT COUNT(*)::int n FROM orders WHERE market_id=$1 AND user_id=$2 AND status='OPEN'", [marketId, user.id])).n;
  if (open >= await getInt(c, 'max_open_orders')) throw conflict('TOO_MANY_ORDERS', 'You have too many open orders on this market — cancel some first');
  if (action === 'BUY') {
    const cap = await getInt(c, 'max_position_shares');
    if (pos[asset.toLowerCase() + '_shares'] + qty > cap) throw bad('POSITION_LIMIT', `A single position is limited to ${cap} contracts per side`);
  } else {
    const have = pos[asset.toLowerCase() + '_shares'] - pos[asset.toLowerCase() + '_locked'];
    if (have < qty) throw conflict('INSUFFICIENT_SHARES', `You only have ${Math.max(0, have)} ${asset} contracts available to sell`);
  }

  const { bookSide, priceYes } = bookFields(action, asset, limit);
  let order = await c.one(
    `INSERT INTO orders(market_id, user_id, action, asset, book_side, price_kes, limit_kes, qty, tif) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [marketId, user.id, action, asset, bookSide, priceYes, limit, qty, tif]);
  if (action === 'BUY') {
    const reserve = qty * limit * KES;
    const a = await ledger.userAccounts(c, user.id);
    await ledger.post(c, { reference: `ord:${order.id}:reserve`, type: 'ORDER_RESERVE', description: `Reserve for order #${order.id}`, marketId, createdBy: user.id,
      lines: [{ account: a.AVAILABLE, direction: 'DEBIT', amount: reserve }, { account: a.RESERVED_ORDERS, direction: 'CREDIT', amount: reserve }] });
    order = await c.one('UPDATE orders SET reserved_minor=$2 WHERE id=$1 RETURNING *', [order.id, reserve]);
  } else {
    const col = asset === 'YES' ? 'yes_locked' : 'no_locked';
    await c.q(`UPDATE positions SET ${col} = ${col} + $3, updated_at=now() WHERE market_id=$1 AND user_id=$2`, [marketId, user.id, qty]);
  }

  const ctx = { m, rates: await tax.rates(c), pool: await c.one('SELECT * FROM amm_pools WHERE market_id=$1 AND enabled FOR UPDATE', [marketId]), fills: [] };
  await match(c, ctx, order);
  order = await c.one('SELECT * FROM orders WHERE id=$1', [order.id]);
  if (order.status === 'OPEN' && tif === 'IOC') { await release(c, order, 'CANCELLED', 'Unfilled part of an immediate order'); order = await c.one('SELECT * FROM orders WHERE id=$1', [order.id]); }
  if (!opts.dry) await refreshPrice(c, m.id);

  const got = ctx.fills.reduce((s, f) => s + f.qty, 0), cash = ctx.fills.reduce((s, f) => s + f.amount_minor, 0);
  const sum = (k) => ctx.fills.reduce((s, f) => s + (f[k] || 0), 0);
  return {
    order_id: order.id, status: order.status, filled: got, remaining: order.qty - order.filled, resting: order.status === 'OPEN',
    avg_price_kes: got ? Math.round((cash / (got * KES)) * 100) / 100 : null, gross_minor: cash,
    tax_minor: sum('tax_minor'), commission_minor: sum('fee_minor'), net_minor: sum('net_minor'),
    fills: ctx.fills,
  };
}

async function bestOpposite(c, order) {
  const sql = order.book_side === 'BID'
    ? "SELECT * FROM orders WHERE market_id=$1 AND book_side='ASK' AND status='OPEN' AND price_kes <= $2 ORDER BY price_kes ASC, id ASC LIMIT 1 FOR UPDATE"
    : "SELECT * FROM orders WHERE market_id=$1 AND book_side='BID' AND status='OPEN' AND price_kes >= $2 ORDER BY price_kes DESC, id ASC LIMIT 1 FOR UPDATE";
  return c.one(sql, [order.market_id, order.price_kes]);
}

async function match(c, ctx, order) {
  for (let guard = 0; guard < 2000; guard++) {
    const fresh = await c.one('SELECT * FROM orders WHERE id=$1', [order.id]);
    const rem = fresh.qty - fresh.filled;
    if (fresh.status !== 'OPEN' || rem <= 0) return;
    let best = await bestOpposite(c, fresh);
    while (best && best.user_id === fresh.user_id) {            // never trade with yourself: the older resting order is cancelled
      await release(c, best, 'CANCELLED', 'Cancelled to prevent trading with yourself');
      best = await bestOpposite(c, fresh);
    }
    const pool = ctx.pool;
    const L = fresh.limit_kes, a = fresh.asset;
    const bestAsset = best ? (a === 'YES' ? best.price_kes : 100 - best.price_kes) : null;   // book price in the taker's own asset terms
    let chunk = 0, useAmm = false;
    if (pool) {
      if (fresh.action === 'BUY' && amm.cmp(pool, a, L) <= 0 && (!best || amm.cmp(pool, a, bestAsset) < 0)) {
        chunk = amm.maxBuyChunk(pool, a, rem, best ? Math.min(L, bestAsset) : L);
      } else if (fresh.action === 'SELL' && amm.cmp(pool, a, L) >= 0 && (!best || amm.cmp(pool, a, bestAsset) > 0)) {
        chunk = amm.maxSellChunk(pool, a, rem, best ? Math.max(L, bestAsset) : L);
      }
      useAmm = chunk > 0;
    }
    if (useAmm) { if (!(await fillAmm(c, ctx, fresh, chunk))) { if (!best) return; await fillBook(c, ctx, fresh, best); } }
    else if (best) await fillBook(c, ctx, fresh, best);
    else return;
  }
}

// How much of a sale is taxable: profit over cost basis, if the rule applies to early sales.
function exitSplit(ctx, proceeds, costRemoved) {
  if (!ctx.rates.taxOnExit) return { gross: proceeds, cost: costRemoved, profit: Math.max(0, proceeds - costRemoved), tax: 0, fee: 0, net: proceeds };
  return tax.profitSplit(proceeds, costRemoved, ctx.rates);
}

// Remove `q` shares from a seller and return the cost basis that goes with them (exact on the last share).
async function costOf(c, marketId, userId, asset, q) {
  const p = await c.one('SELECT * FROM positions WHERE market_id=$1 AND user_id=$2', [marketId, userId]);
  const sh = p[asset.toLowerCase() + '_shares'], cost = p[asset.toLowerCase() + '_cost_minor'];
  return q === sh ? cost : Number((BigInt(cost) * BigInt(q)) / BigInt(sh));
}

/**
 * Settle one match. `legs` is every participant: { order, user_id, role: 'BUY'|'SELL', asset, qty, amount }, where amount is the
 * gross cash the leg pays (BUY) or receives (SELL). Posts one balanced ledger transaction and updates orders, positions,
 * escrow and the tax records.
 */
async function execute(c, ctx, { kind, price_kes, legs, taker, bidOrder = null, askOrder = null, bidUser = null, askUser = null, ammAfter = null }) {
  const m = ctx.m;
  const qty = legs[0].qty;
  const amountIn = legs.filter((l) => l.role === 'BUY').reduce((s, l) => s + l.amount, 0);
  const amountOut = legs.filter((l) => l.role === 'SELL').reduce((s, l) => s + l.amount, 0);
  const escrowDelta = amountIn - amountOut;

  const trade = await c.one(
    `INSERT INTO trades(market_id, kind, price_kes, qty, amount_minor, bid_order_id, ask_order_id, taker_order_id, bid_user_id, ask_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [m.id, kind, price_kes, qty, Math.max(amountIn, amountOut), bidOrder && bidOrder.id, askOrder && askOrder.id, taker.id, bidUser, askUser]);
  const ref = `trade:${trade.id}`;
  const lines = new Lines(), escrow = await sys(c, 'SYS_ESCROW');
  const kra = await sys(c, 'SYS_KRA_TAX_PAYABLE'), rev = await sys(c, 'SYS_PLATFORM_REVENUE');
  const out = [];
  let totTax = 0, totFee = 0, totNet = 0;

  for (const l of legs) {
    const acct = await ledger.userAccounts(c, l.user_id);
    const col = l.asset.toLowerCase();
    if (l.role === 'BUY') {
      const used = l.order.limit_kes * l.qty * KES;                               // what was reserved for these shares
      lines.add(acct.RESERVED_ORDERS, 'DEBIT', used);
      lines.add(acct.AVAILABLE, 'CREDIT', used - l.amount);                       // price improvement goes straight back
      await c.q(`UPDATE positions SET ${col}_shares = ${col}_shares + $3, ${col}_cost_minor = ${col}_cost_minor + $4, updated_at=now() WHERE market_id=$1 AND user_id=$2`, [m.id, l.user_id, l.qty, l.amount]);
      await c.q('UPDATE orders SET reserved_minor = reserved_minor - $2 WHERE id=$1', [l.order.id, used]);
      l.result = { tax: 0, fee: 0, net: l.amount };
    } else {
      const cost = await costOf(c, m.id, l.user_id, l.asset, l.qty);
      const s = exitSplit(ctx, l.amount, cost);
      lines.add(acct.AVAILABLE, 'CREDIT', s.net);
      lines.add(kra, 'CREDIT', s.tax);
      lines.add(rev, 'CREDIT', s.fee);
      await c.q(`UPDATE positions SET ${col}_shares = ${col}_shares - $3, ${col}_locked = ${col}_locked - $3, ${col}_cost_minor = ${col}_cost_minor - $4,
                 realized_pnl_minor = realized_pnl_minor + $5, updated_at=now() WHERE market_id=$1 AND user_id=$2`, [m.id, l.user_id, l.qty, cost, s.net - cost]);
      totTax += s.tax; totFee += s.fee; totNet += s.net;
      l.result = s;
    }
    if (l.order) {
      await c.q("UPDATE orders SET filled = filled + $2, status = CASE WHEN filled + $2 >= qty THEN 'FILLED' ELSE status END, updated_at=now() WHERE id=$1", [l.order.id, l.qty]);
    }
  }
  if (escrowDelta > 0) lines.add(escrow, 'CREDIT', escrowDelta); else if (escrowDelta < 0) lines.add(escrow, 'DEBIT', -escrowDelta);
  await ledger.post(c, { reference: ref, type: 'TRADE', description: `${kind} ${qty} @ ${price_kes} on market #${m.id}`, marketId: m.id,
    split: amountOut ? { gross: amountOut, tax: totTax, fee: totFee, net: totNet } : null, lines: lines.list() });
  await c.q('UPDATE trades SET ledger_reference=$2 WHERE id=$1', [trade.id, ref]);
  if (escrowDelta) {
    await c.q('INSERT INTO escrow_pools(market_id, locked_minor) VALUES ($1,0) ON CONFLICT DO NOTHING', [m.id]);
    await c.q('UPDATE escrow_pools SET locked_minor = locked_minor + $2, updated_at=now() WHERE market_id=$1', [m.id, escrowDelta]);
  }
  if (ammAfter) {
    await c.q('UPDATE amm_pools SET r_yes=$2, r_no=$3 WHERE market_id=$1', [m.id, ammAfter.r_yes, ammAfter.r_no]);
    ctx.pool = { ...ctx.pool, ...ammAfter };
  }
  await c.q('UPDATE markets SET volume_minor = volume_minor + $2, trade_count = trade_count + 1, last_trade_kes = $3 WHERE id=$1', [m.id, Math.max(amountIn, amountOut), price_kes]);

  for (const l of legs) {
    if (l.role === 'SELL') {
      const s = l.result;
      const rate = ctx.rates;
      await tax.recordTax(c, { type: 'EXIT_WHT', userId: l.user_id, marketId: m.id, base: s.profit, rate: rate.winningsWht, amount: s.tax, ref });
      await tax.recordRevenue(c, { kind: 'PROFIT_COMMISSION', userId: l.user_id, marketId: m.id, amount: s.fee, ref });
    }
    if (l.user_id === taker.user_id && l.order && l.order.id === taker.id) {
      ctx.fills.push({ trade_id: trade.id, kind, qty: l.qty, price_kes: Math.round((l.amount / (l.qty * KES)) * 100) / 100, amount_minor: l.amount,
        tax_minor: l.result.tax || 0, fee_minor: l.result.fee || 0, net_minor: l.result.net });
    } else if (l.order) {
      await notify(c, l.user_id, 'TRADE', `Order filled on "${m.title}"`, `${l.role === 'BUY' ? 'Bought' : 'Sold'} ${l.qty} ${l.asset} at KES ${Math.round((l.amount / (l.qty * KES)) * 100) / 100}.`);
    }
  }
  return trade;
}

async function fillBook(c, ctx, taker, maker) {
  const q = Math.min(taker.qty - taker.filled, maker.qty - maker.filled);
  const t = maker.price_kes;                                   // trades happen at the resting order's price
  const bid = taker.book_side === 'BID' ? taker : maker, ask = taker.book_side === 'BID' ? maker : taker;
  const pYes = t * KES * q, pNo = (100 - t) * KES * q;
  let kind, legs;
  if (bid.action === 'BUY' && ask.action === 'SELL') {          // BUY YES × SELL YES
    kind = 'TRANSFER_YES';
    legs = [{ order: bid, user_id: bid.user_id, role: 'BUY', asset: 'YES', qty: q, amount: pYes }, { order: ask, user_id: ask.user_id, role: 'SELL', asset: 'YES', qty: q, amount: pYes }];
  } else if (bid.action === 'BUY' && ask.action === 'BUY') {    // BUY YES × BUY NO → mint a pair
    kind = 'MINT';
    legs = [{ order: bid, user_id: bid.user_id, role: 'BUY', asset: 'YES', qty: q, amount: pYes }, { order: ask, user_id: ask.user_id, role: 'BUY', asset: 'NO', qty: q, amount: pNo }];
  } else if (bid.action === 'SELL' && ask.action === 'SELL') {  // SELL NO × SELL YES → merge a pair
    kind = 'MERGE';
    legs = [{ order: bid, user_id: bid.user_id, role: 'SELL', asset: 'NO', qty: q, amount: pNo }, { order: ask, user_id: ask.user_id, role: 'SELL', asset: 'YES', qty: q, amount: pYes }];
  } else {                                                      // SELL NO × BUY NO
    kind = 'TRANSFER_NO';
    legs = [{ order: bid, user_id: bid.user_id, role: 'SELL', asset: 'NO', qty: q, amount: pNo }, { order: ask, user_id: ask.user_id, role: 'BUY', asset: 'NO', qty: q, amount: pNo }];
  }
  await execute(c, ctx, { kind, price_kes: t, legs, taker, bidOrder: bid, askOrder: ask, bidUser: bid.user_id, askUser: ask.user_id });
  return q;
}

async function fillAmm(c, ctx, taker, chunk) {
  const pool = ctx.pool, a = taker.asset;
  if (taker.action === 'BUY') {
    const qt = amm.quoteBuy(pool, a, chunk);
    if (qt.cost_minor <= 0 || qt.cost_minor > taker.limit_kes * chunk * KES) return false;
    const avg = Math.min(99, Math.max(1, Math.round(qt.cost_minor / (chunk * KES))));
    await execute(c, ctx, { kind: a === 'YES' ? 'AMM_BUY_YES' : 'AMM_BUY_NO', price_kes: a === 'YES' ? avg : 100 - avg,
      legs: [{ order: taker, user_id: taker.user_id, role: 'BUY', asset: a, qty: chunk, amount: qt.cost_minor }], taker, bidOrder: a === 'YES' ? taker : null, askOrder: a === 'NO' ? taker : null,
      bidUser: a === 'YES' ? taker.user_id : null, askUser: a === 'NO' ? taker.user_id : null, ammAfter: qt.after });
    return true;
  }
  const qt = amm.quoteSell(pool, a, chunk);
  if (qt.proceeds_minor <= 0 || qt.proceeds_minor < taker.limit_kes * chunk * KES) return false;
  const avg = Math.min(99, Math.max(1, Math.round(qt.proceeds_minor / (chunk * KES))));
  await execute(c, ctx, { kind: a === 'YES' ? 'AMM_SELL_YES' : 'AMM_SELL_NO', price_kes: a === 'YES' ? avg : 100 - avg,
    legs: [{ order: taker, user_id: taker.user_id, role: 'SELL', asset: a, qty: chunk, amount: qt.proceeds_minor }], taker, askOrder: a === 'YES' ? taker : null, bidOrder: a === 'NO' ? taker : null,
    askUser: a === 'YES' ? taker.user_id : null, bidUser: a === 'NO' ? taker.user_id : null, ammAfter: qt.after });
  return true;
}

// ───────────── price discovery ─────────────
// Headline price = midpoint of best bid and best offer (book and AMM together). If the gap is wider than the configured
// spread — or nobody is quoting — it falls back to the last trade, then to the proposer's opening estimate.
async function topOfBook(c, marketId) {
  const bid = await c.one("SELECT MAX(price_kes) p FROM orders WHERE market_id=$1 AND book_side='BID' AND status='OPEN'", [marketId]);
  const ask = await c.one("SELECT MIN(price_kes) p FROM orders WHERE market_id=$1 AND book_side='ASK' AND status='OPEN'", [marketId]);
  return { bid: bid && bid.p, ask: ask && ask.p };
}
async function refreshPrice(c, marketId) {
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [marketId]);
  const tb = await topOfBook(c, marketId);
  const pool = await c.one('SELECT * FROM amm_pools WHERE market_id=$1 AND enabled', [marketId]);
  const wide = await getInt(c, 'wide_spread_cents');
  let bid = tb.bid == null ? null : Number(tb.bid), ask = tb.ask == null ? null : Number(tb.ask);
  if (pool) { const p = amm.priceKes(pool, 'YES'); bid = bid == null ? p : Math.max(bid, p); ask = ask == null ? p : Math.min(ask, p); }
  let price;
  if (bid != null && ask != null && ask - bid <= wide && ask >= bid) price = (bid + ask) / 2;
  else if (m.last_trade_kes != null) price = m.last_trade_kes;
  else price = m.initial_price_kes;
  price = Math.min(99, Math.max(1, Math.round(price * 100) / 100));
  await c.q('UPDATE markets SET yes_price_kes=$2, no_price_kes=$3 WHERE id=$1', [marketId, price, Math.round((100 - price) * 100) / 100]);
  return price;
}

// ───────────── reading ─────────────
async function orderBook(c, marketId, user) {
  const lv = async (side, dir) => c.q(`SELECT price_kes, SUM(qty - filled)::bigint AS qty, COUNT(*)::int AS orders FROM orders WHERE market_id=$1 AND book_side='${side}' AND status='OPEN' GROUP BY price_kes ORDER BY price_kes ${dir} LIMIT 12`, [marketId]);
  const pool = await c.one('SELECT * FROM amm_pools WHERE market_id=$1 AND enabled', [marketId]);
  const out = { bids: await lv('BID', 'DESC'), asks: await lv('ASK', 'ASC'), amm: pool ? { yes_price_kes: amm.priceKes(pool, 'YES'), no_price_kes: amm.priceKes(pool, 'NO') } : null };
  out.best_bid = out.bids[0] ? out.bids[0].price_kes : null; out.best_ask = out.asks[0] ? out.asks[0].price_kes : null;
  if (user) out.my_orders = await c.q("SELECT id, action, asset, limit_kes, price_kes, qty, filled, tif, status, created_at FROM orders WHERE market_id=$1 AND user_id=$2 AND status='OPEN' ORDER BY id DESC", [marketId, user.id]);
  out.recent_trades = await c.q('SELECT id, kind, price_kes, qty, created_at FROM trades WHERE market_id=$1 ORDER BY id DESC LIMIT 20', [marketId]);
  return out;
}
async function priceHistory(c, marketId) {
  return c.q('SELECT id, price_kes, qty, created_at FROM trades WHERE market_id=$1 ORDER BY id DESC LIMIT 300', [marketId]).then((r) => r.reverse());
}

async function myPositions(c, userId) {
  const rows = await c.q(`SELECT p.*, m.title, m.status, m.yes_price_kes::float8 AS yes_price, m.no_price_kes::float8 AS no_price, m.closes_at, m.event_at, m.id AS market_id
      FROM positions p JOIN markets m ON m.id=p.market_id WHERE p.user_id=$1 AND (p.yes_shares>0 OR p.no_shares>0 OR p.realized_pnl_minor<>0) ORDER BY m.id DESC`, [userId]);
  const rates = await tax.rates(c);
  return rows.map((p) => {
    const side = (name) => {
      const sh = p[name + '_shares'], cost = p[name + '_cost_minor'], px = p[name + '_price'];
      const value = Math.round(sh * px * KES);
      const maxPayout = sh * SHARE;
      const profitIfWins = tax.profitSplit(maxPayout, cost, rates);
      return { shares: sh, locked: p[name + '_locked'], cost_basis_minor: cost, avg_entry_kes: sh ? Math.round((cost / (sh * KES)) * 100) / 100 : null,
        market_value_minor: value, unrealized_minor: value - cost, max_payout_minor: maxPayout, net_if_wins_minor: sh ? profitIfWins.net : 0,
        tax_if_wins_minor: sh ? profitIfWins.tax : 0, commission_if_wins_minor: sh ? profitIfWins.fee : 0 };
    };
    return { market_id: p.market_id, title: p.title, status: p.status, yes_price_kes: p.yes_price, no_price_kes: p.no_price, closes_at: p.closes_at,
      yes: side('yes'), no: side('no'), realized_pnl_minor: p.realized_pnl_minor };
  });
}
async function myOrders(c, userId, status = 'OPEN') {
  return c.q(`SELECT o.id, o.market_id, m.title, o.action, o.asset, o.limit_kes, o.qty, o.filled, o.tif, o.status, o.cancel_reason, o.created_at
      FROM orders o JOIN markets m ON m.id=o.market_id WHERE o.user_id=$1 AND ($2::text IS NULL OR o.status=$2) ORDER BY o.id DESC LIMIT 100`, [userId, status || null]);
}
async function myTrades(c, userId) {
  return c.q(`SELECT t.id, t.market_id, m.title, t.kind, t.price_kes, t.qty, t.amount_minor, t.created_at,
        CASE WHEN t.bid_user_id=$1 THEN 'BID' ELSE 'ASK' END AS my_side
      FROM trades t JOIN markets m ON m.id=t.market_id WHERE t.bid_user_id=$1 OR t.ask_user_id=$1 ORDER BY t.id DESC LIMIT 100`, [userId]);
}

// Dry run: executes the order for real inside a savepoint, reports what would happen, then rolls everything back.
async function preview(c, user, marketId, input) {
  await c.q('SAVEPOINT order_preview');
  try {
    const r = await placeOrder(c, user, marketId, { ...input, tif: 'IOC' }, { dry: true });
    return { ...r, order_id: undefined, preview: true };
  } finally {
    await c.q('ROLLBACK TO SAVEPOINT order_preview');
    await c.q('RELEASE SAVEPOINT order_preview');
  }
}

// Escrow invariant for one market or all: collateral held == KES 100 × every outstanding pair (user positions + AMM tokens).
async function escrowCheck(c, marketId = null) {
  const rows = await c.q(`
    SELECT m.id AS market_id, COALESCE(e.locked_minor,0)::bigint AS locked,
           (COALESCE((SELECT SUM(yes_shares) FROM positions p WHERE p.market_id=m.id),0) * ${SHARE}
             + COALESCE((SELECT r_yes + held_yes FROM amm_pools a WHERE a.market_id=m.id AND a.returned_minor IS NULL),0))::bigint AS yes_units,
           (COALESCE((SELECT SUM(no_shares) FROM positions p WHERE p.market_id=m.id),0) * ${SHARE}
             + COALESCE((SELECT r_no + held_no FROM amm_pools a WHERE a.market_id=m.id AND a.returned_minor IS NULL),0))::bigint AS no_units,
           m.status
      FROM markets m LEFT JOIN escrow_pools e ON e.market_id=m.id
     WHERE ($1::bigint IS NULL OR m.id=$1)`, [marketId]);
  const live = rows.filter((r) => !['SETTLED', 'VOID', 'DISPUTED'].includes(r.status));
  const bad = live.filter((r) => r.locked !== r.yes_units || r.locked !== r.no_units);
  const sysEscrow = (await c.one("SELECT balance_minor::bigint b FROM ledger_accounts WHERE wallet_id IS NULL AND account_type='SYS_ESCROW'")).b;
  const poolTotal = rows.reduce((s, r) => s + r.locked, 0);
  // A single-market check cannot compare against the global SYS_ESCROW balance (that sums every market).
  return { ok: bad.length === 0 && (marketId != null || sysEscrow === poolTotal), markets_checked: rows.length, mismatches: bad, sys_escrow_minor: sysEscrow, escrow_pools_total_minor: poolTotal };
}

module.exports = { placeOrder, cancelOrder, cancelAllForMarket, preview, orderBook, priceHistory, myPositions, myOrders, myTrades, refreshPrice, escrowCheck, topOfBook, bookFields, getPos };
