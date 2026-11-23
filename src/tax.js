'use strict';
// Tax and platform-fee waterfall. All maths is integer minor units with floor rounding (the customer is never
// charged a fraction of a cent more than the stated rate). Rates are settings, never constants.
const { getInt, getSetting, periodOf } = require('./common');

const bps = (amount, rate) => Number((BigInt(amount) * BigInt(rate)) / 10000n);

async function rates(c) {
  return {
    depositExcise: await getInt(c, 'deposit_excise_bps'), depositFee: await getInt(c, 'deposit_fee_bps'),
    withdrawalWht: await getInt(c, 'withdrawal_wht_bps'), withdrawalFee: await getInt(c, 'withdrawal_fee_bps'),
    winningsWht: await getInt(c, 'winnings_wht_bps'), profitCommission: await getInt(c, 'profit_commission_bps'),
    taxOnExit: (await getSetting(c, 'tax_on_exit_sales')) === '1',
  };
}

// Deposit: 5% excise + 5% platform fee, rest credited.   KES 1,000 → 50 + 50 + 900.
function depositSplit(gross, r) {
  const tax = bps(gross, r.depositExcise), fee = bps(gross, r.depositFee);
  return { gross, tax, fee, net: gross - tax - fee };
}
// Withdrawal: 5% WHT + 5% platform fee, rest disbursed.
function withdrawalSplit(gross, r) {
  const tax = bps(gross, r.withdrawalWht), fee = bps(gross, r.withdrawalFee);
  return { gross, tax, fee, net: gross - tax - fee };
}
// Winning settlement or profitable exit: WHT and commission apply to GROSS PROFIT only (proceeds − cost basis).
// Spec example: 10 YES bought at KES 40, paid KES 1,000 → profit 600, WHT 120, commission 60, net 820.
function profitSplit(gross, costBasis, r) {
  const profit = Math.max(0, gross - costBasis);
  const tax = bps(profit, r.winningsWht), fee = bps(profit, r.profitCommission);
  return { gross, cost: costBasis, profit, tax, fee, net: gross - tax - fee };
}

async function recordTax(c, { type, userId, marketId = null, base, rate, amount, ref }) {
  if (!amount) return;
  await c.q(`INSERT INTO tax_events(tax_type, user_id, market_id, base_minor, rate_bps, amount_minor, ledger_reference, period) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [type, userId, marketId, base, rate, amount, ref, periodOf()]);
}
async function recordRevenue(c, { kind, userId, marketId = null, amount, ref }) {
  if (!amount) return;
  await c.q('INSERT INTO revenue_events(kind, user_id, market_id, amount_minor, ledger_reference, period) VALUES ($1,$2,$3,$4,$5,$6)', [kind, userId, marketId, amount, ref, periodOf()]);
}

// Next 20th of the month after the period (GGR tax filing date).
const ggrDueDate = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 20)).toISOString().slice(0, 10); };

module.exports = { bps, rates, depositSplit, withdrawalSplit, profitSplit, recordTax, recordRevenue, ggrDueDate };
