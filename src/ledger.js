'use strict';
// Double-entry ledger. All money movement in PREDICTABLE goes through post().
// balance_minor = credits − debits on every account (see schema comment).
const { AppError, bad, conflict } = require('./util');

async function systemAccount(c, type) {
  const r = await c.one('SELECT * FROM ledger_accounts WHERE wallet_id IS NULL AND account_type=$1', [type]);
  if (!r) throw new Error(`System account ${type} missing — run seed`);
  return r;
}

const USER_ACCOUNT_TYPES = ['AVAILABLE', 'RESERVED_ORDERS', 'PENDING_WITHDRAWAL'];

async function ensureWallet(c, userId) {
  let w = await c.one("SELECT * FROM wallets WHERE user_id=$1 AND currency='KES'", [userId]);
  if (!w) {
    w = await c.one("INSERT INTO wallets(user_id) VALUES ($1) RETURNING *", [userId]);
    for (const t of USER_ACCOUNT_TYPES) {
      await c.q('INSERT INTO ledger_accounts(wallet_id, account_type) VALUES ($1,$2)', [w.id, t]);
    }
  }
  return w;
}

// Returns { AVAILABLE: acct, RESERVED_ORDERS: acct, ... } for a user.
async function userAccounts(c, userId) {
  const w = await ensureWallet(c, userId);
  let rows = await c.q('SELECT * FROM ledger_accounts WHERE wallet_id=$1', [w.id]);
  if (rows.length < USER_ACCOUNT_TYPES.length) {
    for (const t of USER_ACCOUNT_TYPES) await c.q('INSERT INTO ledger_accounts(wallet_id, account_type) VALUES ($1,$2) ON CONFLICT (wallet_id, account_type) DO NOTHING', [w.id, t]);
    rows = await c.q('SELECT * FROM ledger_accounts WHERE wallet_id=$1', [w.id]);
  }
  const m = {};
  for (const r of rows) m[r.account_type] = r;
  m.wallet = w;
  return m;
}

async function balances(c, userId) {
  const a = await userAccounts(c, userId);
  const avail = a.AVAILABLE.balance_minor, resv = a.RESERVED_ORDERS.balance_minor, pendW = a.PENDING_WITHDRAWAL.balance_minor;
  return {
    currency: 'KES',
    available_minor: avail,
    reserved_orders_minor: resv,
    reserved_minor: resv,
    pending_withdrawal_minor: pendW,
    total_minor: avail + resv + pendW,
    wallet_status: a.wallet.status,
  };
}

/**
 * Post a balanced ledger transaction atomically.
 * lines: [{ account: <ledger_accounts row or id>, direction: 'DEBIT'|'CREDIT', amount: int>0 }]
 * Idempotent on `reference`: a repeated reference returns the original transaction untouched.
 */
async function post(c, { reference, type, description, marketId = null, createdBy = null, reversesId = null, split = null, lines }) {
  if (!reference) throw new Error('ledger.post requires a reference');
  const existing = await c.one('SELECT * FROM ledger_transactions WHERE reference=$1', [reference]);
  if (existing) return { ...existing, duplicate: true };

  const norm = lines.map((l) => ({ id: typeof l.account === 'object' ? l.account.id : l.account, direction: l.direction, amount: l.amount }));
  let d = 0, cr = 0;
  for (const l of norm) {
    if (!Number.isSafeInteger(l.amount) || l.amount <= 0) throw new Error('ledger line amount must be a positive integer');
    if (l.direction === 'DEBIT') d += l.amount; else if (l.direction === 'CREDIT') cr += l.amount; else throw new Error('bad direction');
  }
  if (d !== cr) throw new Error(`Unbalanced ledger transaction ${reference}: debits ${d} ≠ credits ${cr}`);

  const ids = [...new Set(norm.map((l) => l.id))].sort((a, b) => a - b);   // consistent lock order → no deadlocks
  await c.q('SELECT id FROM ledger_accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);

  const tx = await c.one(
    `INSERT INTO ledger_transactions(reference, transaction_type, description, market_id, created_by, reverses_transaction_id, gross_minor, tax_minor, fee_minor, net_minor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [reference, type, description || null, marketId, createdBy, reversesId, split ? split.gross : null, split ? split.tax : null, split ? split.fee : null, split ? split.net : null]
  );
  for (const l of norm) {
    await c.q('INSERT INTO ledger_entries(transaction_id, account_id, direction, amount_minor) VALUES ($1,$2,$3,$4)', [tx.id, l.id, l.direction, l.amount]);
  }
  // Net the lines per account so one overdraft check applies to the final balance, not an intermediate step.
  const delta = new Map();
  for (const l of norm) delta.set(l.id, (delta.get(l.id) || 0) + (l.direction === 'CREDIT' ? l.amount : -l.amount));
  for (const [id, dlt] of delta) {
    if (dlt === 0) continue;
    try {
      await c.q('SAVEPOINT bal');
      await c.q('UPDATE ledger_accounts SET balance_minor = balance_minor + $1 WHERE id=$2', [dlt, id]);
      await c.q('RELEASE SAVEPOINT bal');
    } catch (e) {
      if (/no_overdraft/.test(e.message)) throw conflict('INSUFFICIENT_FUNDS', 'Insufficient available balance');
      throw e;
    }
  }
  return { ...tx, duplicate: false };
}

// Post an exact mirror of an earlier transaction (corrections never edit history).
async function reverse(c, txId, { reference, description, createdBy }) {
  const orig = await c.one('SELECT * FROM ledger_transactions WHERE id=$1', [txId]);
  if (!orig) throw bad('NOT_FOUND', 'Transaction to reverse not found');
  const entries = await c.q('SELECT * FROM ledger_entries WHERE transaction_id=$1', [txId]);
  return post(c, {
    reference, type: 'REVERSAL', description: description || `Reversal of ${orig.reference}`, marketId: orig.market_id, createdBy, reversesId: txId,
    split: orig.gross_minor == null ? null : { gross: orig.gross_minor, tax: orig.tax_minor, fee: orig.fee_minor, net: orig.net_minor },
    lines: entries.map((e) => ({ account: e.account_id, direction: e.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount: e.amount_minor })),
  });
}

// Independent integrity check: recompute every balance from entries and confirm the books sum to zero.
async function reconcile(c) {
  const accounts = await c.q(`
    SELECT a.id, a.account_type, a.wallet_id, a.balance_minor,
           COALESCE(SUM(CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END),0)::bigint AS computed
      FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id=a.id
     GROUP BY a.id ORDER BY a.id`);
  const mismatches = accounts.filter((a) => a.balance_minor !== a.computed);
  const total = accounts.reduce((s, a) => s + a.balance_minor, 0);
  const unbalanced = await c.q(`
    SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
    HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0`);
  const sys = {};
  for (const a of accounts.filter((a) => a.wallet_id === null)) sys[a.account_type] = a.balance_minor;
  return {
    ok: mismatches.length === 0 && total === 0 && unbalanced.length === 0,
    accounts_checked: accounts.length,
    balance_mismatches: mismatches,
    unbalanced_transactions: unbalanced.map((u) => u.transaction_id),
    net_of_all_accounts_minor: total,
    system_accounts: sys,
  };
}

module.exports = { systemAccount, ensureWallet, userAccounts, balances, post, reverse, reconcile };
