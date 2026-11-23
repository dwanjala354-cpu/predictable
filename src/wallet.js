'use strict';
const crypto = require('crypto');
const ledger = require('./ledger');
const { bad, conflict, forbidden, notFound, sha256, randToken } = require('./util');
const { getInt, getSetting, audit, notify } = require('./common');
const tax = require('./tax');

async function assertCanTransact(c, userId) {
  const u = await c.one('SELECT status, kyc_status FROM users WHERE id=$1', [userId]);
  if (u.status !== 'ACTIVE') throw forbidden('Account is not active', 'ACCOUNT_INACTIVE');
  if (u.kyc_status !== 'VERIFIED') throw forbidden('Complete identity and age verification first', 'KYC_REQUIRED');
  const rg = await c.one('SELECT self_excluded_until FROM responsible_gambling_profiles WHERE user_id=$1', [userId]);
  if (rg && rg.self_excluded_until && new Date(rg.self_excluded_until) > new Date()) {
    throw forbidden('You are self-excluded until ' + new Date(rg.self_excluded_until).toISOString().slice(0, 10), 'SELF_EXCLUDED');
  }
  const w = await ledger.ensureWallet(c, userId);
  if (w.status !== 'ACTIVE') throw forbidden('Wallet is frozen', 'WALLET_FROZEN');
}

// Step 1–2 of the deposit workflow: unique payment reference + pending intent. No money moves yet.
async function createDeposit(c, userId, amountMinor) {
  await assertCanTransact(c, userId);
  const cap = await getInt(c, 'max_simulated_topup_minor');
  if (amountMinor < 100 || amountMinor > cap) throw bad('AMOUNT_OUT_OF_RANGE', `Deposit must be between KES 1 and KES ${cap / 100}`);
  const rg = await c.one('SELECT daily_deposit_limit_minor FROM responsible_gambling_profiles WHERE user_id=$1', [userId]);
  if (rg && rg.daily_deposit_limit_minor != null) {
    const today = await c.one(`SELECT COALESCE(SUM(amount_minor),0)::bigint s FROM payment_intents
                               WHERE user_id=$1 AND status='SUCCEEDED' AND completed_at > now() - interval '24 hours'`, [userId]);
    if (today.s + amountMinor > rg.daily_deposit_limit_minor) throw forbidden('This deposit would exceed your daily deposit limit', 'DEPOSIT_LIMIT');
  }
  const reference = 'DEP-' + randToken(8).toUpperCase();
  const pi = await c.one('INSERT INTO payment_intents(user_id, reference, amount_minor) VALUES ($1,$2,$3) RETURNING *', [userId, reference, amountMinor]);
  return pi;
}

// Signature the (simulated) provider attaches to its callback.
function signCallback(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Steps 4–6: verify signed callback, then credit the wallet exactly once.
async function handleProviderCallback(c, rawBody, signature) {
  const secret = await getSetting(c, 'payment_callback_secret');
  const expected = signCallback(secret, rawBody);
  const ok = signature && signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!ok) throw forbidden('Invalid callback signature', 'BAD_SIGNATURE');
  const evt = JSON.parse(rawBody);          // { event_id, reference, status, amount_minor }
  if (!evt.event_id || !evt.reference) throw bad('BAD_EVENT', 'Malformed callback');

  // Dedupe on (provider, event_id) atomically: concurrent duplicates block on the unique index, then see "already inserted".
  const ins = await c.one("INSERT INTO payment_events(provider,event_id,provider_reference,payload_hash) VALUES ('SIMULATOR',$1,$2,$3) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id", [evt.event_id, evt.reference, sha256(rawBody)]);
  if (!ins) return { credited: false, duplicate: true };

  const pi = await c.one('SELECT * FROM payment_intents WHERE reference=$1 FOR UPDATE', [evt.reference]);
  if (!pi) throw notFound('Unknown payment reference');
  if (pi.status !== 'PENDING') return { credited: false, duplicate: true };
  if (evt.status !== 'SUCCESS') {
    await c.q("UPDATE payment_intents SET status='FAILED', completed_at=now() WHERE id=$1", [pi.id]);
    return { credited: false, failed: true };
  }
  if (evt.amount_minor !== pi.amount_minor) throw conflict('AMOUNT_MISMATCH', 'Callback amount does not match the payment intent');

  // Waterfall: gross deposit → 5% excise (KRA) + 5% platform fee → remainder credited to the wallet. One atomic ledger transaction.
  const r = await tax.rates(c), sp = tax.depositSplit(pi.amount_minor, r);
  const acct = await ledger.userAccounts(c, pi.user_id);
  const funding = await ledger.systemAccount(c, 'SYS_FUNDING'), kra = await ledger.systemAccount(c, 'SYS_KRA_TAX_PAYABLE'), rev = await ledger.systemAccount(c, 'SYS_PLATFORM_REVENUE');
  const ref = 'dep:' + pi.reference;
  const lines = [{ account: funding, direction: 'DEBIT', amount: sp.gross }, { account: acct.AVAILABLE, direction: 'CREDIT', amount: sp.net }];
  if (sp.tax) lines.push({ account: kra, direction: 'CREDIT', amount: sp.tax });
  if (sp.fee) lines.push({ account: rev, direction: 'CREDIT', amount: sp.fee });
  await ledger.post(c, { reference: ref, type: 'DEPOSIT', description: `Deposit ${pi.reference}`, split: sp, lines });
  await tax.recordTax(c, { type: 'DEPOSIT_EXCISE', userId: pi.user_id, base: sp.gross, rate: r.depositExcise, amount: sp.tax, ref });
  await tax.recordRevenue(c, { kind: 'DEPOSIT_FEE', userId: pi.user_id, amount: sp.fee, ref });
  await c.q('UPDATE payment_intents SET excise_minor=$2, fee_minor=$3, net_minor=$4 WHERE id=$1', [pi.id, sp.tax, sp.fee, sp.net]);
  await c.q("UPDATE payment_intents SET status='SUCCEEDED', completed_at=now() WHERE id=$1", [pi.id]);
  await notify(c, pi.user_id, 'DEPOSIT', 'Deposit received', `Your deposit ${pi.reference} was credited: KES ${sp.net / 100} after KES ${sp.tax / 100} excise duty and KES ${sp.fee / 100} platform fee.`);
  return { credited: true, user_id: pi.user_id, amount_minor: pi.amount_minor, excise_minor: sp.tax, fee_minor: sp.fee, net_minor: sp.net };
}

// Withdrawal workflow: funds move to PENDING_WITHDRAWAL at request, and only leave the platform when a finance officer completes it.
async function requestWithdrawal(c, userId, amountMinor, destination) {
  await assertCanTransact(c, userId);
  if (!/^(\+?254|0)(7|1)\d{8}$/.test(String(destination || '').replace(/\s/g, ''))) throw bad('INVALID_DESTINATION', 'Enter a valid M-Pesa number');
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1000) throw bad('AMOUNT_OUT_OF_RANGE', 'Minimum withdrawal is KES 10');
  const acct = await ledger.userAccounts(c, userId);
  const reference = 'WDR-' + randToken(8).toUpperCase();
  await ledger.post(c, {
    reference: 'wdr-req:' + reference, type: 'WITHDRAWAL_REQUEST', description: `Withdrawal request ${reference}`, createdBy: userId,
    lines: [{ account: acct.AVAILABLE, direction: 'DEBIT', amount: amountMinor }, { account: acct.PENDING_WITHDRAWAL, direction: 'CREDIT', amount: amountMinor }],
  });
  const sp = tax.withdrawalSplit(amountMinor, await tax.rates(c));
  return c.one('INSERT INTO withdrawal_requests(user_id, amount_minor, destination, reference, tax_minor, fee_minor, net_minor) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [userId, amountMinor, destination, reference, sp.tax, sp.fee, sp.net]);
}

async function completeWithdrawal(c, actorId, withdrawalId, approve) {
  const w = await c.one('SELECT * FROM withdrawal_requests WHERE id=$1 FOR UPDATE', [withdrawalId]);
  if (!w) throw notFound('Withdrawal not found');
  if (w.status !== 'PENDING') throw conflict('ALREADY_PROCESSED', 'This withdrawal was already processed');
  if (w.user_id === actorId) throw forbidden('You cannot process your own withdrawal', 'SELF_APPROVAL');
  const acct = await ledger.userAccounts(c, w.user_id);
  if (approve) {
    const clearing = await ledger.systemAccount(c, 'SYS_WITHDRAWAL_CLEARING'), kra = await ledger.systemAccount(c, 'SYS_KRA_TAX_PAYABLE'), rev = await ledger.systemAccount(c, 'SYS_PLATFORM_REVENUE');
    const ref = 'wdr-done:' + w.reference;
    const lines = [{ account: acct.PENDING_WITHDRAWAL, direction: 'DEBIT', amount: w.amount_minor }, { account: clearing, direction: 'CREDIT', amount: w.net_minor }];
    if (w.tax_minor) lines.push({ account: kra, direction: 'CREDIT', amount: w.tax_minor });
    if (w.fee_minor) lines.push({ account: rev, direction: 'CREDIT', amount: w.fee_minor });
    await ledger.post(c, { reference: ref, type: 'WITHDRAWAL_COMPLETE', description: `Withdrawal ${w.reference} paid out (simulated)`, createdBy: actorId,
      split: { gross: w.amount_minor, tax: w.tax_minor, fee: w.fee_minor, net: w.net_minor }, lines });
    await tax.recordTax(c, { type: 'WITHDRAWAL_WHT', userId: w.user_id, base: w.amount_minor, rate: (await tax.rates(c)).withdrawalWht, amount: w.tax_minor, ref });
    await tax.recordRevenue(c, { kind: 'WITHDRAWAL_FEE', userId: w.user_id, amount: w.fee_minor, ref });
    await c.q("UPDATE withdrawal_requests SET status='COMPLETED', reviewed_by=$2, completed_at=now() WHERE id=$1", [w.id, actorId]);
    await notify(c, w.user_id, 'WITHDRAWAL', 'Withdrawal completed', `${w.reference}: KES ${w.net_minor / 100} paid to ${w.destination} after KES ${w.tax_minor / 100} withholding tax and KES ${w.fee_minor / 100} platform fee (simulated).`);
  } else {
    await ledger.post(c, {
      reference: 'wdr-rej:' + w.reference, type: 'WITHDRAWAL_REJECTED', description: `Withdrawal ${w.reference} rejected, funds returned`, createdBy: actorId,
      lines: [{ account: acct.PENDING_WITHDRAWAL, direction: 'DEBIT', amount: w.amount_minor }, { account: acct.AVAILABLE, direction: 'CREDIT', amount: w.amount_minor }],
    });
    await c.q("UPDATE withdrawal_requests SET status='REJECTED', reviewed_by=$2, completed_at=now() WHERE id=$1", [w.id, actorId]);
    await notify(c, w.user_id, 'WITHDRAWAL', 'Withdrawal rejected', `${w.reference} was rejected and the funds returned to your wallet.`);
  }
  await audit(c, actorId, approve ? 'withdrawal.complete' : 'withdrawal.reject', 'withdrawal', w.id, { amount_minor: w.amount_minor });
}

async function history(c, userId, limit = 100) {
  return c.q(`
    SELECT t.id, t.reference, t.transaction_type, t.description, t.created_at, t.market_id,
           SUM(CASE WHEN a.account_type='AVAILABLE' THEN (CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END)::bigint AS available_delta_minor,
           SUM(CASE WHEN a.account_type = 'RESERVED_ORDERS' THEN (CASE WHEN e.direction='CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) ELSE 0 END)::bigint AS reserved_delta_minor
      FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id=t.id
      JOIN ledger_accounts a ON a.id=e.account_id
      JOIN wallets w ON w.id=a.wallet_id
     WHERE w.user_id=$1
     GROUP BY t.id ORDER BY t.id DESC LIMIT $2`, [userId, limit]);
}

module.exports = { assertCanTransact, createDeposit, signCallback, handleProviderCallback, requestWithdrawal, completeWithdrawal, history };
