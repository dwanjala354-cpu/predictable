'use strict';
// PREDICTABLE intelligence layer (stage two). Four services behind one boundary:
//   odds     — Elo + Poisson probabilities → recommended odds (a human publishes them)
//   research — sourced evidence panel; every claim carries a URL and a retrieval time
//   discovery— approved feeds → market suggestions for an admin (nothing is ever auto-published)
//   risk     — deterministic detectors → alerts a risk officer reviews (nothing is ever auto-actioned)
//   resolution — "AI proposes, admin approves": proposes a result from agreeing sources, never executes it.
// HARD LIMITS (enforced by construction): this module never calls ledger.post, never edits balances, never changes
// committed market rules, never approves anything. Its only writes are to AI/research/alert tables, plus a
// settlement *proposal* via the same settlement.propose() a human officer uses.
const dns = require('dns').promises, net = require('net'), https = require('https');
const ai = require('./ai');
const { bad, forbidden, notFound, conflict } = require('./util');
const { getSetting, audit, notify } = require('./common');
const { can } = require('./auth');

const need = (user, perm) => { if (!can(user, perm)) throw forbidden(); };
const num = async (c, k, d) => { const v = parseFloat(await getSetting(c, k)); return Number.isFinite(v) ? v : d; };
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };

// ═════════════ Odds intelligence ═════════════
async function ratingParams(c) { return { adv: await num(c, 'elo_home_advantage', 65), k: await num(c, 'elo_k', 30), base: await num(c, 'base_goals', 1.35), scale: await num(c, 'goal_scale', 0.6) }; }
const listRatings = (c, user) => { need(user, 'admin.dashboard'); return c.q('SELECT id, sport, name, rating::float8 AS rating, matches, updated_at FROM team_ratings ORDER BY rating DESC, name'); };
async function setRating(c, user, { name, rating, sport = 'football' }) {
  need(user, 'research.manage');
  const n = String(name || '').trim(), r = Number(rating);
  if (n.length < 2 || n.length > 60) throw bad('BAD_NAME', 'Team name must be 2–60 characters');
  if (!(r >= 800 && r <= 2800)) throw bad('BAD_RATING', 'Rating must be between 800 and 2800');
  await c.q(`INSERT INTO team_ratings(sport, name, rating) VALUES ($1,$2,$3) ON CONFLICT (sport, name) DO UPDATE SET rating=$3, updated_at=now()`, [sport, n, r]);
  await audit(c, user.id, 'ai.rating_set', 'team', null, { name: n, rating: r });
}
async function rating(c, name) { const r = await c.one("SELECT rating::float8 AS rating, matches FROM team_ratings WHERE sport='football' AND lower(name)=lower($1)", [name]); return r || null; }

// Resolution spec: which fact decides which outcome. Used by both the odds model and the resolution assistant.
// params = { home, away, outcome_covers: { "<outcomeId>": ["home"] | ["draw","away"] | … } } — the covers must partition {home,draw,away}.
// THRESHOLD params = { yes_outcome, no_outcome, op: '>='|'>'|'<='|'<', threshold }
async function setResolutionSpec(c, user, marketId, { kind, params }) {
  need(user, 'research.manage');
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [marketId]); if (!m) throw notFound('Market not found');
  if (['SETTLED', 'VOID', 'CANCELLED', 'REJECTED'].includes(m.status)) throw conflict('BAD_STATE', 'This market is already finished');
  const outs = (await c.q('SELECT id FROM market_outcomes WHERE market_id=$1', [marketId])).map((o) => String(o.id));
  let clean;
  if (kind === 'MATCH_RESULT') {
    const { home, away, outcome_covers: cov } = params || {};
    if (!home || !away || String(home).toLowerCase() === String(away).toLowerCase()) throw bad('BAD_SPEC', 'Name two different teams (home and away)');
    const seen = [];
    for (const [oid, parts] of Object.entries(cov || {})) {
      if (!outs.includes(String(oid))) throw bad('BAD_SPEC', 'An outcome in the spec does not belong to this market');
      for (const p of parts) { if (!['home', 'draw', 'away'].includes(p)) throw bad('BAD_SPEC', 'Cover values are home, draw or away'); seen.push(p); }
    }
    if (seen.length !== 3 || new Set(seen).size !== 3) throw bad('BAD_SPEC', 'Outcomes must cover home win, draw and away win exactly once between them');
    clean = { home: String(home).trim(), away: String(away).trim(), outcome_covers: cov };
  } else if (kind === 'THRESHOLD') {
    const { yes_outcome, no_outcome, op, threshold } = params || {};
    if (!outs.includes(String(yes_outcome)) || !outs.includes(String(no_outcome)) || String(yes_outcome) === String(no_outcome)) throw bad('BAD_SPEC', 'Pick the "yes" and "no" outcomes of this market');
    if (!['>=', '>', '<=', '<'].includes(op) || !Number.isFinite(Number(threshold))) throw bad('BAD_SPEC', 'Give a comparison (>=, >, <=, <) and a numeric threshold');
    clean = { yes_outcome: +yes_outcome, no_outcome: +no_outcome, op, threshold: Number(threshold) };
  } else throw bad('BAD_SPEC', 'kind must be MATCH_RESULT or THRESHOLD');
  await c.q(`INSERT INTO market_resolution_specs(market_id, kind, params, set_by) VALUES ($1,$2,$3::jsonb,$4)
             ON CONFLICT (market_id) DO UPDATE SET kind=$2, params=$3::jsonb, set_by=$4`, [marketId, kind, JSON.stringify(clean), user.id]);
  await audit(c, user.id, 'ai.resolution_spec', 'market', marketId, { kind, params: clean });
  return { ok: true, kind, params: clean };
}
const getSpec = (c, marketId) => c.one('SELECT * FROM market_resolution_specs WHERE market_id=$1', [marketId]);

// Model probabilities per outcome for a MATCH_RESULT market, or null when no model applies.
async function modelProbabilities(c, m) {
  const spec = await getSpec(c, m.id);
  if (!spec || spec.kind !== 'MATCH_RESULT') return null;
  const [h, a] = [await rating(c, spec.params.home), await rating(c, spec.params.away)];
  const missing = [!h && spec.params.home, !a && spec.params.away].filter(Boolean);
  if (missing.length) return { unavailable: true, reason: `No rating yet for ${missing.join(' and ')}. Add ratings under AI → Team ratings.` };
  const P = await ratingParams(c);
  const wdl = ai.matchProbabilities(h.rating, a.rating, P);
  const per = Object.entries(spec.params.outcome_covers).map(([oid, parts]) => ({ outcome_id: +oid, probability: Math.min(0.99999, Math.max(0.00001, parts.reduce((s, p) => s + wdl[p], 0))) }));
  return { wdl, per, ratings: { home: h.rating, away: a.rating }, params: P, spec: spec.params };
}

// Reference probability for a market's YES side, from the rating model. Advisory only: a person decides the opening price.
async function recommendOdds(c, user, marketId, { persist = true } = {}) {
  need(user, 'admin.dashboard');
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [marketId]); if (!m) throw notFound('Market not found');
  const mp = await modelProbabilities(c, m);
  if (!mp) return { available: false, reason: 'No statistical model is attached to this market. Reference probabilities exist for football match markets once a resolution spec is set; other categories stay manual.' };
  if (mp.unavailable) return { available: false, reason: mp.reason };
  const yes = await c.one("SELECT id FROM market_outcomes WHERE market_id=$1 AND outcome_code='YES'", [marketId]);
  const py = mp.per.find((x) => x.outcome_id === yes.id);
  if (!py) return { available: false, reason: 'The resolution spec does not map any result to the YES outcome.' };
  const suggested = Math.min(99, Math.max(1, Math.round(py.probability * 100)));
  const rows = [{ outcome_id: yes.id, outcome_name: 'Yes', probability: Number(py.probability.toFixed(5)), suggested_price_kes: suggested }];
  const out = { available: true, model_version: ai.MODEL_ELO, probability: rows[0].probability, suggested_price_kes: suggested, current_price_kes: Number(m.yes_price_kes), outcomes: rows, expected_goals: mp.wdl.expected_goals, ratings: mp.ratings,
    explanation: `Ratings ${mp.spec.home} ${mp.ratings.home.toFixed(0)} vs ${mp.spec.away} ${mp.ratings.away.toFixed(0)} (home advantage ${mp.params.adv}). Expected goals ${mp.wdl.expected_goals.home}–${mp.wdl.expected_goals.away}. The model's chance of YES is ${(py.probability * 100).toFixed(1)}%, so a fair YES contract is about KES ${suggested}. This is a statistical estimate, not a guarantee; the market price reflects what traders believe.` };
  if (persist) {
    const a = await c.one("INSERT INTO ai_analyses(market_id, analysis_type, model_version, summary) VALUES ($1,'ODDS_RECOMMENDATION',$2,$3::jsonb) RETURNING id", [marketId, ai.MODEL_ELO, JSON.stringify({ outcomes: rows, ratings: mp.ratings })]);
    await c.q('INSERT INTO ai_probabilities(analysis_id, outcome_id, probability) VALUES ($1,$2,$3)', [a.id, yes.id, Math.min(0.99999, py.probability).toFixed(5)]);
    out.analysis_id = a.id;
  }
  return out;
}

// Called inside the settlement transaction. A failure here must never undo or block a settlement → savepoint.
async function onSettled(c, m, s) {
  await c.q('SAVEPOINT ai_after_settle');
  try {
    const spec = await getSpec(c, m.id);
    if (spec && spec.kind === 'MATCH_RESULT' && s.outcome_id) {
      const ev = await c.q("SELECT fact FROM research_evidence WHERE market_id=$1 AND kind='RESULT' AND retracted_at IS NULL AND fact IS NOT NULL ORDER BY id DESC LIMIT 1", [m.id]);
      const f = ev[0] && ev[0].fact;
      const covers = spec.params.outcome_covers[String(s.outcome_id)] || [];
      if (f && Number.isInteger(f.home_goals) && Number.isInteger(f.away_goals) && covers.includes(resultClass(f.home_goals, f.away_goals))) {
        const h = await rating(c, spec.params.home), a = await rating(c, spec.params.away);
        if (h && a) {
          const P = await ratingParams(c), u = ai.eloUpdate(h.rating, a.rating, f.home_goals, f.away_goals, P);
          const ins = await c.q(`INSERT INTO rating_updates(market_id, home, away, home_before, away_before, home_after, away_after) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (market_id) DO NOTHING RETURNING market_id`, [m.id, spec.params.home, spec.params.away, h.rating, a.rating, u.home, u.away]);
          if (ins.length) {
            await c.q("UPDATE team_ratings SET rating=$2, matches=matches+1, updated_at=now() WHERE sport='football' AND lower(name)=lower($1)", [spec.params.home, u.home]);
            await c.q("UPDATE team_ratings SET rating=$2, matches=matches+1, updated_at=now() WHERE sport='football' AND lower(name)=lower($1)", [spec.params.away, u.away]);
          }
        }
      }
    }
    await c.q('RELEASE SAVEPOINT ai_after_settle');
  } catch (e) { await c.q('ROLLBACK TO SAVEPOINT ai_after_settle'); await c.q('RELEASE SAVEPOINT ai_after_settle'); }
}
const resultClass = (h, a) => (h > a ? 'home' : h === a ? 'draw' : 'away');

// Brier score of recorded probabilities against settled results, plus how often humans overrode the suggestion.
async function performance(c, user) {
  need(user, 'admin.dashboard');
  const rows = await c.q(`SELECT a.id, a.market_id, p.outcome_id, p.probability::float8 AS p, s.outcome_id AS won
      FROM ai_analyses a JOIN ai_probabilities p ON p.analysis_id=a.id
      JOIN settlements s ON s.market_id=a.market_id AND s.status='EXECUTED' AND s.outcome_id IS NOT NULL
     WHERE a.analysis_type='ODDS_RECOMMENDATION' AND a.id = (SELECT MAX(id) FROM ai_analyses x WHERE x.market_id=a.market_id AND x.analysis_type='ODDS_RECOMMENDATION')`);
  const by = new Map();
  for (const r of rows) { const e = by.get(r.market_id) || { s: 0 }; e.s += Math.pow(r.p - (r.outcome_id === r.won ? 1 : 0), 2); by.set(r.market_id, e); }
  const recs = await c.q(`SELECT DISTINCT ON (a.market_id) a.market_id, a.summary FROM ai_analyses a WHERE a.analysis_type='ODDS_RECOMMENDATION' ORDER BY a.market_id, a.id DESC`);
  let overrides = 0, compared = 0;
  for (const r of recs) for (const o of r.summary.outcomes || []) {
    const cur = await c.one('SELECT initial_price_kes FROM markets WHERE id=$1', [r.market_id]); if (!cur) continue;
    compared++; if (Math.abs(cur.initial_price_kes - o.suggested_price_kes) > 3) overrides++;
  }
  const briers = [...by.values()].map((e) => e.s);
  return { model_version: ai.MODEL_ELO, settled_markets_scored: briers.length, brier_score: briers.length ? Number((briers.reduce((a, b) => a + b, 0) / briers.length).toFixed(4)) : null,
    reference: 'A model that always says 50% on a yes/no market scores 0.5; lower is better.',
    recommendations_made: recs.length, outcomes_compared: compared, human_overrides: overrides,
    note: briers.length < 20 ? 'Too few settled markets to judge calibration — treat the score as indicative only.' : 'Sample is large enough to monitor calibration.' };
}

// ═════════════ Research intelligence ═════════════
const KINDS = ['SUPPORT', 'COUNTER', 'STAT', 'CONTEXT', 'UNKNOWN', 'RESULT'];
async function addEvidence(c, user, marketId, e) {
  need(user, 'research.manage');
  const m = await c.one('SELECT id FROM markets WHERE id=$1', [marketId]); if (!m) throw notFound('Market not found');
  const claim = String(e.claim || '').trim();
  if (!KINDS.includes(e.kind)) throw bad('BAD_KIND', `Kind must be one of ${KINDS.join(', ')}`);
  if (claim.length < 10 || claim.length > 600) throw bad('BAD_CLAIM', 'State the claim in 10–600 characters');
  if (!/^https:\/\/[^\s]+\.[^\s]+/i.test(String(e.source_url || ''))) throw bad('BAD_SOURCE', 'Every claim needs an https:// source link');
  if (!String(e.source_name || '').trim()) throw bad('BAD_SOURCE', 'Name the source (publisher or body)');
  let fact = null;
  if (e.kind === 'RESULT') {
    const f = e.fact || {};
    const spec = await getSpec(c, marketId);
    if (spec && spec.kind === 'MATCH_RESULT') { if (!Number.isInteger(f.home_goals) || !Number.isInteger(f.away_goals) || f.home_goals < 0 || f.away_goals < 0 || f.home_goals > 99 || f.away_goals > 99) throw bad('BAD_FACT', 'Result evidence needs whole-number home_goals and away_goals (full time)'); fact = { home_goals: f.home_goals, away_goals: f.away_goals, period: 'FT' }; }
    else if (spec && spec.kind === 'THRESHOLD') { if (!Number.isFinite(Number(f.value))) throw bad('BAD_FACT', 'Result evidence needs a numeric value'); fact = { value: Number(f.value) }; }
    else throw bad('NO_SPEC', 'Set a resolution spec for this market before adding result evidence');
  }
  const pub = e.published_at && !isNaN(Date.parse(e.published_at)) ? new Date(e.published_at).toISOString() : null;
  const r = await c.one(`INSERT INTO research_evidence(market_id, kind, claim, source_name, source_url, published_at, fact, origin, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'MANUAL',$8) RETURNING id`,
    [marketId, e.kind, claim, String(e.source_name).trim().slice(0, 120), String(e.source_url).trim(), pub, fact ? JSON.stringify(fact) : null, user.id]);
  await audit(c, user.id, 'research.add', 'market', marketId, { evidence_id: r.id, kind: e.kind, source: host(e.source_url) });
  return { id: r.id };
}
async function retractEvidence(c, user, id, reason) {
  need(user, 'research.manage');
  if (!reason || reason.trim().length < 5) throw bad('REASON_REQUIRED', 'Say why this evidence is being withdrawn');
  const r = await c.q('UPDATE research_evidence SET retracted_at=now(), retracted_by=$2 WHERE id=$1 AND retracted_at IS NULL RETURNING market_id', [id, user.id]);
  if (!r.length) throw notFound('Evidence not found or already withdrawn');
  await audit(c, user.id, 'research.retract', 'market', r[0].market_id, { evidence_id: id, reason: reason.trim() });
}

async function researchPanel(c, m) {
  const ev = await c.q('SELECT id, kind, claim, source_name, source_url, published_at, retrieved_at, fact FROM research_evidence WHERE market_id=$1 AND retracted_at IS NULL ORDER BY id', [m.id]);
  const by = (k) => ev.filter((e) => k.includes(e.kind)).map((e) => ({ id: e.id, claim: e.claim, source_name: e.source_name, source_url: e.source_url, published_at: e.published_at, retrieved_at: e.retrieved_at }));
  const evidential = ev.filter((e) => e.kind !== 'RESULT');
  const domains = new Set(evidential.map((e) => host(e.source_url)));
  const dates = evidential.map((e) => e.published_at && Date.parse(e.published_at)).filter(Boolean);
  const newest = dates.length ? Math.max(...dates) : null;
  const ageDays = newest ? Math.floor((Date.now() - newest) / 864e5) : null;
  const hasBoth = ev.some((e) => e.kind === 'SUPPORT') && ev.some((e) => e.kind === 'COUNTER');
  const conf = !domains.size ? 'NONE' : domains.size >= 3 && hasBoth && ageDays !== null && ageDays <= 7 ? 'HIGH' : domains.size >= 2 ? 'MEDIUM' : 'LOW';
  let model = null;
  {
    try { const mp = await modelProbabilities(c, m); if (mp && !mp.unavailable) { const names = new Map((await c.q('SELECT id, outcome_name FROM market_outcomes WHERE market_id=$1', [m.id])).map((o) => [o.id, o.outcome_name])); model = { model_version: ai.MODEL_ELO, outcomes: mp.per.map((x) => ({ outcome: names.get(x.outcome_id), probability: Number(x.probability.toFixed(3)) })), expected_goals: mp.wdl.expected_goals, note: 'Statistical estimate from team ratings. It is not a pool share and not a guarantee.' }; } } catch (e) { model = null; }
  }
  const confText = { NONE: 'No sourced evidence yet, so no confidence can be stated.', LOW: 'One source only. Treat as unverified.', MEDIUM: `${domains.size} independent sources.`, HIGH: `${domains.size} independent sources, both sides covered, newest item ${ageDays} day(s) old.` }[conf];
  return {
    model_version: 'research-ledger-v1.0',
    status: ev.length ? 'EVIDENCE_AVAILABLE' : 'NO_EVIDENCE_YET',
    summary: ev.length ? `${evidential.length} sourced item(s) from ${domains.size} source(s). Every line links to where it came from.` : 'No evidence has been added to this market yet. Research items appear here only when a person adds them with a source link or an approved feed supplies them.',
    sections: [
      { title: 'Supporting evidence', items: by(['SUPPORT']) }, { title: 'Counter-arguments', items: by(['COUNTER']) },
      { title: 'Relevant statistics', items: by(['STAT']) }, { title: 'Context', items: by(['CONTEXT']) },
      { title: 'Source links', items: [...new Map(ev.map((e) => [e.source_url, { source_name: e.source_name, source_url: e.source_url }])).values()] },
      { title: 'Data freshness', items: [{ claim: newest ? `Newest item published ${ageDays} day(s) ago${ageDays > 14 ? ' — may be stale' : ''}.` : 'No publication dates recorded.' }] },
      { title: 'Confidence and uncertainty', items: [{ claim: `Confidence: ${conf}. ${confText}` }] },
      { title: 'Unknown factors', items: by(['UNKNOWN']) },
    ],
    confidence: conf, model, results_recorded: ev.filter((e) => e.kind === 'RESULT').length,
    note: 'Pool percentages on public markets show where money is committed — they are not probabilities.',
    market_id: m.id,
  };
}

// ═════════════ Market discovery ═════════════
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function findDate(text, ref = new Date()) {
  const iso = text.match(/\b(20\d\d)-(\d\d)-(\d\d)\b/); if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  const re = new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})|(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(20\\d\\d))?\\b`, 'i');
  const m = text.match(re); if (!m) return null;
  const day = +(m[1] || m[4]), mon = MONTHS.indexOf((m[2] || m[3]).toLowerCase());
  let y = m[5] ? +m[5] : ref.getUTCFullYear(); let d = new Date(Date.UTC(y, mon, day));
  if (!m[5] && d < ref) d = new Date(Date.UTC(y + 1, mon, day));
  return isNaN(d) || d.getUTCDate() !== day ? null : d;
}
const fmtDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()][0].toUpperCase()}${MONTHS[d.getUTCMonth()].slice(1)} ${d.getUTCFullYear()}`;
// Deterministic templates — no generation. Each suggestion is validated with the same rules a user's market faces.
function suggestFromItem(item, ref = new Date()) {
  const text = `${item.title}. ${item.summary || ''}`, out = [];
  const fx = String(item.title).match(/^\s*(.{2,40}?)\s+(?:vs\.?|v|versus)\s+(.{2,40}?)\s*(?::|-|–|\||,|\s(?:on|at|in|this|will|to|set|slated|scheduled)\b|$)/i);
  if (fx) {
    const [home, away] = [fx[1].trim(), fx[2].trim()], when = findDate(text, ref);
    out.push({ template: 'MATCH_RESULT_3WAY', category_slug: 'sports', title: `Will ${home} beat ${away}${when ? ' on ' + fmtDate(when) : ''}?`, outcomes: ['Yes', 'No'], event_at: when ? when.toISOString() : null, home, away,
      rationale: `Fixture detected in "${item.title}". Yes means the first-named team wins on the full-time score (extra time excluded); a draw or a loss is No.`, method: 'Full-time score after 90 minutes plus stoppage time; extra time and penalty shoot-outs are ignored.' });
  } else {
    const ev = text.match(/\b(festival|concert|summit|marathon|expo|conference|tournament|rally|launch)\b/i), when = findDate(text, ref);
    if (ev && when) {
      const full = String(item.title).replace(/\s+/g, ' ').trim(); const cut = full.search(/\s+(announced|set for|to be held|will|slated|scheduled|returns|lined up|confirmed|postponed)\b/i); const name = (cut > 3 ? full.slice(0, cut) : full).slice(0, 90);
      out.push({ template: 'EVENT_GOES_AHEAD', category_slug: 'entertainment', title: `Will "${name}" take place on ${fmtDate(when)} as announced?`, outcomes: ['Yes', 'No'], event_at: when.toISOString(),
        rationale: `Dated public event announced in "${item.title}".`, method: 'Yes if the event starts on the announced date as confirmed by the organiser or a major news outlet; No if cancelled or moved to another date.' });
    }
  }
  return out.map((s) => ({ ...s, source_url: item.url, issues: ai.validateQuestion({ title: s.title, outcomes: s.outcomes, resolution_source: item.url, resolution_method: s.method }).issues }));
}

async function addFeed(c, user, { name, url, category_slug, kind = 'RSS' }) {
  need(user, 'research.manage');
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(String(url || ''))) throw bad('BAD_URL', 'Feeds must be https:// addresses');
  if (!String(name || '').trim()) throw bad('BAD_NAME', 'Name the feed');
  const host0 = new URL(url).hostname;
  if (net.isIP(host0) && isBlockedIp(host0)) throw bad('BLOCKED_ADDRESS', 'That address is not allowed');
  try { const f = await c.one('INSERT INTO information_feeds(name, url, kind, category_slug, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name.trim(), url.trim(), kind === 'JSON' ? 'JSON' : 'RSS', category_slug || null, user.id]); await audit(c, user.id, 'feed.add', 'feed', f.id, { url }); return { id: f.id }; }
  catch (e) { if (e.code === '23505') throw conflict('FEED_EXISTS', 'That feed is already connected'); throw e; }
}

// SSRF-safe fetch: https only, public addresses only (DNS answer is checked and then pinned for the connection), no redirects, size and time caps.
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224; }
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); if (x === '::' || x === '::1') return true; if (x.startsWith('::ffff:')) { const v4 = x.slice(7); return net.isIPv4(v4) ? isBlockedIp(v4) : true; } return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff'); }
  return true;
}
async function safeFetch(urlStr, { timeoutMs = 8000, maxBytes = 1048576 } = {}) {
  let u; try { u = new URL(urlStr); } catch (e) { throw new Error('Invalid URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Only plain https:// addresses are allowed');
  if (u.port && u.port !== '443') throw new Error('Only the standard https port is allowed');
  const name = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(name) ? [{ address: name, family: net.isIP(name) }] : await dns.lookup(name, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error('Address is not publicly routable — blocked');
  const pin = addrs[0];
  return new Promise((resolve, reject) => {
    const req = https.request({ host: name, servername: net.isIP(name) ? undefined : name, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs, agent: false, headers: { 'user-agent': 'PredictableFeedBot/1.0', accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml;q=0.9' }, lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)) }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Feed returned HTTP ${res.statusCode} (redirects are not followed)`)); }
      let n = 0; const chunks = [];
      res.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(new Error('Feed too large')); } else chunks.push(d); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('Feed timed out'))); req.on('error', reject); req.end();
  });
}
const clean = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
function parseFeed(xml) {
  const items = [], blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const tag = (b, t) => { const m = b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? clean(m[1]) : ''; };
  for (const b of blocks.slice(0, 50)) {
    const link = tag(b, 'link') || ((b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '');
    const title = tag(b, 'title'); if (!title || !/^https:\/\//i.test(link)) continue;
    const pub = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated');
    items.push({ guid: tag(b, 'guid') || tag(b, 'id') || link, title: title.slice(0, 300), url: link, published_at: pub && !isNaN(Date.parse(pub)) ? new Date(pub).toISOString() : null, summary: (tag(b, 'description') || tag(b, 'summary')).slice(0, 800) });
  }
  return items;
}
// Network fetch happens OUTSIDE any database transaction (see server route); this stores the result.
async function ingest(c, feedId, items, err) {
  const f = await c.one('SELECT * FROM information_feeds WHERE id=$1', [feedId]); if (!f) throw notFound('Feed not found');
  await c.q('UPDATE information_feeds SET last_fetched_at=now(), last_error=$2 WHERE id=$1', [feedId, err ? String(err).slice(0, 300) : null]);
  let added = 0, suggested = 0;
  for (const it of items || []) {
    const r = await c.q('INSERT INTO feed_items(feed_id, guid, title, url, published_at, summary) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (feed_id, guid) DO NOTHING RETURNING id', [feedId, it.guid, it.title, it.url, it.published_at || null, it.summary || null]);
    if (!r.length) continue; added++;
    for (const s of suggestFromItem(it)) {
      const ok = await c.q(`INSERT INTO market_suggestions(feed_item_id, template, title, category_slug, outcomes, rationale, source_url, issues) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb) ON CONFLICT (feed_item_id, template) DO NOTHING RETURNING id`,
        [r[0].id, s.template, s.title, f.category_slug || s.category_slug, JSON.stringify({ outcomes: s.outcomes, event_at: s.event_at, home: s.home, away: s.away, method: s.method }), s.rationale, s.source_url, JSON.stringify(s.issues)]);
      suggested += ok.length;
    }
  }
  return { items_added: added, suggestions_added: suggested, error: err || null };
}
async function refreshFeed(db, user, feedId) {              // composes fetch (no tx) + ingest (tx)
  const f = await db.tx(async (c) => { need(user, 'research.manage'); return c.one('SELECT * FROM information_feeds WHERE id=$1 AND active', [feedId]); });
  if (!f) throw notFound('Feed not found');
  let items = [], err = null;
  try { items = parseFeed(await safeFetch(f.url)); } catch (e) { err = e.message; }
  return db.tx((c) => ingest(c, feedId, items, err));
}
const listFeeds = (c, user) => { need(user, 'research.manage'); return c.q('SELECT f.*, (SELECT COUNT(*)::int FROM feed_items i WHERE i.feed_id=f.id) AS items FROM information_feeds f ORDER BY f.id'); };
const listSuggestions = (c, user) => { need(user, 'research.manage'); return c.q("SELECT s.*, f.name AS feed_name FROM market_suggestions s LEFT JOIN feed_items i ON i.id=s.feed_item_id LEFT JOIN information_feeds f ON f.id=i.feed_id ORDER BY (s.status='NEW') DESC, s.id DESC LIMIT 100"); };
// Accepting never publishes anything: it marks the suggestion and hands back a prefilled draft for the admin's own create form.
async function decideSuggestion(c, user, id, decision) {
  need(user, 'research.manage');
  if (!['ACCEPTED', 'DISMISSED'].includes(decision)) throw bad('BAD_DECISION', 'Accept or dismiss');
  const s = await c.one('SELECT * FROM market_suggestions WHERE id=$1 FOR UPDATE', [id]); if (!s) throw notFound('Suggestion not found');
  if (s.status !== 'NEW') throw conflict('ALREADY_DECIDED', `Already ${s.status.toLowerCase()}`);
  await c.q('UPDATE market_suggestions SET status=$2, reviewed_by=$3 WHERE id=$1', [id, decision, user.id]);
  await audit(c, user.id, `suggestion.${decision.toLowerCase()}`, 'suggestion', id, { title: s.title });
  if (decision === 'DISMISSED') return { status: 'DISMISSED' };
  const o = s.outcomes;
  return { status: 'ACCEPTED', prefill: { title: s.title, category_slug: s.category_slug, outcomes: o.outcomes, event_at: o.event_at, resolution_source: s.source_url, resolution_method: o.method, resolution_spec_hint: o.home ? { kind: 'MATCH_RESULT', home: o.home, away: o.away } : null }, note: 'This is a draft only. Create the market from the admin form; it still goes through normal review.' };
}

// ═════════════ Risk intelligence ═════════════
const LOOP = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '', null]);
async function scanRisk(c, user) {
  if (user) need(user, 'risk.view');
  const found = [];
  const add = (type, severity, user_id, market_id, detail, key) => found.push({ type, severity, user_id: user_id || null, market_id: market_id || null, detail, key });
  const admin = require('./admin');
  for (const f of await admin.riskFlags(c)) add(f.type, f.type === 'POSITION_CONCENTRATION' ? 'MEDIUM' : 'LOW', f.user_id, f.market_id, f.detail, `${f.type}:${f.user_id || 0}:${f.market_id || 0}`);
  // Accounts that share a network address and trade with each other (possible wash trading to move funds).
  const linked = await c.q(`SELECT DISTINCT LEAST(t.bid_user_id,t.ask_user_id) u1, GREATEST(t.bid_user_id,t.ask_user_id) u2, t.market_id, s1.ip
      FROM trades t JOIN user_sessions s1 ON s1.user_id=t.bid_user_id JOIN user_sessions s2 ON s2.user_id=t.ask_user_id AND s2.ip=s1.ip
     WHERE t.bid_user_id IS NOT NULL AND t.ask_user_id IS NOT NULL AND t.bid_user_id<>t.ask_user_id AND s1.ip IS NOT NULL`);
  for (const r of linked) if (!LOOP.has(r.ip)) add('LINKED_ACCOUNTS_TRADING', 'HIGH', r.u1, r.market_id, `Users #${r.u1} and #${r.u2} share a network address and traded with each other in market #${r.market_id} — possible wash trading to move funds.`, `LINKED:${r.u1}:${r.u2}:${r.market_id}`);
  const pingpong = await c.q(`SELECT LEAST(bid_user_id,ask_user_id) u1, GREATEST(bid_user_id,ask_user_id) u2, market_id, COUNT(*)::int n FROM trades
      WHERE bid_user_id IS NOT NULL AND ask_user_id IS NOT NULL AND created_at > now() - interval '1 day' GROUP BY 1,2,3 HAVING COUNT(*) >= 8`);
  for (const r of pingpong) add('REPEATED_COUNTERPARTY', 'MEDIUM', r.u1, r.market_id, `Users #${r.u1} and #${r.u2} traded against each other ${r.n} times in a day in market #${r.market_id}.`, `PINGPONG:${r.u1}:${r.u2}:${r.market_id}:${new Date().toISOString().slice(0, 10)}`);
  const rapid = await c.q(`SELECT user_id, COUNT(*)::int n FROM orders WHERE created_at > now() - interval '1 hour' GROUP BY user_id HAVING COUNT(*) >= 40`);
  for (const r of rapid) add('RAPID_ORDERS', 'MEDIUM', r.user_id, null, `User #${r.user_id} placed ${r.n} orders in the last hour.`, `RAPID:${r.user_id}:${new Date().toISOString().slice(0, 13)}`);
  const winners = await c.q(`SELECT user_id, COUNT(*)::int n, COUNT(*) FILTER (WHERE realized_pnl_minor > 0)::int w FROM positions p JOIN markets m ON m.id=p.market_id
      WHERE m.status='SETTLED' AND p.realized_pnl_minor <> 0 GROUP BY user_id HAVING COUNT(*) >= 8 AND COUNT(*) FILTER (WHERE realized_pnl_minor > 0) * 100 >= COUNT(*) * 85`);
  for (const r of winners) add('UNUSUAL_WIN_RATE', 'MEDIUM', r.user_id, null, `User #${r.user_id} profited in ${r.w} of ${r.n} settled markets — a pattern worth a manual look (it can also be skill or insider knowledge).`, `WINRATE:${r.user_id}`);
  const heavy = await c.q(`SELECT user_id, COUNT(*)::int n FROM payment_intents WHERE created_at > now() - interval '1 day' AND status='SUCCEEDED' GROUP BY user_id HAVING COUNT(*) >= 6`);
  for (const r of heavy) add('PAYMENT_PATTERN', 'LOW', r.user_id, null, `User #${r.user_id} made ${r.n} successful deposits in one day.`, `PAYPAT:${r.user_id}:${new Date().toISOString().slice(0, 10)}`);
  let created = 0;
  for (const f of found) {
    const r = await c.q(`INSERT INTO risk_alerts(alert_type, severity, user_id, market_id, detail, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [f.type, f.severity, f.user_id, f.market_id, f.detail, f.key]);
    created += r.length;
  }
  return { detected: found.length, new_alerts: created, note: 'Alerts are advice for a risk officer. Nothing here suspends or restricts an account.' };
}
const listAlerts = (c, user, { status } = {}) => { need(user, 'risk.view'); return c.q(`SELECT a.*, u.username FROM risk_alerts a LEFT JOIN users u ON u.id=a.user_id ${status ? 'WHERE a.status=$1' : 'WHERE $1::text IS NULL OR true'} ORDER BY (a.status='OPEN') DESC, CASE a.severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, a.id DESC LIMIT 200`, [status || null]); };
async function reviewAlert(c, user, id, decision, note) {
  need(user, 'risk.view');
  if (!['CONFIRMED', 'DISMISSED'].includes(decision)) throw bad('BAD_DECISION', 'Confirm or dismiss');
  if (!note || note.trim().length < 5) throw bad('NOTE_REQUIRED', 'Record your reasoning');
  const r = await c.q("UPDATE risk_alerts SET status=$2, reviewed_by=$3, note=$4, reviewed_at=now() WHERE id=$1 AND status='OPEN' RETURNING id", [id, decision, user.id, note.trim()]);
  if (!r.length) throw conflict('ALREADY_REVIEWED', 'This alert has already been reviewed');
  await audit(c, user.id, 'risk.review', 'risk_alert', id, { decision });
}

// ═════════════ Resolution assistant — AI proposes, an administrator approves ═════════════
function decide(spec, fact) {
  if (spec.kind === 'MATCH_RESULT') {
    if (!fact || !Number.isInteger(fact.home_goals) || !Number.isInteger(fact.away_goals)) return null;
    const cls = resultClass(fact.home_goals, fact.away_goals);
    const hit = Object.entries(spec.params.outcome_covers).find(([, parts]) => parts.includes(cls));
    return hit ? +hit[0] : null;
  }
  if (!fact || !Number.isFinite(fact.value)) return null;
  const { op, threshold, yes_outcome, no_outcome } = spec.params;
  const yes = op === '>=' ? fact.value >= threshold : op === '>' ? fact.value > threshold : op === '<=' ? fact.value <= threshold : fact.value < threshold;
  return yes ? yes_outcome : no_outcome;
}
async function proposeResolution(c, user, marketId) {
  need(user, 'settlement.propose');
  const m = await c.one('SELECT * FROM markets WHERE id=$1', [marketId]); if (!m) throw notFound('Market not found');
  const spec = await getSpec(c, marketId);
  if (!spec) return { proposed: false, reason: 'NO_SPEC', message: 'No resolution spec is set for this market, so the assistant cannot map a result to an outcome.' };
  if (await c.one("SELECT 1 AS x FROM disputes WHERE market_id=$1 AND status='OPEN'", [marketId])) return { proposed: false, reason: 'OPEN_DISPUTE', message: 'This market has an open dispute. Disputed outcomes are decided by people only.' };
  const ev = await c.q("SELECT id, source_name, source_url, fact, claim FROM research_evidence WHERE market_id=$1 AND kind='RESULT' AND retracted_at IS NULL ORDER BY id", [marketId]);
  if (!ev.length) return { proposed: false, reason: 'NO_RESULT_EVIDENCE', message: 'No result evidence has been recorded yet. Add the result with its source link first.' };
  const votes = ev.map((e) => ({ ...e, domain: host(e.source_url), outcome_id: decide(spec, e.fact) })).filter((v) => v.outcome_id);
  if (!votes.length) return { proposed: false, reason: 'UNREADABLE', message: 'Evidence was recorded but no result could be read from it.' };
  const outcomes = new Set(votes.map((v) => v.outcome_id));
  if (outcomes.size > 1) {
    await c.q(`INSERT INTO risk_alerts(alert_type, severity, market_id, detail, dedupe_key) VALUES ('RESULT_SOURCES_CONFLICT','HIGH',$1,$2,$3) ON CONFLICT (dedupe_key) DO NOTHING`, [marketId, `Result sources disagree for market #${marketId}: ${votes.map((v) => `${v.domain} → outcome ${v.outcome_id}`).join('; ')}`, `CONFLICT:${marketId}:${votes.length}`]);
    return { proposed: false, reason: 'SOURCES_CONFLICT', message: 'Sources disagree about the result. A person must investigate; the assistant will not choose.', votes: votes.map((v) => ({ domain: v.domain, outcome_id: v.outcome_id })) };
  }
  const rules = await c.one('SELECT resolution_source FROM market_rules WHERE market_id=$1', [marketId]);
  const declared = String((rules && rules.resolution_source) || '').toLowerCase();
  const matchesDeclared = votes.some((v) => v.domain && declared.includes(v.domain.split('.').slice(-2).join('.')));
  const domains = new Set(votes.map((v) => v.domain));
  const confidence = domains.size >= 2 && matchesDeclared ? 'HIGH' : domains.size >= 2 ? 'MEDIUM' : 'LOW';
  const required = confidence === 'HIGH' ? 1 : 2;
  const settlement = require('./settlement');
  const outcome_id = [...outcomes][0];
  const r = await settlement.propose(c, user, marketId, { outcome_id, evidence: votes.map((v) => ({ source_url: v.source_url, note: `AI-assisted: ${v.source_name} — ${v.claim}`.slice(0, 300) })) });
  await c.q("UPDATE settlements SET origin='AI_ASSISTED', confidence=$2, required_approvals=$3 WHERE id=$1", [r.settlement_id, confidence, required]);
  await audit(c, user.id, 'ai.resolution_proposed', 'settlement', r.settlement_id, { market_id: marketId, outcome_id, confidence, sources: [...domains], matches_declared_source: matchesDeclared });
  return { proposed: true, settlement_id: r.settlement_id, outcome_id, confidence, matches_declared_source: matchesDeclared, sources: [...domains], required_approvals: required, plan: r.plan,
    message: `Proposed from ${domains.size} source(s), confidence ${confidence}. It needs ${required} approval${required > 1 ? 's' : ''} from officers other than you before any money moves.` };
}
async function proposeAll(c, user) {
  need(user, 'settlement.propose');
  const cand = await c.q("SELECT m.id FROM markets m JOIN market_resolution_specs s ON s.market_id=m.id WHERE m.status IN ('LOCKED','EVENT_PENDING','RESULT_PENDING') AND NOT EXISTS (SELECT 1 FROM settlements x WHERE x.market_id=m.id AND x.status IN ('PROPOSED','EXECUTED')) ORDER BY m.id");
  const out = [];
  for (const { id } of cand) {
    await c.q('SAVEPOINT ai_prop');
    try { const r = await proposeResolution(c, user, id); await c.q('RELEASE SAVEPOINT ai_prop'); out.push({ market_id: id, ...r }); }
    catch (e) { await c.q('ROLLBACK TO SAVEPOINT ai_prop'); await c.q('RELEASE SAVEPOINT ai_prop'); out.push({ market_id: id, proposed: false, reason: e.code || 'ERROR', message: e.message }); }
  }
  return { checked: cand.length, proposed: out.filter((o) => o.proposed).length, results: out };
}
async function evidenceList(c, user, marketId) { need(user, 'research.manage'); return c.q('SELECT e.*, u.username AS added_by_name FROM research_evidence e LEFT JOIN users u ON u.id=e.added_by WHERE market_id=$1 ORDER BY e.id', [marketId]); }

module.exports = { listRatings, setRating, setResolutionSpec, getSpec, recommendOdds, modelProbabilities, onSettled, performance, addEvidence, retractEvidence, evidenceList, researchPanel,
  suggestFromItem, findDate, parseFeed, safeFetch, isBlockedIp, addFeed, ingest, refreshFeed, listFeeds, listSuggestions, decideSuggestion, scanRisk, listAlerts, reviewAlert, proposeResolution, proposeAll, decide };
