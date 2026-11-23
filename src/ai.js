'use strict';
// PREDICTABLE AI service interface — stage one.
//
// Honest scope note: these are deterministic, reproducible rule-based services, NOT an LLM. They define the
// service boundary (inputs/outputs, versioning, "AI never touches money") so statistical models and an LLM
// research layer can be plugged in behind the same functions later. Numerical probabilities must always come
// from reproducible models; an LLM may only explain them. Nothing here can move funds or settle a market.

const MODEL_VERSION = 'rules-v1.0';

const VAGUE = ['best', 'good', 'bad', 'soon', 'many', 'few', 'likely', 'successful', 'popular', 'big', 'major', 'significant', 'around', 'approximately', 'roughly', 'some'];
// Markets that could create incentives to harm people or involve minors are never permitted.
const BLOCKED = [/\b(die|dies|death|dead|killed|kill|assassinat\w*|suicide|murder\w*|shot|stabbed)\b/i, /\b(child|children|minor|underage|school ?(boy|girl))\b/i, /\b(rape|terror\w*|bomb\w*|kidnap\w*)\b/i];
const SENSITIVE = [/\b(election|elected|president|governor|mp\b|senator|court|verdict|ruling|impeach\w*)\b/i];

function validateQuestion({ title, outcomes, resolution_source, resolution_method, closes_at, event_at }) {
  const issues = [];
  const add = (severity, code, message) => issues.push({ severity, code, message });
  const t = String(title || '').trim();
  if (t.length < 12) add('ERROR', 'TOO_SHORT', 'Make the question specific — at least 12 characters.');
  if (t && !/[?]$/.test(t) && !/^(will|does|do|is|are|can|who|which|how many|what|when)\b/i.test(t)) add('WARN', 'NOT_A_QUESTION', 'Phrase it as a clear yes/no or multiple-choice question.');
  for (const re of BLOCKED) if (re.test(t) || (outcomes || []).some((o) => re.test(o))) { add('BLOCK', 'PROHIBITED_TOPIC', 'Markets about deaths, violence or minors are not allowed.'); break; }
  for (const re of SENSITIVE) if (re.test(t)) { add('WARN', 'COMPLIANCE_REVIEW', 'Political or legal-outcome markets need extra compliance review before approval.'); break; }
  const vague = VAGUE.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
  if (vague.length) add('WARN', 'VAGUE_TERMS', `Ambiguous wording (${vague.join(', ')}). Replace it with a number, a name or a date that can be verified.`);
  if (!/\b(by|before|on|during|in|after|at)\b/i.test(t) && !/\b20\d\d\b/.test(t) && !/next|this|today|tomorrow|match|game|final|season/i.test(t)) add('WARN', 'NO_TIME_ANCHOR', 'State when the outcome is measured (a date, a match, a deadline).');
  const outs = (outcomes || []).map((o) => String(o).trim()).filter(Boolean);
  if (outs.length < 2) add('ERROR', 'OUTCOMES', 'At least two outcomes are required.');
  if (new Set(outs.map((o) => o.toLowerCase())).size !== outs.length) add('ERROR', 'DUPLICATE_OUTCOMES', 'Outcome names must be different.');
  if (outs.length === 2 && outs.some((o) => /^(yes|no)$/i.test(o)) === false && outs.every((o) => !/not|no\b/i.test(o)) ) {
    add('INFO', 'EXHAUSTIVE', 'Check that your outcomes cover every possible result (e.g. include a draw if the match can end level).');
  }
  if (!String(resolution_source || '').trim()) add('ERROR', 'NO_SOURCE', 'Name an official, publicly checkable resolution source.');
  else if (!/(https?:\/\/|\.\w{2,}|official|league|federation|commission|iebc|kfa|fkf|caf|fifa|bbc|nation|standard|star|reuters)/i.test(resolution_source)) add('WARN', 'WEAK_SOURCE', 'The resolution source should be an authoritative, publicly accessible site or body.');
  if (!String(resolution_method || '').trim()) add('ERROR', 'NO_METHOD', 'Explain exactly how the result will be read from the source (e.g. full-time score, excluding extra time).');
  if (closes_at && event_at && new Date(closes_at) > new Date(event_at)) add('ERROR', 'DATES', 'Trading must close before the event starts.');
  const blocked = issues.some((i) => i.severity === 'BLOCK' || i.severity === 'ERROR');
  return { model_version: MODEL_VERSION, ok: !blocked, issues };
}

function researchPanel(market) {
  return {
    model_version: MODEL_VERSION,
    status: 'NO_DATA_SOURCES_CONNECTED',
    summary: 'No external evidence feeds are connected in stage one, so no factual research is shown. Every claim in this panel will have to link to a source once feeds are connected.',
    sections: ['Supporting evidence', 'Counter-arguments', 'Relevant statistics', 'Source links', 'Data freshness', 'Confidence and uncertainty', 'Unknown factors'].map((s) => ({ title: s, items: [] })),
    note: 'Pool percentages on public markets show where money is committed — they are not probabilities.',
    market_id: market ? market.id : null,
  };
}

// ───────────── Odds intelligence: Elo + Poisson (reproducible, no LLM) ─────────────
const MODEL_ELO = 'elo-poisson-v1.0';
const eloExpected = (rH, rA, adv = 65) => 1 / (1 + Math.pow(10, -((rH + adv - rA) / 400)));
// Margin-of-victory scaled Elo update; draws score 0.5. Returns new ratings (rounded to 2 d.p.).
function eloUpdate(rH, rA, hg, ag, { k = 30, adv = 65 } = {}) {
  const score = hg > ag ? 1 : hg === ag ? 0.5 : 0;
  const exp = eloExpected(rH, rA, adv), g = Math.log(Math.abs(hg - ag) + 1) + 1;
  const d = k * g * (score - exp);
  return { home: Number((rH + d).toFixed(2)), away: Number((rA - d).toFixed(2)) };
}
const poissonPmf = (l, n) => { let p = Math.exp(-l); for (let i = 1; i <= n; i++) p *= l / i; return p; };
// Win/draw/loss probabilities from rating gap → expected goals → independent Poisson scoreline grid.
function matchProbabilities(rH, rA, { adv = 65, base = 1.35, scale = 0.6 } = {}) {
  const dr = (rH + adv - rA) / 400, lh = base * Math.exp(scale * dr), la = base * Math.exp(-scale * dr);
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 12; h++) for (let a = 0; a <= 12; a++) { const p = poissonPmf(lh, h) * poissonPmf(la, a); if (h > a) home += p; else if (h === a) draw += p; else away += p; }
  const t = home + draw + away;
  return { model_version: MODEL_ELO, home: home / t, draw: draw / t, away: away / t, expected_goals: { home: Number(lh.toFixed(2)), away: Number(la.toFixed(2)) } };
}

module.exports = { MODEL_ELO, eloExpected, eloUpdate, matchProbabilities, MODEL_VERSION, validateQuestion, researchPanel };
