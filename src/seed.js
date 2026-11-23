'use strict';
const db = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const wallet = require('./wallet');
const markets = require('./markets');
const common = require('./common');
const { toMinor } = require('./util');

const CATEGORIES = [['Sports', 'sports'], ['Politics', 'politics'], ['Entertainment', 'entertainment'], ['Economy', 'economy'], ['Weather', 'weather'], ['Community', 'community']];
const SYSTEM_ACCOUNTS = ['SYS_FUNDING', 'SYS_WITHDRAWAL_CLEARING', 'SYS_ESCROW', 'SYS_KRA_TAX_PAYABLE', 'SYS_KRA_REMITTED', 'SYS_PLATFORM_REVENUE', 'SYS_AMM_FUND'];
const MAY_BE_NEGATIVE = new Set(['SYS_FUNDING', 'SYS_AMM_FUND']);   // issuance clearing and platform capital; every other system account must never overdraw
const STAFF_PASSWORD = process.env.PREDICTABLE_STAFF_PASSWORD || 'Predictable#2026';

const STAFF = [
  ['superadmin', 'Super Admin', ['super_administrator']],
  ['admin', 'Operations Admin', ['administrator']],
  ['moderator', 'Mia Moderator', ['moderator']],
  ['settle1', 'Sam Settlement', ['settlement_officer']],
  ['settle2', 'Sade Settlement', ['settlement_officer']],
  ['finance', 'Fiona Finance', ['finance_officer']],
  ['risk', 'Rafiki Risk', ['risk_officer']],
];

async function mkUser(c, username, display, dob, roles = [], verify = true) {
  const id = await auth.register(c, {
    username, email: `${username}@predictable.test`, phone: '0712' + String(100000 + Math.floor(Math.random() * 899999)),
    password: STAFF_PASSWORD, display_name: display, date_of_birth: dob, accept_terms: true,
  });
  for (const r of roles) await auth.changeStaffRole(c, id, r, true);
  if (verify) await auth.simulateKyc(c, id);
  return id;
}

async function seedBase(c) {
  await auth.seedRbac(c);
  await common.seedSettings(c);
  // Starting Elo values are editable placeholders (not measured data); ratings then move with every settled match.
  for (const [n, r] of [['Gor Mahia', 1560], ['AFC Leopards', 1490], ['Tusker', 1520], ['Kenya', 1450], ['Uganda', 1500], ['Tanzania', 1470], ['Nigeria', 1700], ['Ghana', 1640]])
    await c.q("INSERT INTO team_ratings(sport, name, rating) VALUES ('football',$1,$2) ON CONFLICT (sport, name) DO NOTHING", [n, r]);
  for (const [n, s] of CATEGORIES) await c.q('INSERT INTO categories(name, slug) VALUES ($1,$2) ON CONFLICT (slug) DO NOTHING', [n, s]);
  for (const t of SYSTEM_ACCOUNTS) {
    const e = await c.one('SELECT 1 FROM ledger_accounts WHERE wallet_id IS NULL AND account_type=$1', [t]);
    if (!e) await c.q('INSERT INTO ledger_accounts(wallet_id, account_type, allow_negative) VALUES (NULL,$1,$2)', [t, MAY_BE_NEGATIVE.has(t)]);
  }
  const has = await c.one("SELECT 1 FROM users WHERE username='superadmin'");
  if (!has) for (const [u, d, r] of STAFF) await mkUser(c, u, d, '1985-01-15', r);
}

const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const inMins = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();

async function fund(c, userId, kes) {
  const pi = await wallet.createDeposit(c, userId, toMinor(kes));
  const body = JSON.stringify({ event_id: 'seed-' + pi.reference, reference: pi.reference, status: 'SUCCESS', amount_minor: pi.amount_minor });
  await wallet.handleProviderCallback(c, body, wallet.signCallback(await common.getSetting(c, 'payment_callback_secret'), body));
}

async function seedDemo(c) {
  const exists = await c.one("SELECT 1 FROM users WHERE username='dennis'");
  if (exists) return;
  const ids = {};
  for (const [u, d] of [['dennis', 'Dennis'], ['brian', 'Brian'], ['amina', 'Amina'], ['wanjiku', 'Wanjiku'], ['otieno', 'Otieno']]) {
    ids[u] = await mkUser(c, u, d, '1995-06-01');
    await fund(c, ids[u], 10000);
  }
  const U = async (name) => auth.publicUser(c, ids[name]);
  const admin = await auth.publicUser(c, (await c.one("SELECT id FROM users WHERE username='admin'")).id);
  const sup = await auth.publicUser(c, (await c.one("SELECT id FROM users WHERE username='superadmin'")).id);

  const trading = require('./trading');
  await c.q('UPDATE users SET market_creator=true WHERE id=$1', [ids.dennis]);               // Dennis is an approved market creator
  const mod = await auth.publicUser(c, (await c.one("SELECT id FROM users WHERE username='moderator'")).id);
  const yesId = async (mid, code) => (await c.one('SELECT id FROM market_outcomes WHERE market_id=$1 AND outcome_code=$2', [mid, code])).id;

  // 1. Staff-proposed market with a platform-funded market maker (KES 5,000), approved by a different administrator.
  const derby = await markets.createMarket(c, admin, {
    title: 'Will Gor Mahia beat AFC Leopards in the next Mashemeji Derby?', description: 'Full-time result in regular time (90 minutes plus stoppage).',
    category_slug: 'sports', initial_price_kes: 52, closes_at: inHours(46), event_at: inHours(48), resolution_source: 'Football Kenya Federation official match report (fkf.co.ke)',
    resolution_method: 'Score at full time, excluding extra time and penalties. Abandoned matches are voided.',
  });
  await markets.review(c, sup, derby.id, 'APPROVED', 'Clear and verifiable; market maker funded', { amm_subsidy_minor: 500000 });
  await trading.placeOrder(c, await U('amina'), derby.id, { action: 'BUY', asset: 'YES', limit_kes: 60, qty: 40, tif: 'IOC' });      // buys from the market maker
  await trading.placeOrder(c, await U('wanjiku'), derby.id, { action: 'BUY', asset: 'NO', limit_kes: 45, qty: 25, tif: 'GTC' });     // rests on the book
  await trading.placeOrder(c, await U('otieno'), derby.id, { action: 'BUY', asset: 'YES', limit_kes: 48, qty: 30, tif: 'GTC' });    // a resting bid

  // 2. Market proposed by an approved user, reviewed by a moderator. Order book only (no market maker).
  const stars = await markets.createMarket(c, await U('dennis'), {
    title: 'Will Harambee Stars win their next international match?', description: 'Next full international match played by the Kenya senior men\'s team.',
    category_slug: 'sports', initial_price_kes: 40, closes_at: inHours(70), event_at: inHours(72), resolution_source: 'FIFA match centre / Football Kenya Federation official report',
    resolution_method: 'Result at full time (90 minutes plus stoppage). Extra time and penalties are ignored.',
  });
  await markets.review(c, mod, stars.id, 'APPROVED', 'Clear and verifiable');
  await trading.placeOrder(c, await U('amina'), stars.id, { action: 'BUY', asset: 'YES', limit_kes: 38, qty: 50 });
  await trading.placeOrder(c, await U('brian'), stars.id, { action: 'BUY', asset: 'NO', limit_kes: 58, qty: 50 });           // 38 + 58 < 100: both rest
  await trading.placeOrder(c, await U('otieno'), stars.id, { action: 'BUY', asset: 'NO', limit_kes: 62, qty: 30 });           // crosses Amina's bid (38 + 62 = 100): mints 30 new pairs

  // 3. A second staff market (NSE 20), approved, no trades yet.
  const nse = await markets.createMarket(c, admin, {
    title: 'Will the Nairobi Securities Exchange NSE 20 close above 2,000 on Friday 4 December 2026?', description: 'Official daily closing value of the NSE 20 Share Index.',
    category_slug: 'economy', initial_price_kes: 55, closes_at: inHours(300), event_at: inHours(310),
    resolution_source: 'Nairobi Securities Exchange official market statistics (nse.co.ke)', resolution_method: 'Closing value of the NSE 20 Share Index published by the NSE for that trading day.',
  });
  await markets.review(c, sup, nse.id, 'APPROVED', 'ok', { amm_subsidy_minor: 300000 });

  // Intelligence demo data: a resolution spec so the reference model and the resolution assistant can work, evidence placeholders clearly labelled as demo, and a sample feed.
  const intel = require('./intel');
  await intel.setResolutionSpec(c, admin, derby.id, { kind: 'MATCH_RESULT', params: { home: 'Gor Mahia', away: 'AFC Leopards', outcome_covers: { [await yesId(derby.id, 'YES')]: ['home'], [await yesId(derby.id, 'NO')]: ['draw', 'away'] } } });
  await intel.addEvidence(c, admin, derby.id, { kind: 'CONTEXT', claim: '[Demo placeholder] Replace with the head-to-head record from the league\'s official statistics page.', source_name: 'Football Kenya Federation', source_url: 'https://www.fkf.co.ke/' });
  await intel.addEvidence(c, admin, derby.id, { kind: 'UNKNOWN', claim: '[Demo placeholder] Team news and suspensions are unconfirmed until the official squad lists are published.', source_name: 'Football Kenya Federation', source_url: 'https://www.fkf.co.ke/' });
  const feed = await intel.addFeed(c, admin, { name: 'Demo sample feed (offline sample items)', url: 'https://example.org/predictable-demo.xml', category_slug: null });
  await intel.ingest(c, feed.id, [
    { guid: 'demo-1', title: 'Tusker vs Kenya Police: league fixture set for 6 December', url: 'https://example.org/demo/tusker-police', published_at: new Date().toISOString(), summary: 'Sample item for discovery.' },
    { guid: 'demo-2', title: 'Nairobi Jazz Festival announced for 20 December 2026 at Uhuru Gardens', url: 'https://example.org/demo/jazz-festival', published_at: new Date().toISOString(), summary: 'Sample item for discovery.' },
    { guid: 'demo-3', title: 'Weather outlook for the week', url: 'https://example.org/demo/weather', published_at: new Date().toISOString(), summary: 'Sample item that yields no suggestion.' },
  ]);
}

async function run({ demo = true } = {}) {
  await db.init();
  await db.tx(async (c) => { await seedBase(c); if (demo) await seedDemo(c); });
}

module.exports = { seedBase, seedDemo, run, STAFF_PASSWORD, mkUser, fund };

if (require.main === module) {
  run({ demo: !process.argv.includes('--no-demo') }).then(async () => {
    console.log('Seed complete. Staff logins (password from PREDICTABLE_STAFF_PASSWORD or the default):', STAFF.map((s) => s[0]).join(', '));
    await db.close();
  }).catch((e) => { console.error(e); process.exit(1); });
}
