'use strict';
const DEFAULT_SETTINGS = {
  // ── tax & fee waterfall (basis points; every rate is a setting so finance can change it without a release) ──
  deposit_excise_bps: '500',             // 5% excise duty on deposits, remitted to KRA
  deposit_fee_bps: '500',                // 5% platform fee on deposits
  withdrawal_wht_bps: '500',             // 5% withholding tax on withdrawals
  withdrawal_fee_bps: '500',             // 5% platform fee on withdrawals
  winnings_wht_bps: '2000',              // 20% withholding tax on gross profit when a winning position settles
  profit_commission_bps: '1000',         // 10% platform commission on gross profit
  tax_on_exit_sales: '1',                // 1 = profitable early sales (secondary market) are taxed like settlement profit. FINANCE TO CONFIRM.
  ggr_tax_bps: '1500',                   // 15% gross gaming revenue tax, tracked monthly (due by the 20th of the next month)
  // ── trading limits ──
  min_order_shares: '1',
  max_order_shares: '10000',             // per order
  max_position_shares: '50000',          // per user, per side, per market
  max_open_orders: '50',                 // per user per market
  wide_spread_cents: '10',               // above this the headline price falls back to the last trade
  // ── platform-funded market maker ──
  amm_default_subsidy_minor: '500000',   // KES 5,000 seeded into a pool unless the market proposer chooses otherwise
  amm_max_subsidy_minor: '5000000',      // KES 50,000 ceiling per market
  amm_max_total_exposure_minor: '50000000', // KES 500,000 ceiling across all live pools
  // ── general ──
  dual_approval_threshold_minor: '2000000', // settlements moving ≥ KES 20,000 of collateral need a second, different officer
  default_dispute_window_hours: '24',
  max_simulated_topup_minor: '10000000', // KES 100,000 per simulated deposit
  payment_callback_secret: 'dev-only-change-me',
  // security
  require_staff_mfa: '1',                // staff must enrol an authenticator app; sensitive actions need a fresh code
  require_withdrawal_otp: '1',           // users confirm withdrawals with a one-time code sent by SMS
  login_max_failures: '5', lockout_minutes: '15', otp_ttl_minutes: '10',
  // reference-probability model defaults (uncalibrated until enough settled matches exist)
  elo_home_advantage: '65', elo_k: '30', base_goals: '1.35', goal_scale: '0.6',
};

async function seedSettings(c) {
  // Dev/test convenience only: env can override the security defaults the first time settings are created.
  const ov = { require_staff_mfa: process.env.PREDICTABLE_REQUIRE_STAFF_MFA, require_withdrawal_otp: process.env.PREDICTABLE_REQUIRE_WITHDRAWAL_OTP };
  for (const [k, v0] of Object.entries(DEFAULT_SETTINGS)) {
    const v = ov[k] !== undefined ? ov[k] : v0;
    await c.q('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}
async function getSetting(c, key) {
  const r = await c.one('SELECT value FROM settings WHERE key=$1', [key]);
  return r ? r.value : DEFAULT_SETTINGS[key];
}
const getInt = async (c, key) => parseInt(await getSetting(c, key), 10);

async function audit(c, actorId, action, entityType, entityId, details = {}) {
  await c.q('INSERT INTO audit_logs(actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [actorId || null, action, entityType, entityId || null, JSON.stringify(details)]);
}
async function notify(c, userId, type, title, body) {
  await c.q('INSERT INTO notifications(user_id,type,title,body) VALUES ($1,$2,$3,$4)', [userId, type, title, body || null]);
}

// Calendar month in Kenya time, used to bucket tax and revenue records.
const periodOf = (d = new Date()) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 7);

module.exports = { periodOf, DEFAULT_SETTINGS, seedSettings, getSetting, getInt, audit, notify };
