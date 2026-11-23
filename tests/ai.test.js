'use strict';
process.env.DATABASE_DIR = 'memory://'; process.env.NODE_ENV = 'test'; process.env.QUIET_SMS = '1'; process.env.PREDICTABLE_REQUIRE_STAFF_MFA = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db'); const seed = require('../src/seed'); const auth = require('../src/auth');
const ledger = require('../src/ledger'); const markets = require('../src/markets'); const trading = require('../src/trading');
const settlement = require('../src/settlement'); const intel = require('../src/intel'); const ai = require('../src/ai');

const staff = (n) => db.tx(async (c) => auth.publicUser(c, (await c.one('SELECT id FROM users WHERE username=$1', [n])).id));
const T = (fn) => db.tx(fn);
const reconciled = async () => assert.equal((await T((c) => ledger.reconcile(c))).ok, true);
let house, outs;
const hrs = (h) => new Date(Date.now() + h * 3600e3).toISOString();
// Binary market with a MATCH_RESULT spec: Yes = home win; No = draw or away win.
async function binary(title, home, away) {
  const adm = await staff('admin'), sup = await staff('superadmin');
  const m = await T((c) => markets.createMarket(c, adm, { title, description: 'Full time', category_slug: 'sports', initial_price_kes: 50, closes_at: hrs(2), event_at: hrs(3), resolution_source: 'Football Kenya Federation official report (fkf.co.ke)', resolution_method: 'Full-time score; extra time ignored.' }));
  await T((c) => markets.review(c, sup, m.id, 'APPROVED'));
  const o = await db.q('SELECT id, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [m.id]);
  const yes = o.find((x) => x.outcome_code === 'YES').id, no = o.find((x) => x.outcome_code === 'NO').id;
  await T((c) => intel.setResolutionSpec(c, adm, m.id, { kind: 'MATCH_RESULT', params: { home, away, outcome_covers: { [yes]: ['home'], [no]: ['draw', 'away'] } } }));
  return { id: m.id, yes, no };
}
// A YES holder and a NO holder (a minted pair) so the market has something to settle.
async function pair(m, yesUser, noUser, price = 60, qty = 5) {
  await T((c) => trading.placeOrder(c, yesUser, m.id, { action: 'BUY', asset: 'YES', limit_kes: price, qty }));
  await T((c) => trading.placeOrder(c, noUser, m.id, { action: 'BUY', asset: 'NO', limit_kes: 100 - price, qty }));
}
test.before(async () => { await require('./_pgreset')(); await seed.run({ demo: true }); house = (await db.one("SELECT id FROM markets WHERE title LIKE 'Will Gor Mahia%'")).id; outs = await db.q('SELECT id, outcome_code FROM market_outcomes WHERE market_id=$1 ORDER BY id', [house]); });
test.after(async () => { await reconciled(); await db.close(); });

test('Elo and Poisson models are sane and reproducible', () => {
  const p = ai.matchProbabilities(1500, 1500, { adv: 0 });
  assert.ok(Math.abs(p.home - p.away) < 1e-9); assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  const q = ai.matchProbabilities(1700, 1450); assert.ok(q.home > 0.6 && q.home > p.home);
  assert.deepEqual(ai.matchProbabilities(1600, 1500), ai.matchProbabilities(1600, 1500));
  const u = ai.eloUpdate(1500, 1500, 2, 0, { adv: 0 }); assert.ok(u.home > 1500 && Math.abs(u.home + u.away - 3000) < 0.02);
  assert.ok(ai.eloUpdate(1500, 1500, 1, 1, { adv: 0 }).home === 1500);
});

test('reference probability: from the model, advisory only; stored and versioned; changes no price', async () => {
  const mod = await staff('moderator'); const adm = await staff('admin');
  await assert.rejects(T((c) => intel.recommendOdds(c, { permissions: [] }, house)), /permission|forbidden/i);
  const priceBefore = (await db.one('SELECT yes_price_kes::float8 p FROM markets WHERE id=$1', [house])).p;
  const r = await T((c) => intel.recommendOdds(c, adm, house));
  assert.equal(r.available, true); assert.equal(r.outcomes.length, 1);
  assert.ok(r.suggested_price_kes >= 1 && r.suggested_price_kes <= 99 && r.probability > 0.4 && r.probability < 0.75, 'a stronger home side is a modest favourite: ' + r.probability);
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM ai_probabilities WHERE analysis_id=$1', [r.analysis_id])).n, 1);
  assert.equal((await db.one('SELECT yes_price_kes::float8 p FROM markets WHERE id=$1', [house])).p, priceBefore, 'a recommendation alone changes nothing');
  assert.ok(mod);
});

test('resolution spec must partition the result space; research evidence needs a real https source', async () => {
  const adm = await staff('admin');
  await assert.rejects(T((c) => intel.setResolutionSpec(c, adm, house, { kind: 'MATCH_RESULT', params: { home: 'A', away: 'B', outcome_covers: { [outs[0].id]: ['home'], [outs[1].id]: ['home'] } } })), /exactly once/);
  await assert.rejects(T((c) => intel.addEvidence(c, adm, house, { kind: 'SUPPORT', claim: 'Gor Mahia unbeaten in five.', source_name: 'x', source_url: 'http://insecure.example/x' })), /https/);
  await assert.rejects(T((c) => intel.addEvidence(c, adm, house, { kind: 'SUPPORT', claim: 'short', source_name: 'x', source_url: 'https://a.example/x' })), /claim/i);
  const panel = await T((c) => intel.researchPanel(c, { id: house }));
  assert.equal(panel.confidence, 'LOW'); assert.ok(panel.model && panel.model.outcomes.length === 2);
  for (const s of panel.sections) for (const i of s.items) if (s.title.match(/Supporting|Counter|statistics|Context|Unknown/)) assert.ok(i.source_url, 'every item is traceable');
});

test('feed fetcher refuses private, loopback, link-local and metadata addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(intel.isBlockedIp(ip), true, ip);
  assert.equal(intel.isBlockedIp('8.8.8.8'), false);
  for (const u of ['http://example.org/x', 'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data', 'https://[::1]/', 'https://user:pw@example.org/', 'https://example.org:8080/x', 'https://localhost/x', 'file:///etc/passwd']) await assert.rejects(intel.safeFetch(u), /./, u);
  const adm = await staff('admin');
  await assert.rejects(T((c) => intel.addFeed(c, adm, { name: 'bad', url: 'http://example.org/f.xml' })), /https/);
  await assert.rejects(T((c) => intel.addFeed(c, adm, { name: 'bad', url: 'https://10.0.0.5/f.xml' })), /not allowed/);
});

test('discovery: fixtures and dated events become suggestions; nothing is created without an admin; duplicates are ignored', async () => {
  const adm = await staff('admin');
  const list = await T((c) => intel.listSuggestions(c, adm));
  const fx = list.find((s) => /Tusker beat Kenya Police/.test(s.title)); assert.ok(fx); assert.equal(fx.outcomes.outcomes.length, 2); assert.match(fx.title, /^Will Tusker beat Kenya Police/);
  assert.ok(list.find((s) => /Jazz Festival/.test(s.title) && /20 December 2026/.test(s.title)));
  assert.equal(list.filter((s) => /Weather/.test(s.title)).length, 0);
  const marketsBefore = (await db.one('SELECT COUNT(*)::int n FROM markets')).n;
  const feed = (await db.one('SELECT id FROM information_feeds LIMIT 1')).id;
  const again = await T((c) => intel.ingest(c, feed, [{ guid: 'demo-1', title: 'Tusker vs Kenya Police: league fixture set for 6 December', url: 'https://example.org/demo/tusker-police' }]));
  assert.equal(again.items_added, 0);
  const acc = await T((c) => intel.decideSuggestion(c, adm, fx.id, 'ACCEPTED'));
  assert.ok(acc.prefill.title && /draft only/.test(acc.note));
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM markets')).n, marketsBefore, 'accepting only returns a draft');
  await assert.rejects(T((c) => intel.decideSuggestion(c, adm, fx.id, 'DISMISSED')), /Already/);
  assert.equal(intel.parseFeed('<rss><channel><item><title>A vs B: x</title><link>https://e.org/1</link><guid>g1</guid></item><item><title>no https</title><link>http://e.org/2</link></item></channel></rss>').length, 1);
});

test('AI proposes, officers approve: conflicts, disputes, independence and approval counts are enforced', { timeout: 60000 }, async () => {
  const adm = await staff('admin'); const s1 = await staff('settle1'), s2 = await staff('settle2'), sup = await staff('superadmin');
  const players = await T(async (c) => { const o = []; for (const n of ['amina', 'dennis', 'brian']) o.push(await auth.publicUser(c, (await c.one('SELECT id FROM users WHERE username=$1', [n])).id)); return o; });
  const hm = await binary('Will Gor Mahia win at home against Tusker on 6 December 2026?', 'Gor Mahia', 'Tusker');
  const o = [{ id: hm.yes }, { id: hm.no }];
  await pair(hm, players[0], players[1]);
  await db.q("UPDATE markets SET closes_at=now()-interval '1 second' WHERE id=$1", [hm.id]); await T((c) => markets.tick(c));
  const pr0 = await T((c) => intel.proposeResolution(c, s1, hm.id)); assert.equal(pr0.reason, 'NO_RESULT_EVIDENCE');
  const ev = (src, url, h, a) => T((c) => intel.addEvidence(c, s1, hm.id, { kind: 'RESULT', claim: `Full time ${h}-${a}`, source_name: src, source_url: url, fact: { home_goals: h, away_goals: a } }));
  await ev('FKF', 'https://www.fkf.co.ke/match/1', 2, 1); await ev('Nation', 'https://nation.africa/m/1', 1, 1);
  const conflict = await T((c) => intel.proposeResolution(c, s1, hm.id)); assert.equal(conflict.reason, 'SOURCES_CONFLICT');
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM settlements WHERE market_id=$1", [hm.id])).n, 0, 'AI refuses to choose');
  const bad = (await db.one("SELECT id FROM research_evidence WHERE market_id=$1 AND claim LIKE '%1-1'", [hm.id])).id;
  await T((c) => intel.retractEvidence(c, s1, bad, 'Wrong fixture, withdrawn'));
  await ev('Standard', 'https://standardmedia.co.ke/m/1', 2, 1);
  await T((c) => intel.addEvidence(c, s1, hm.id, { kind: 'CONTEXT', claim: 'x'.repeat(12), source_name: 'a', source_url: 'https://a.example/x' }));
  const pr = await T((c) => intel.proposeResolution(c, s1, hm.id));
  assert.equal(pr.proposed, true); assert.equal(pr.outcome_id, hm.yes); assert.equal(pr.confidence, 'HIGH'); assert.equal(pr.required_approvals, 1);
  const st = await db.one('SELECT origin, status FROM settlements WHERE id=$1', [pr.settlement_id]); assert.equal(st.origin, 'AI_ASSISTED'); assert.equal(st.status, 'PROPOSED');
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM payouts WHERE settlement_id=$1", [pr.settlement_id])).n, 0, 'proposal moves no money');
  await assert.rejects(T((c) => settlement.approve(c, s1, pr.settlement_id, 'APPROVED')), /different officer/);
  const bal0 = (await db.one("SELECT SUM(balance_minor)::bigint s FROM ledger_accounts WHERE account_type='AVAILABLE'")).s;
  assert.equal((await T((c) => settlement.approve(c, s2, pr.settlement_id, 'APPROVED'))).status, 'EXECUTED');
  assert.ok((await db.one("SELECT SUM(balance_minor)::bigint s FROM ledger_accounts WHERE account_type='AVAILABLE'")).s > bal0);
  assert.equal((await db.one('SELECT status FROM markets WHERE id=$1', [hm.id])).status, 'SETTLED');
  // Elo moved exactly once for the settled match
  const ru = await db.one('SELECT * FROM rating_updates WHERE market_id=$1', [hm.id]); assert.ok(ru && Number(ru.home_after) > Number(ru.home_before));
  const perf = await T((c) => intel.performance(c, adm)); assert.ok(perf.brier_score === null || perf.brier_score >= 0);
  await reconciled();
});

test('low-confidence AI result needs two approvals; open dispute blocks the assistant', { timeout: 60000 }, async () => {
  const adm = await staff('admin'), s1 = await staff('settle1'), s2 = await staff('settle2'), sup = await staff('superadmin');
  const hm = await binary('Will Kenya beat Uganda on 12 December 2026?', 'Kenya', 'Uganda');
  const amina = await staff('amina'), brian = await staff('brian');
  await pair(hm, brian, amina, 55, 4);
  await db.q("UPDATE markets SET closes_at=now()-interval '1 second' WHERE id=$1", [hm.id]); await T((c) => markets.tick(c));
  await T((c) => intel.addEvidence(c, s1, hm.id, { kind: 'RESULT', claim: 'Full time 0-1', source_name: 'Blog', source_url: 'https://someblog.example/r', fact: { home_goals: 0, away_goals: 1 } }));
  const pr = await T((c) => intel.proposeResolution(c, s1, hm.id)); assert.equal(pr.confidence, 'LOW'); assert.equal(pr.required_approvals, 2);
  const a1 = await T((c) => settlement.approve(c, s2, pr.settlement_id, 'APPROVED')); assert.equal(a1.status, 'AWAITING_MORE_APPROVALS');
  await assert.rejects(T((c) => settlement.approve(c, s2, pr.settlement_id, 'APPROVED')), /already/i);
  assert.equal((await db.one('SELECT status FROM markets WHERE id=$1', [hm.id])).status, 'RESULT_PENDING');
  assert.equal((await T((c) => settlement.approve(c, sup, pr.settlement_id, 'APPROVED'))).status, 'EXECUTED');
  await db.q("INSERT INTO disputes(market_id, user_id, reason) VALUES ($1,$2,'test')", [house, amina.id]);
  await db.q("UPDATE markets SET status='RESULT_PENDING' WHERE id=$1", [house]);
  assert.equal((await T((c) => intel.proposeResolution(c, s1, house))).reason, 'OPEN_DISPUTE');
  await reconciled();
});

test('risk scan creates deduplicated alerts, never acts on accounts, requires a reasoned human review', async () => {
  const risk = await staff('risk'); const amina = await staff('amina');
  const status0 = (await db.one('SELECT status FROM users WHERE id=$1', [amina.id])).status;
  await db.q("INSERT INTO user_sessions(user_id, token_hash, expires_at, ip) SELECT id, md5(random()::text||id), now()+interval '1 day', '203.0.113.9' FROM users WHERE username IN ('dennis','brian')");
  const pub = await db.one("SELECT id FROM markets WHERE title LIKE 'Will Harambee%'");
  const d = await staff('dennis'), b = await staff('brian');
  await db.q("INSERT INTO trades(market_id, kind, price_kes, qty, amount_minor, bid_user_id, ask_user_id) VALUES ($1,'MINT',40,1,10000,$2,$3)", [pub.id, d.id, b.id]);
  const r1 = await T((c) => intel.scanRisk(c, risk)); const r2 = await T((c) => intel.scanRisk(c, risk));
  assert.equal(r2.new_alerts, 0, 'second scan adds nothing');
  assert.equal((await db.one('SELECT status FROM users WHERE id=$1', [amina.id])).status, status0);
  const alerts = await T((c) => intel.listAlerts(c, risk)); const open = alerts.find((a) => a.status === 'OPEN');
  if (open) { await assert.rejects(T((c) => intel.reviewAlert(c, risk, open.id, 'DISMISSED', '')), /reasoning/i); await T((c) => intel.reviewAlert(c, risk, open.id, 'DISMISSED', 'Reviewed — benign')); await assert.rejects(T((c) => intel.reviewAlert(c, risk, open.id, 'CONFIRMED', 'again please')), /already/i); }
  await assert.rejects(T((c) => intel.scanRisk(c, amina)), /permission|forbidden/i);
});
