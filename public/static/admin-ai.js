/* Admin console — stage two: security, AI & reference prices, research, discovery, risk alerts, appeals.
   The AI services here are advisory. Nothing on these screens can move money, settle a market or publish one. */
(function () {
  const K = window.AdminKit; if (!K) return;
  const { V, D, can, TABS, setMain, stat, tbl, act, ask, reload, S } = K; const $ = (s, r = document) => r.querySelector(s);
  const esc = P.esc;
  TABS.push(['ai', 'AI and prices', 'admin.dashboard'], ['research', 'Research', 'research.manage'], ['discovery', 'Discovery', 'research.manage'], ['appeals', 'Appeals', 'users.manage'], ['security', 'My security', 'admin.dashboard']);
  const pct = (x) => (x * 100).toFixed(1) + '%';

  // ── My security ──
  V.security = async () => {
    setMain('<div class="pagehead"><h1 style="margin:0">My security</h1></div><div id="secbox"></div>' + (can('audit.view') ? '<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Audit log integrity</h3><p class="sm muted">Every audit entry is chained to the one before it. Any edit or deletion breaks the chain.</p><button class="btn btn-ghost btn-sm" onclick="D.verifyAudit()">Verify audit chain</button> <span id="av" class="sm"></span></div>' : ''));
    await SecUI.render($('#secbox'), { staff: true, onChange: () => { S.me.mfa_enabled = true; } });
  };
  D.verifyAudit = async () => { try { const r = await P.api('/admin/audit/verify'); $('#av').innerHTML = r.ok ? `<span class="pos">Intact</span> — ${r.sealed} entries sealed.` : `<span class="neg">Broken at entry #${r.first_break_id}</span>`; } catch (e) { P.fail(e); } };

  // ── AI and reference prices ──
  V.ai = async () => {
    const [perf, ratings, mk] = await Promise.all([P.api('/admin/ai/performance'), P.api('/admin/ai/ratings'), P.api('/admin/markets')]);
    const hm = mk.filter((m) => ['PENDING_REVIEW', 'APPROVED', 'OPEN', 'SUSPENDED'].includes(m.status));
    setMain(`<h1>AI and prices</h1><p class="muted">The model gives a reference chance for a market. It is advice only: it never sets a price, and traders decide where the market trades.</p>
      <div class="grid g4" style="margin-bottom:16px">${stat('Model', perf.model_version)}${stat('Settled markets scored', perf.settled_markets_scored)}${stat('Brier score', perf.brier_score == null ? '–' : perf.brier_score)}${stat('Human overrides', perf.human_overrides + ' of ' + perf.outcomes_compared)}</div>
      <p class="hint">${esc(perf.reference)} ${esc(perf.note)}</p>
      <h3 style="margin-top:20px">Markets</h3>${tbl(['Market', 'Status', 'Yes price', ''], hm.map((m) => `<tr><td>${esc(m.title)}</td><td>${P.statusBadge(m.status)}</td><td>${P.price(m.yes_price_kes)}</td><td><button class="btn btn-ghost btn-sm" onclick="D.recommend(${m.id})">Reference price</button></td></tr>`), 'No markets to check.')}
      <div class="pagehead" style="margin-top:24px"><h3 style="margin:0">Team ratings (Elo)</h3>${can('research.manage') ? '<button class="btn btn-ghost btn-sm" onclick="D.setRating()">Add or change a rating</button>' : ''}</div>
      <p class="hint">Starting values are editable placeholders. After each settled match with a recorded full-time score, both ratings update once.</p>
      ${tbl(['Team', 'Rating', 'Matches'], ratings.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.rating.toFixed(0)}</td><td>${r.matches}</td></tr>`))}`);
  };
  D.setRating = () => P.modal(`<h3>Team rating</h3><div class="field"><label>Team</label><input id="tr_n"></div><div class="field"><label>Rating (800–2800)</label><input id="tr_r" type="number" value="1500"></div><div class="err" id="tr_e"></div><button class="btn btn-primary" id="tr_go">Save</button>`, (o, close) => { o.querySelector('#tr_go').onclick = async () => { try { await P.api('/admin/ai/ratings', { body: { name: o.querySelector('#tr_n').value, rating: +o.querySelector('#tr_r').value } }); close(); P.toast('Rating saved'); reload(); } catch (e) { o.querySelector('#tr_e').textContent = e.message; } }; });
  D.recommend = async (id) => {
    try {
      const r = await P.api(`/admin/markets/${id}/reference-price`);
      if (!r.available) return P.modal(`<h3>No reference price</h3><p>${esc(r.reason)}</p><p class="sm muted">Set a resolution spec under Research to attach the football model.</p>`);
      P.modal(`<div style="min-width:min(560px,78vw)"></div><h3>Reference price</h3><p class="sm muted">${esc(r.explanation)}</p>
        <div class="grid g3">${stat('Model chance of Yes', pct(r.probability))}${stat('Fair Yes price', P.price(r.suggested_price_kes))}${stat('Market Yes price now', P.price(r.current_price_kes))}</div>
        <p class="hint">Use this to sanity-check an opening price or a market maker. Large gaps between the model and the market are worth a look, but the market may know something the model does not.</p>`);
    } catch (e) { P.fail(e); }
  };

  // ── Research: evidence and resolution specs ──
  V.research = async () => {
    const mk = await P.api('/admin/markets');
    const pick = Number(sessionStorageGet('rm')) || (mk[0] && mk[0].id);
    setMain(`<h1>Research</h1><p class="muted">Every claim needs a source link. Result evidence plus a resolution spec lets the assistant propose a settlement for officers to approve.</p>
      <div class="field" style="max-width:520px"><label>Market</label><select id="rm" onchange="D.pickMarket(this.value)">${mk.map((m) => `<option value="${m.id}" ${m.id === pick ? 'selected' : ''}>#${m.id} ${esc(m.title.slice(0, 80))}</option>`).join('')}</select></div><div id="rbox"></div>`);
    if (pick) await D.drawResearch(pick);
  };
  const sessionStorageGet = (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
  D.pickMarket = (id) => { try { sessionStorage.setItem('rm', id); } catch (e) {} D.drawResearch(+id); };
  D.drawResearch = async (id) => {
    const [ev, spec, m] = await Promise.all([P.api(`/admin/markets/${id}/evidence`), P.api(`/admin/markets/${id}/spec`), P.api('/markets/' + id)]);
    $('#rbox').innerHTML = `<div class="card" style="margin-bottom:16px"><div class="pagehead"><h3 style="margin:0">Resolution spec</h3><button class="btn btn-ghost btn-sm" onclick="D.editSpec(${id})">${spec ? 'Change' : 'Set up'}</button></div>
        <p class="sm muted">${spec ? (spec.kind === 'MATCH_RESULT' ? `Match result: ${esc(spec.params.home)} (home) vs ${esc(spec.params.away)} (away). ` + Object.entries(spec.params.outcome_covers).map(([oid, p]) => `${esc((m.outcomes.find((o) => o.id == oid) || {}).outcome_name)} ← ${p.join(' or ')}`).join('; ') : `Threshold: yes if value ${esc(spec.params.op)} ${esc(spec.params.threshold)}`) : 'No spec yet. Without one the assistant cannot read a result and no reference price is available.'}</p></div>
      <div class="pagehead"><h3 style="margin:0">Evidence</h3><button class="btn btn-primary btn-sm" onclick="D.addEvidence(${id}, ${spec ? `'${spec.kind}'` : 'null'})">Add evidence</button></div>
      ${tbl(['Kind', 'Claim', 'Source', 'Added', ''], ev.map((e) => `<tr style="${e.retracted_at ? 'opacity:.5;text-decoration:line-through' : ''}"><td><span class="badge">${e.kind}</span></td><td>${esc(e.claim)}${e.fact ? `<div class="xs mono">${esc(JSON.stringify(e.fact))}</div>` : ''}</td><td><a href="${esc(e.source_url)}" target="_blank" rel="noopener">${esc(e.source_name)}</a></td><td class="xs">${esc(e.added_by_name || 'feed')}<br>${P.date(e.retrieved_at)}</td><td>${e.retracted_at ? 'Withdrawn' : `<button class="btn btn-ghost btn-sm" onclick="D.retract(${e.id})">Withdraw</button>`}</td></tr>`), 'No evidence yet.')}`;
  };
  D.addEvidence = (id, specKind) => P.modal(`<h3>Add evidence</h3>
    <div class="field"><label>Kind</label><select id="ev_k"><option value="SUPPORT">Supports a likely outcome</option><option value="COUNTER">Counter-argument</option><option value="STAT">Statistic</option><option value="CONTEXT">Context</option><option value="UNKNOWN">Unknown factor</option>${specKind ? '<option value="RESULT">Result (final)</option>' : ''}</select></div>
    <div class="field"><label>Claim</label><textarea id="ev_c" placeholder="State one verifiable fact in plain words"></textarea></div>
    <div class="row"><div class="field"><label>Source name</label><input id="ev_n" placeholder="Football Kenya Federation"></div><div class="field"><label>Source link (https)</label><input id="ev_u" placeholder="https://…"></div></div>
    <div class="field"><label>Published</label><input id="ev_d" type="date"></div>
    <div id="ev_r" class="row hidden">${specKind === 'THRESHOLD' ? '<div class="field"><label>Value</label><input id="ev_v" type="number" step="any"></div>' : '<div class="field"><label>Home goals (full time)</label><input id="ev_h" type="number" min="0"></div><div class="field"><label>Away goals (full time)</label><input id="ev_a" type="number" min="0"></div>'}</div>
    <div class="err" id="ev_e"></div><button class="btn btn-primary" id="ev_go">Save evidence</button>`, (o, close) => {
    const k = o.querySelector('#ev_k'); k.onchange = () => o.querySelector('#ev_r').classList.toggle('hidden', k.value !== 'RESULT');
    o.querySelector('#ev_go').onclick = async () => {
      const g = (s) => o.querySelector(s); const body = { kind: g('#ev_k').value, claim: g('#ev_c').value, source_name: g('#ev_n').value, source_url: g('#ev_u').value, published_at: g('#ev_d').value || undefined };
      if (body.kind === 'RESULT') body.fact = specKind === 'THRESHOLD' ? { value: +g('#ev_v').value } : { home_goals: parseInt(g('#ev_h').value, 10), away_goals: parseInt(g('#ev_a').value, 10) };
      try { await P.api(`/admin/markets/${id}/evidence`, { body }); close(); P.toast('Evidence saved'); D.drawResearch(id); } catch (e) { g('#ev_e').textContent = e.message; }
    };
  });
  D.retract = (id) => { const r = ask('Why is this evidence being withdrawn?'); if (r) act(async () => { await P.api(`/admin/evidence/${id}/retract`, { body: { reason: r } }); D.drawResearch(+$('#rm').value); }, 'Withdrawn'); };
  D.editSpec = async (id) => {
    const m = await P.api('/markets/' + id); const sel = (n, extra = '') => `<select data-cover="${n}"><option value="">—</option>${m.outcomes.map((o) => `<option value="${o.id}">${esc(o.outcome_name)}</option>`).join('')}</select>`;
    P.modal(`<h3>Resolution spec</h3><div class="field"><label>Type</label><select id="sp_k"><option value="MATCH_RESULT">Football match result</option><option value="THRESHOLD">Number against a threshold</option></select></div>
      <div id="sp_m"><div class="row"><div class="field"><label>Home team</label><input id="sp_h"></div><div class="field"><label>Away team</label><input id="sp_a"></div></div>
        <p class="sm muted">Choose which outcome wins for each result. Every result must be covered once. A "does not win" outcome can cover both draw and away.</p>
        ${['home', 'draw', 'away'].map((r) => `<div class="field"><label>If the result is a ${r === 'draw' ? 'draw' : r + ' win'}, the winning outcome is</label>${sel(r)}</div>`).join('')}</div>
      <div id="sp_t" class="hidden"><div class="row"><div class="field"><label>Yes outcome</label><select id="sp_y">${m.outcomes.map((o) => `<option value="${o.id}">${esc(o.outcome_name)}</option>`).join('')}</select></div><div class="field"><label>No outcome</label><select id="sp_nn">${m.outcomes.map((o, i) => `<option value="${o.id}" ${i === 1 ? 'selected' : ''}>${esc(o.outcome_name)}</option>`).join('')}</select></div></div>
        <div class="row"><div class="field"><label>Yes when value is</label><select id="sp_op"><option>&gt;=</option><option>&gt;</option><option>&lt;=</option><option>&lt;</option></select></div><div class="field"><label>Threshold</label><input id="sp_th" type="number" step="any"></div></div></div>
      <div class="err" id="sp_e"></div><button class="btn btn-primary" id="sp_go">Save spec</button>`, (o, close) => {
      const g = (s) => o.querySelector(s); g('#sp_k').onchange = () => { const t = g('#sp_k').value === 'THRESHOLD'; g('#sp_m').classList.toggle('hidden', t); g('#sp_t').classList.toggle('hidden', !t); };
      g('#sp_go').onclick = async () => {
        let body;
        if (g('#sp_k').value === 'MATCH_RESULT') { const cov = {}; o.querySelectorAll('[data-cover]').forEach((s) => { if (s.value) (cov[s.value] = cov[s.value] || []).push(s.dataset.cover); }); body = { kind: 'MATCH_RESULT', params: { home: g('#sp_h').value, away: g('#sp_a').value, outcome_covers: cov } }; }
        else body = { kind: 'THRESHOLD', params: { yes_outcome: +g('#sp_y').value, no_outcome: +g('#sp_nn').value, op: g('#sp_op').value, threshold: +g('#sp_th').value } };
        try { await P.api(`/admin/markets/${id}/spec`, { body }); close(); P.toast('Spec saved'); D.drawResearch(id); } catch (e) { g('#sp_e').textContent = e.message; }
      };
    });
  };

  // ── Discovery ──
  V.discovery = async () => {
    const [feeds, sug] = await Promise.all([P.api('/admin/feeds'), P.api('/admin/suggestions')]);
    setMain(`<div class="pagehead"><h1 style="margin:0">Market discovery</h1><button class="btn btn-primary" onclick="D.addFeed()">Connect a feed</button></div>
      <p class="muted">Approved feeds are read for fixtures and dated events. Suggestions are drafts only: nothing is created or published until a staff member makes the market and a different reviewer approves it.</p>
      ${tbl(['Feed', 'Items', 'Last fetched', ''], feeds.map((f) => `<tr><td><b>${esc(f.name)}</b><div class="xs mono muted">${esc(f.url)}</div></td><td>${f.items}</td><td class="xs">${f.last_fetched_at ? P.date(f.last_fetched_at) : 'never'}${f.last_error ? `<div class="neg xs">${esc(f.last_error)}</div>` : ''}</td><td><button class="btn btn-ghost btn-sm" onclick="D.refreshFeed(${f.id})">Fetch now</button></td></tr>`), 'No feeds connected.')}
      <h3 style="margin-top:22px">Suggestions</h3>${sug.map((s) => `<div class="card" style="margin-bottom:12px"><div class="spread"><b>${esc(s.title)}</b><span class="badge ${s.status === 'NEW' ? 'b-lock' : ''}">${s.status.toLowerCase()}</span></div>
        <p class="sm muted" style="margin:6px 0">${esc(s.rationale)} <a href="${esc(s.source_url)}" target="_blank" rel="noopener">Source</a></p>
        ${(s.issues || []).map((i) => `<div class="issue"><span class="tg sev-${i.severity}">${i.severity}</span><span>${esc(i.message)}</span></div>`).join('')}
        ${s.status === 'NEW' ? `<div class="inline" style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="D.sugg(${s.id},'ACCEPTED')">Use as a draft</button><button class="btn btn-ghost btn-sm" onclick="D.sugg(${s.id},'DISMISSED')">Dismiss</button></div>` : ''}</div>`).join('') || '<div class="empty">No suggestions yet.</div>'}`);
  };
  D.addFeed = () => P.modal(`<h3>Connect a feed</h3><div class="field"><label>Name</label><input id="fd_n"></div><div class="field"><label>RSS or Atom address (https only)</label><input id="fd_u" placeholder="https://…"></div><p class="hint">Addresses on private networks are refused. Feeds are read with a size and time limit and never followed through redirects.</p><div class="err" id="fd_e"></div><button class="btn btn-primary" id="fd_go">Connect</button>`, (o, close) => { o.querySelector('#fd_go').onclick = async () => { try { await P.api('/admin/feeds', { body: { name: o.querySelector('#fd_n').value, url: o.querySelector('#fd_u').value } }); close(); reload(); } catch (e) { o.querySelector('#fd_e').textContent = e.message; } }; });
  D.refreshFeed = async (id) => { try { const r = await P.api(`/admin/feeds/${id}/refresh`, { method: 'POST' }); P.toast(r.error ? 'Could not fetch: ' + r.error : `${r.items_added} new item(s), ${r.suggestions_added} suggestion(s)`, !!r.error); reload(); } catch (e) { P.fail(e); } };
  D.sugg = async (id, decision) => {
    try {
      const r = await P.api('/admin/suggestions/' + id, { body: { decision } });
      if (decision === 'ACCEPTED' && can('market.create')) { reload(); K.D.newMarket(r.prefill); P.toast('Draft loaded. Set the opening price, then send it for review.'); }
      else { P.toast(decision === 'ACCEPTED' ? 'Accepted as a draft' : 'Dismissed'); reload(); }
    } catch (e) { P.fail(e); }
  };

  // ── Risk alerts (replaces the stage-one flag list) ──
  V.risk = async () => {
    const [alerts, { metrics: m }] = await Promise.all([P.api('/admin/risk/alerts'), P.api('/admin/dashboard')]);
    setMain(`<div class="pagehead"><h1 style="margin:0">Risk</h1><button class="btn btn-primary" onclick="D.scan()">Run risk scan</button></div>
      <div class="grid g4" style="margin-bottom:12px">${stat('Open alerts', alerts.filter((a) => a.status === 'OPEN').length)}${stat('Market-maker funds at risk', P.kes(m.amm_live_exposure_minor))}${stat('Open interest', P.kes(m.open_interest_minor))}${stat('Pending withdrawals', m.pending_withdrawals)}</div>
      <p class="muted">Alerts are prompts for a person to look. Nothing here suspends or restricts an account. Record your reasoning when you review one; players can appeal any action you take.</p>
      ${alerts.map((a) => `<div class="flag" style="${a.status !== 'OPEN' ? 'opacity:.6' : ''}"><div class="spread"><b><span class="tg sev-${a.severity === 'HIGH' ? 'ERROR' : a.severity === 'MEDIUM' ? 'WARN' : 'INFO'}">${a.severity}</span> ${esc(a.alert_type.replace(/_/g, ' ').toLowerCase())}</b><span class="xs muted">${a.status.toLowerCase()} · ${P.date(a.created_at)}</span></div>
        <div class="sm" style="margin:4px 0">${esc(a.detail)}${a.user_id ? ` <a href="#users" onclick="D.openUser(${a.user_id})">Open user</a>` : ''}${a.market_id ? ` <a href="/#/market/${a.market_id}" target="_blank" rel="noopener">Market #${a.market_id}</a>` : ''}</div>
        ${a.status === 'OPEN' ? `<div class="inline"><button class="btn btn-ghost btn-sm" onclick="D.alert(${a.id},'CONFIRMED')">Confirm concern</button><button class="btn btn-ghost btn-sm" onclick="D.alert(${a.id},'DISMISSED')">Dismiss</button></div>` : `<div class="xs muted">${esc(a.note || '')}</div>`}</div>`).join('') || '<div class="empty">No alerts. Run a scan to check.</div>'}`);
  };
  D.scan = async () => { try { const r = await P.api('/admin/risk/scan', { method: 'POST' }); P.toast(`${r.detected} pattern(s) detected, ${r.new_alerts} new alert(s)`); reload(); } catch (e) { P.fail(e); } };
  D.alert = (id, decision) => { const n = ask(decision === 'CONFIRMED' ? 'What did you find? This is recorded.' : 'Why is this not a concern?'); if (n) act(() => P.api(`/admin/risk/alerts/${id}`, { body: { decision, note: n } }), 'Recorded'); };

  // ── Appeals ──
  V.appeals = async () => {
    const l = await P.api('/admin/appeals');
    setMain(`<h1>Appeals</h1><p class="muted">Suspended players can ask for a review. Decide with a written reason; the decision is audited.</p>
      ${l.map((a) => `<div class="card" style="margin-bottom:12px"><div class="spread"><b>${esc(a.display_name)} <span class="xs muted">@${esc(a.username)}</span></b><span class="badge ${a.status === 'OPEN' ? 'b-lock' : ''}">${a.status.toLowerCase()}</span></div><p style="margin:8px 0">${esc(a.message)}</p>
        ${a.status === 'OPEN' ? `<div class="inline"><button class="btn btn-primary btn-sm" onclick="D.appeal(${a.id},'REINSTATE')">Lift suspension</button><button class="btn btn-ghost btn-sm" onclick="D.appeal(${a.id},'UPHOLD')">Keep suspended</button></div>` : `<div class="xs muted">${esc(a.decision_note || '')}</div>`}</div>`).join('') || '<div class="empty">No appeals.</div>'}`);
  };
  D.appeal = (id, decision) => { const n = ask('Reason for your decision'); if (n) act(() => P.api(`/admin/appeals/${id}`, { body: { decision, note: n } }), 'Decision recorded'); };
})();
