/* Predictable — admin console. Every action is permission-checked again on the server; hiding a menu item is only a convenience. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const root = $('#root');
  const S = { me: null, tab: 'dashboard', cats: [] };
  const D = (window.D = {});
  const can = (p) => S.me && S.me.permissions.includes(p);

  const TABS = [
    ['dashboard', 'Dashboard', 'admin.dashboard'], ['review', 'Market review', 'market.review'], ['markets', 'Markets', 'admin.dashboard'],
    ['settlement', 'Settlement', 'settlement.propose'], ['disputes', 'Disputes', 'disputes.resolve'],
    ['finance', 'Finance', 'finance.view'], ['tax', 'Tax and revenue', 'finance.view'], ['risk', 'Risk', 'risk.view'], ['users', 'Users', 'users.manage'], ['reports', 'Reports', 'market.review'],
    ['audit', 'Audit log', 'audit.view'], ['staff', 'Staff roles', 'roles.manage'],
  ];
  window.AdminKit = { S, V: null, D, can, TABS, setMain: (h) => { $('#main').innerHTML = h; }, stat: null, tbl: null, act: null, ask: null, reload: null };

  async function boot() {
    if (!P.token()) return loginScreen();
    try { S.me = (await P.api('/me')).user; } catch (e) { P.setToken(null); return loginScreen(); }
    if (!can('admin.dashboard')) { root.innerHTML = '<div class="card" style="max-width:480px;margin:60px auto"><h2>No access</h2><p class="muted">This account has no staff role.</p><a class="btn btn-ghost" href="/">Back to Predictable</a></div>'; return; }
    try { S.cats = await P.api('/categories'); } catch (e) {}
    S.tab = (location.hash.slice(1) || 'dashboard'); shell(); go(S.tab);
  }
  function loginScreen(needCode) {
    root.innerHTML = `<div class="card" style="max-width:400px;margin:70px auto"><div class="logo" style="color:var(--ink);margin-bottom:14px">${P.logoSvg}Predictable staff</div>
      <div class="field"><label>Username</label><input id="u" autocomplete="username" value="${P.esc((window._lu) || '')}"></div><div class="field"><label>Password</label><input id="p" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')D.login()"></div>
      ${needCode ? '<div class="field"><label>Authenticator code</label><input id="t" inputmode="numeric" autocomplete="one-time-code" maxlength="6" onkeydown="if(event.key===\'Enter\')D.login()"><div class="hint">Staff accounts use two-step verification.</div></div>' : ''}
      <div class="err" id="e"></div><button class="btn btn-primary btn-block" onclick="D.login()">Sign in</button></div>`;
  }
  D.login = async () => {
    const t = $('#t');
    try {
      const r = await P.api('/auth/login', { body: { identifier: $('#u').value, password: $('#p').value, totp: t ? t.value : undefined } });
      if (r.mfa_required) { $('#e').insertAdjacentHTML('beforebegin', '<div class="field"><label>Authenticator code</label><input id="t" inputmode="numeric" autocomplete="one-time-code" maxlength="6" onkeydown="if(event.key===\'Enter\')D.login()"><div class="hint">Staff accounts use two-step verification.</div></div>'); $('#t').focus(); $('#e').textContent = 'Enter your authenticator code to continue.'; return; }
      P.setToken(r.token); boot();
    } catch (e) { $('#e').textContent = e.message; }
  };
  D.logout = async () => { try { await P.api('/auth/logout', { method: 'POST' }); } catch (e) {} P.setToken(null); loginScreen(); };

  function shell() {
    root.innerHTML = `<div class="adm"><nav class="side" aria-label="Admin"><a class="logo" href="/">${P.logoSvg}Predictable</a>
      ${TABS.filter((t) => can(t[2])).map((t) => `<a href="#${t[0]}" data-t="${t[0]}">${t[1]}</a>`).join('')}
      <div class="who">${P.esc(S.me.display_name)}<br>${S.me.roles.filter((r) => r !== 'user').map((r) => r.replace(/_/g, ' ')).join(', ')}<br><a href="#" onclick="D.logout();return false" style="padding:.4em 0">Sign out</a><br><a href="#" onclick="P.toggleTheme();return false" style="padding:.4em 0">Toggle theme</a></div></nav>
      <main id="main"></main></div>`;
    window.onhashchange = () => go(location.hash.slice(1) || 'dashboard');
  }
  const main = () => $('#main');
  const setMain = (h) => { main().innerHTML = h; };
  async function go(tab) {
    S.tab = tab; document.querySelectorAll('.side a[data-t]').forEach((a) => a.classList.toggle('on', a.dataset.t === tab));
    setMain('<div class="empty">Loading…</div>');
    try { await (V[tab] || V.dashboard)(); } catch (e) { if (e.code === 'MFA_ENROLLMENT_REQUIRED' && tab !== 'security') { location.hash = '#security'; return; } setMain(`<div class="card notice"><h3>${e.status === 403 ? 'Not permitted' : 'Error'}</h3><p>${P.esc(e.message)}</p></div>`); }
  }
  const stat = (l, v, cls = '') => `<div class="statbox"><span class="xs muted">${l}</span><span class="num ${cls}">${v}</span></div>`;
  const tbl = (head, rows, empty = 'Nothing here.') => `<div class="tscroll"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.length ? rows.join('') : `<tr><td colspan="${head.length}" class="muted">${empty}</td></tr>`}</table></div>`;
  const reload = () => go(S.tab);
  Object.assign(window.AdminKit, { stat, tbl, reload, go });
  const act = async (fn, msg) => { try { await fn(); if (msg) P.toast(msg); reload(); } catch (e) { P.fail(e); } };
  const ask = (label) => { const v = prompt(label); return v && v.trim() ? v.trim() : null; };
  Object.assign(window.AdminKit, { act, ask });

  const V = {}; window.AdminKit.V = V;
  V.dashboard = async () => {
    const { metrics: m, flags } = await P.api('/admin/dashboard');
    setMain(`<div class="pagehead"><h1 style="margin:0">Dashboard</h1><span class="badge">Simulated funds</span></div>
      <div class="grid g4">
        ${stat('Registered players', m.total_registered_users)}${stat('Verified', m.verified_users)}${stat('Active traders (30 days)', m.active_traders_30d)}${stat('Open markets', m.active_markets)}
        ${stat('Trading volume', P.kes(m.volume_minor))}${stat('Trades', P.n(m.trades))}${stat('Open interest (held in escrow)', P.kes(m.open_interest_minor))}${stat('Platform revenue', P.kes(m.platform_revenue_minor), 'pos')}
        ${stat('KRA tax payable', P.kes(m.kra_payable_minor))}${stat('Tax withheld, not yet remitted', P.kes(m.kra_unremitted_events_minor))}${stat('Market-maker funds at risk', P.kes(m.amm_live_exposure_minor))}${stat('Market-maker result (closed)', P.kes(m.amm_realised_result_minor), m.amm_realised_result_minor >= 0 ? 'pos' : 'neg')}
        ${stat('Deposits', P.kes(m.deposits_minor))}${stat('Withdrawals paid', P.kes(m.withdrawals_minor))}${stat('Suspicious flags', m.suspicious_flags, m.suspicious_flags ? 'neg' : '')}
      </div>
      <p class="hint">Volume and escrow are not revenue. Revenue is only the deposit fees, withdrawal fees and profit commission the platform has booked. Escrow belongs to the contract holders until a market settles.</p>
      <div class="grid g4" style="margin-top:8px">${stat('Awaiting review', m.pending_review)}${stat('Awaiting settlement', m.pending_settlements)}${stat('Pending withdrawals', m.pending_withdrawals)}${stat('Open disputes', m.open_disputes)}</div>
      ${flags.length ? `<h3 style="margin-top:20px">Risk flags</h3>${flags.map((f) => `<div class="flag"><b>${f.type.replace(/_/g, ' ').toLowerCase()}</b>: ${P.esc(f.detail)}</div>`).join('')}` : ''}`);
  };

  V.review = async () => {
    const q = await P.api('/admin/review-queue');
    setMain(`<h1>Market review</h1><p class="muted">You cannot approve a market you proposed. Every market is reviewed, whoever proposes it. Check that the question has one clear, checkable answer and a named source.</p>` + (q.map((m) => `<div class="card" style="margin-bottom:14px">
      <div class="spread"><div><span class="badge">${P.esc(m.category)}</span> <span class="xs muted">proposed by ${P.esc(m.creator)} · trading closes ${P.date(m.closes_at)}</span></div><span class="xs muted">#${m.id}</span></div>
      <h3 style="margin:8px 0">${P.esc(m.title)}</h3>
      ${m.description ? `<p class="sm muted">${P.esc(m.description)}</p>` : ''}
      <dl class="kv" style="margin-top:10px"><dt>Opening price</dt><dd>Yes ${P.price(Number(m.initial_price_kes))} · No ${P.price(100 - Number(m.initial_price_kes))}</dd><dt>Source</dt><dd>${P.esc(m.rules.resolution_source)}</dd><dt>How it is read</dt><dd>${P.esc(m.rules.resolution_method)}</dd></dl>
      ${m.ai && m.ai.issues && m.ai.issues.length ? `<div style="margin-top:10px"><b class="sm">Question check</b>${m.ai.issues.map((i) => `<div class="issue"><span class="tg sev-${i.severity}">${i.severity}</span><span>${P.esc(i.message)}</span></div>`).join('')}</div>` : ''}
      ${can('market.house.manage') ? `<div class="field" style="max-width:340px;margin-top:12px"><label>Fund a market maker (KES, optional)</label><input id="mm${m.id}" type="number" min="0" step="100" placeholder="0 = order book only"><div class="hint">Platform money that quotes both sides. The most the platform can lose on this market is what you put in.</div></div>` : ''}
      <div class="inline" style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="D.review(${m.id},'APPROVED')">Approve and publish</button><button class="btn btn-ghost btn-sm" onclick="D.review(${m.id},'RETURNED')">Return for changes</button><button class="btn btn-danger btn-sm" onclick="D.review(${m.id},'REJECTED')">Reject</button></div></div>`).join('') || '<div class="empty">The review queue is empty.</div>'));
  };
  D.review = (id, decision) => {
    const c = decision === 'APPROVED' ? (prompt('Note (optional)') || '') : ask('Reason for the creator'); if (decision !== 'APPROVED' && !c) return;
    const f = $('#mm' + id); const sub = decision === 'APPROVED' && f && f.value ? +f.value : 0;
    act(() => P.api(`/admin/markets/${id}/review`, { body: { decision, comments: c, amm_subsidy_kes: sub || undefined } }), decision === 'APPROVED' ? 'Published' : 'Done');
  };

  V.markets = async () => {
    const l = await P.api('/admin/markets');
    setMain(`<div class="pagehead"><h1 style="margin:0">Markets</h1>${can('market.create') ? '<button class="btn btn-primary" onclick="D.newMarket()">+ New market</button>' : ''}</div>
      <p class="muted">A market you propose here still needs a different reviewer to approve it.</p>
      ${tbl(['#', 'Market', 'Status', 'Yes price', 'Volume', 'Open interest', 'Holders', 'Market maker', 'Closes', ''], l.map((m) => `<tr><td>${m.id}</td><td><a href="/#/market/${m.id}" target="_blank" rel="noopener">${P.esc(m.title)}</a><div class="xs muted">by ${P.esc(m.creator)}</div></td><td>${P.statusBadge(m.status)}</td><td>${P.price(m.yes_price_kes)}</td><td>${P.kes(m.volume_minor)}</td><td>${P.kes(m.open_interest_minor)}</td><td>${m.holders}</td><td>${m.amm_subsidy_minor ? P.kes(m.amm_subsidy_minor) : '–'}</td><td class="xs">${P.date(m.closes_at)}</td>
      <td class="inline">${m.status === 'OPEN' ? `<button class="btn btn-ghost btn-sm" onclick="D.suspend(${m.id})">Suspend</button><button class="btn btn-ghost btn-sm" onclick="D.closeNow(${m.id})">Close trading</button>` : ''}${m.status === 'SUSPENDED' ? `<button class="btn btn-ghost btn-sm" onclick="D.resume(${m.id})">Resume</button>` : ''}${['LOCKED', 'EVENT_PENDING'].includes(m.status) ? `<button class="btn btn-ghost btn-sm" onclick="D.ended(${m.id})">Event ended</button>` : ''}${['APPROVED', 'OPEN'].includes(m.status) && can('market.house.manage') ? `<button class="btn btn-ghost btn-sm" onclick="D.addMM(${m.id})">${m.amm_subsidy_minor ? 'Top up' : 'Add'} market maker</button>` : ''}<button class="btn btn-ghost btn-sm" onclick="D.escrow(${m.id})">Escrow check</button>${['OPEN', 'LOCKED', 'EVENT_PENDING', 'RESULT_PENDING', 'SUSPENDED'].includes(m.status) ? `<button class="btn btn-danger btn-sm" onclick="D.void(${m.id})">Void</button>` : ''}</td></tr>`))}`);
  };
  D.suspend = (id) => { const r = ask('Reason for suspending. Open orders stay; trading stops until you resume.'); if (r) act(() => P.api(`/admin/markets/${id}/suspend`, { body: { reason: r } }), 'Suspended'); };
  D.resume = (id) => act(() => P.api(`/admin/markets/${id}/resume`, { method: 'POST' }), 'Resumed');
  D.closeNow = (id) => { if (confirm('Close trading now? Open orders are cancelled and cash is released.')) act(() => P.api(`/admin/markets/${id}/close`, { method: 'POST' }), 'Trading closed'); };
  D.ended = (id) => act(() => P.api(`/admin/markets/${id}/event-ended`, { method: 'POST' }), 'Moved to result pending');
  D.void = (id) => { const r = ask('Reason for voiding. Contracts are redeemed at the last traded price, with no tax.'); if (r) act(() => P.api(`/admin/markets/${id}/void`, { body: { reason: r } }), 'Market voided and redeemed'); };
  D.addMM = (id) => { const v = ask('Market-maker funds in KES (platform money, capped by settings)'); if (v) act(() => P.api(`/admin/markets/${id}/market-maker`, { body: { subsidy_kes: +v } }), 'Market maker funded'); };
  D.escrow = async (id) => { try { const r = await P.api(`/admin/markets/${id}/escrow`); const x = r.mismatches[0]; P.modal(`<h3>Escrow check, market #${id}</h3><p>${r.ok ? '<span class="pos">Balanced.</span> Escrow equals the YES contracts outstanding and the NO contracts outstanding.' : '<span class="neg">Mismatch.</span> Do not settle this market until it is explained.'}</p>${x ? `<dl class="kv"><dt>Locked</dt><dd>${P.kes(x.locked)}</dd><dt>YES contracts</dt><dd>${P.kes(x.yes_units)}</dd><dt>NO contracts</dt><dd>${P.kes(x.no_units)}</dd></dl>` : ''}`); } catch (e) { P.fail(e); } };

  D.newMarket = (pre) => P.modal(`<h3>New market</h3>
    <div class="field"><label>Question</label><input id="n_t" maxlength="200" placeholder="Will the NSE 20 close above 2,000 on Friday 4 December 2026?"><div class="hint">One question, answered Yes or No, with a date and a checkable source.</div></div>
    <div class="row"><div class="field"><label>Category</label><select id="n_c">${S.cats.map((c) => `<option value="${c.slug}">${P.esc(c.name)}</option>`).join('')}</select></div><div class="field"><label>Opening price for Yes (KES 1–99)</label><input id="n_p" type="number" min="1" max="99" value="50"><div class="hint">Also the opening chance, in percent.</div></div></div>
    <div class="field"><label>Details</label><textarea id="n_d"></textarea></div>
    <div class="row"><div class="field"><label>Trading closes</label><input id="n_cl" type="datetime-local"></div><div class="field"><label>Event time</label><input id="n_ev" type="datetime-local"></div></div>
    <div class="field"><label>Resolution source</label><input id="n_s"></div><div class="field"><label>How the result is read</label><textarea id="n_r"></textarea></div>
    <div class="err" id="n_e"></div><button class="btn btn-primary" id="n_go">Send for review</button>`, (o, close) => {
    const dflt = (d) => { const x = new Date(Date.now() + d * 3600e3); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    const g = (s) => o.querySelector(s); g('#n_cl').value = dflt(48); g('#n_ev').value = dflt(50);
    if (pre) { g('#n_t').value = pre.title || ''; if (pre.category_slug) g('#n_c').value = pre.category_slug; g('#n_s').value = pre.resolution_source || ''; g('#n_r').value = pre.resolution_method || ''; if (pre.event_at) { const d = new Date(pre.event_at); const l = (x) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); g('#n_ev').value = l(d); g('#n_cl').value = l(new Date(d.getTime() - 3600e3)); } }
    g('#n_go').onclick = async () => {
      try {
        await P.api('/markets', { body: { title: g('#n_t').value, description: g('#n_d').value, category_slug: g('#n_c').value, initial_price_kes: +g('#n_p').value, closes_at: new Date(g('#n_cl').value).toISOString(), event_at: new Date(g('#n_ev').value).toISOString(), resolution_source: g('#n_s').value, resolution_method: g('#n_r').value } });
        close(); P.toast('Created. A different reviewer must approve it.'); reload();
      } catch (e) { g('#n_e').textContent = e.message; }
    };
  });
  D.newHouse = D.newMarket;

  V.settlement = async () => {
    const q = await P.api('/admin/settlements');
    setMain(`<div class="pagehead"><h1 style="margin:0">Settlement</h1><button class="btn btn-ghost" onclick="D.aiSweep()" title="Reads recorded result evidence and proposes results. People still approve.">AI check all</button></div><p class="muted">Check the official source, attach evidence, then propose. Settlements with ${P.kes(q.dual_approval_threshold_minor)} or more held in escrow need two different officers to approve. Winners get KES 100 per contract; tax and commission are taken from profit only.</p>
      ${q.awaiting.map((m) => `<div class="card" style="margin-bottom:14px"><div class="spread"><div>${P.statusBadge(m.status)} <span class="xs muted">Yes ${P.price(m.yes_price_kes)}</span></div><span class="xs muted">#${m.id} · ${m.holders} holders · ${P.kes(m.open_interest_minor)} in escrow</span></div>
        <h3 style="margin:8px 0">${P.esc(m.title)}</h3><dl class="kv"><dt>Source</dt><dd>${P.esc(m.rules.resolution_source)}</dd><dt>How it is read</dt><dd>${P.esc(m.rules.resolution_method)}</dd></dl>
        ${m.proposal ? `<div class="info" style="margin-top:10px">${m.proposal.origin === 'AI_ASSISTED' ? `<span class="badge b-lock" title="Proposed by the resolution assistant from recorded sources. People approve.">AI-assisted · ${m.proposal.confidence} confidence · needs ${m.proposal.required_approvals} approval${m.proposal.required_approvals > 1 ? 's' : ''}</span> ` : ''}<b>Proposed by ${P.esc(m.proposal.proposer)}:</b> ${m.proposal.outcome_id ? P.esc(((m.outcomes.find((o) => o.id === m.proposal.outcome_id) || {}).outcome_name || '') + ' wins') : 'Void and redeem'}
          ${planSummary(m.proposal.summary)}${(m.evidence || []).map((e) => `<div class="xs">Evidence: <a href="${P.esc(e.source_url)}" target="_blank" rel="noopener">${P.esc(e.source_url)}</a> ${P.esc(e.note || '')} <span class="mono">${e.evidence_hash.slice(0, 10)}</span></div>`).join('')}
          <div class="inline" style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="D.decide(${m.proposal.id},'APPROVED')">Approve and pay out</button><button class="btn btn-danger btn-sm" onclick="D.decide(${m.proposal.id},'REJECTED')">Reject proposal</button></div></div>`
        : `<div class="inline" style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="D.propose(${m.id})">Propose result</button><button class="btn btn-ghost btn-sm" onclick="D.aiResolve(${m.id})">AI check</button>${['LOCKED', 'EVENT_PENDING'].includes(m.status) ? `<button class="btn btn-ghost btn-sm" onclick="D.ended(${m.id})">Event ended</button>` : ''}</div>`}</div>`).join('') || '<div class="empty">No markets are waiting for a result.</div>'}
      <h3>Recently settled</h3>${tbl(['Market', 'Status', 'When', 'Gross payout', 'Tax withheld', 'Commission', 'Net to players'], q.recent.map((s) => { const p = s.summary || {}; return `<tr><td>${P.esc(s.title)}</td><td>${s.status}</td><td class="xs">${P.date(s.executed_at)}</td><td>${p.total_gross_minor != null ? P.kes(p.total_gross_minor) : '–'}</td><td>${p.total_wht_minor ? P.kes(p.total_wht_minor) : '–'}</td><td>${p.total_commission_minor ? P.kes(p.total_commission_minor) : '–'}</td><td>${p.total_net_minor != null ? P.kes(p.total_net_minor) : '–'}</td></tr>`; }))}`);
    D._q = q;
  };
  D.aiResolve = async (id) => { try { const r = await P.api(`/admin/markets/${id}/ai-resolution`, { method: 'POST' }); P.toast(r.message, !r.proposed); reload(); } catch (e) { P.fail(e); } };
  D.aiSweep = async () => { try { const r = await P.api('/admin/ai/resolution-sweep', { method: 'POST' }); P.toast(`Checked ${r.checked} market(s); ${r.proposed} proposal(s) created for approval.`); reload(); } catch (e) { P.fail(e); } };
  const planSummary = (p) => !p ? '' : `<dl class="kv" style="margin:6px 0">${p.void ? `<dt>Redeemed at</dt><dd>Yes ${P.price(p.void_price_kes)} · No ${P.price(100 - p.void_price_kes)}</dd>` : `<dt>Winning side</dt><dd>${P.esc(p.winning_side || '')}</dd>`}<dt>Escrow released</dt><dd>${P.kes(p.collateral_minor || 0)}</dd><dt>Gross to holders</dt><dd>${P.kes(p.total_gross_minor || 0)}</dd><dt>Tax withheld (KRA)</dt><dd>${P.kes(p.total_wht_minor || 0)}</dd><dt>Platform commission</dt><dd>${P.kes(p.total_commission_minor || 0)}</dd><dt>Net to holders</dt><dd><b>${P.kes(p.total_net_minor || 0)}</b></dd>${p.amm_subsidy_minor ? `<dt>Market maker</dt><dd>${P.kes(p.amm_return_minor || 0)} back of ${P.kes(p.amm_subsidy_minor)} funded (${P.kes(p.amm_result_minor || 0)})</dd>` : ''}</dl>${(p.warnings || []).map((w) => `<div class="xs"><b>${P.esc(w)}</b></div>`).join('')}`;
  D.propose = (id) => {
    const m = D._q.awaiting.find((x) => x.id === id);
    P.modal(`<h3>Propose result</h3><p class="sm muted">${P.esc(m.title)}</p>
      <div class="field"><label>Result</label><select id="p_o">${m.outcomes.map((o) => `<option value="${o.id}">${P.esc(o.outcome_name)} wins</option>`).join('')}<option value="void">Void the market and redeem every contract</option></select></div>
      <div class="field"><label>Evidence link</label><input id="p_u" placeholder="https://…"></div><div class="field"><label>Note</label><textarea id="p_n"></textarea></div>
      <div id="p_pv" class="info hidden"></div><div class="err" id="p_e"></div>
      <div class="inline"><button class="btn btn-ghost" id="p_prev">Preview payouts</button><button class="btn btn-primary" id="p_go">Submit proposal</button></div>`, (o, close) => {
      o.querySelector('#p_prev').onclick = async () => { const v = o.querySelector('#p_o').value; if (v === 'void') { const el = o.querySelector('#p_pv'); el.classList.remove('hidden'); el.textContent = 'A void redeems every contract at the last traded price with no tax. The platform market maker absorbs rounding.'; return; } try { const r = await P.api('/admin/settlements/preview', { body: { market_id: id, outcome_id: +v } }); const el = o.querySelector('#p_pv'); el.classList.remove('hidden'); el.innerHTML = planSummary(r) || 'No preview.'; } catch (e) { o.querySelector('#p_e').textContent = e.message; } };
      o.querySelector('#p_go').onclick = async () => { try { const v = o.querySelector('#p_o').value; const isVoid = v === 'void';
        const r = await P.api(`/admin/markets/${id}/settlement`, { body: { outcome_id: isVoid ? undefined : +v, void: isVoid, reason: o.querySelector('#p_n').value, evidence: o.querySelector('#p_u').value ? [{ source_url: o.querySelector('#p_u').value, note: o.querySelector('#p_n').value }] : [] } });
        close(); P.toast(r.requires_second_approver ? 'Proposed. A second officer must approve.' : 'Proposed'); reload(); } catch (e) { o.querySelector('#p_e').textContent = e.message; } };
    });
  };
  D.decide = async (id, decision) => { let totp; if (decision === 'APPROVED') { totp = await P.askCode('Approve and post this settlement?', 'This posts to the ledger and cannot be edited afterwards, only reversed through a dispute. Confirm with your authenticator code.'); if (!totp) return; } act(async () => { const r = await P.api(`/admin/settlements/${id}/decision`, { body: { decision, totp } }); if (r && r.status === 'AWAITING_MORE_APPROVALS') P.toast(`Approval recorded (${r.approvals} of ${r.required}). Another officer must also approve.`); }, decision === 'APPROVED' ? 'Settled and paid' : 'Proposal rejected'); };

  V.disputes = async () => {
    const q = await P.api('/admin/settlements');
    setMain(`<h1>Disputes</h1><p class="muted">A dispute must be decided by someone who was not involved in the settlement. Corrections post reversing entries. Nothing is deleted.</p>
      ${q.disputes.map((d) => `<div class="card" style="margin-bottom:14px"><div class="spread"><b>${P.esc(d.title)}</b><span class="xs muted">filed by ${P.esc(d.username)} · ${P.date(d.created_at)}</span></div>
        <p style="margin:8px 0">${P.esc(d.reason)}</p>${d.evidence ? `<p class="xs">Evidence: ${P.esc(d.evidence)}</p>` : ''}
        <div class="inline"><button class="btn btn-ghost btn-sm" onclick="D.resolve(${d.id},'REJECT')">Original result stands</button><button class="btn btn-primary btn-sm" onclick="D.resolve(${d.id},'CORRECT',${d.market_id})">Correct the outcome</button><button class="btn btn-danger btn-sm" onclick="D.resolve(${d.id},'VOID')">Void and redeem</button></div></div>`).join('') || '<div class="empty">No open disputes.</div>'}`);
    D._dq = q;
  };
  D.resolve = (id, decision, marketId) => {
    const run = (corrected) => { const r = ask('Explain the decision to the participants'); if (!r) return; act(() => P.api(`/admin/disputes/${id}/resolve`, { body: { decision, resolution: r, corrected_outcome_id: corrected } }), 'Dispute resolved'); };
    if (decision !== 'CORRECT') return run();
    const d = D._dq.disputes.find((x) => x.id === id);
    P.modal(`<h3>Correct the outcome</h3><div class="field"><label>Correct winning outcome</label><select id="co">${d.outcomes.map((o) => `<option value="${o.id}">${P.esc(o.outcome_name)}</option>`).join('')}</select></div><button class="btn btn-primary" id="cg">Continue</button>`, (o, close) => { o.querySelector('#cg').onclick = () => { const v = +o.querySelector('#co').value; close(); run(v); }; });
  };

  V.finance = async () => {
    const f = await P.api('/admin/finance'); const r = f.reconciliation;
    setMain(`<div class="pagehead"><h1 style="margin:0">Finance</h1><button class="btn btn-primary" onclick="D.recon()">Run reconciliation</button></div>
      <div class="card ${r.ok ? '' : 'notice'}" style="margin-bottom:16px"><h3>Ledger integrity: ${r.ok ? '<span class="pos">Balanced</span>' : '<span class="neg">Variance found</span>'}</h3>
        <p class="sm muted">${r.accounts_checked} accounts checked. Net of all accounts: ${P.kes(r.net_of_all_accounts_minor)} (must be zero). Mismatched accounts: ${r.balance_mismatches.length}. Unbalanced transactions: ${r.unbalanced_transactions.length}.</p>
        <div class="grid g4">${Object.entries(r.system_accounts).map(([k, v]) => stat(k.replace('SYS_', '').replace(/_/g, ' ').toLowerCase(), P.kes(v))).join('')}</div>
        <p class="hint">Funding and market-maker funds run negative by design as simulated money is issued. Platform revenue is fees and commission only.</p></div>
      <div class="card ${f.escrow.ok ? '' : 'notice'}" style="margin-bottom:16px"><h3 style="margin-top:0">Escrow: ${f.escrow.ok ? '<span class="pos">Balanced</span>' : '<span class="neg">Mismatch</span>'}</h3><p class="sm muted">Escrow account ${P.kes(f.escrow.sys_escrow_minor)} · market escrow pools ${P.kes(f.escrow.escrow_pools_total_minor)} · markets with a mismatch: ${f.escrow.mismatches.length}. Every KES 100 locked backs one YES and one NO contract.</p></div>
      <h3>Withdrawals</h3>${tbl(['Ref', 'Player', 'Requested', 'Tax', 'Fee', 'Paid out', 'To', 'Status', ''], f.withdrawals.map((w) => `<tr><td class="mono">${w.reference}</td><td>${P.esc(w.username)}</td><td>${P.kes(w.amount_minor)}</td><td>${w.tax_minor ? P.kes(w.tax_minor) : '–'}</td><td>${w.fee_minor ? P.kes(w.fee_minor) : '–'}</td><td>${w.net_minor != null ? P.kes(w.net_minor) : '–'}</td><td>${P.esc(w.destination)}</td><td>${w.status}</td><td>${w.status === 'PENDING' && can('finance.withdrawals') ? `<button class="btn btn-primary btn-sm" onclick="D.wd(${w.id},true)">Pay out</button> <button class="btn btn-ghost btn-sm" onclick="D.wd(${w.id},false)">Reject</button>` : ''}</td></tr>`), 'No withdrawals.')}
      <h3 style="margin-top:20px">Recent ledger transactions</h3>${tbl(['#', 'Type', 'Description', 'Amount', 'Tax', 'Fee', 'When'], f.recent_transactions.map((t) => `<tr><td>${t.id}</td><td>${t.transaction_type}</td><td>${P.esc(t.description || '')}<div class="mono muted">${P.esc(t.reference)}</div></td><td>${P.kes(t.amount_minor)}</td><td>${t.tax_minor ? P.kes(t.tax_minor) : '–'}</td><td>${t.fee_minor ? P.kes(t.fee_minor) : '–'}</td><td class="xs">${P.date(t.created_at)}</td></tr>`))}`);
  };
  D.recon = () => act(() => P.api('/admin/finance/reconcile', { method: 'POST' }), 'Reconciliation recorded');
  D.wd = async (id, approve) => { let totp; if (approve) { totp = await P.askCode('Mark this withdrawal as paid out?', 'Confirm with your authenticator code.'); if (!totp) return; } act(() => P.api(`/admin/withdrawals/${id}`, { body: { approve, totp } }), approve ? 'Paid out' : 'Rejected and returned to the wallet'); };

  V.risk = async () => {
    const { flags, metrics: m } = await P.api('/admin/dashboard');
    setMain(`<h1>Risk</h1><div class="grid g3" style="margin-bottom:16px">${stat('Market-maker funds at risk', P.kes(m.amm_live_exposure_minor))}${stat('Open flags', flags.length)}${stat('Pending withdrawals', m.pending_withdrawals)}</div>
      <p class="muted">Flags are prompts for a human to look. Nothing here suspends anyone automatically.</p>${flags.map((f) => `<div class="flag"><b>${f.type.replace(/_/g, ' ').toLowerCase()}</b>: ${P.esc(f.detail)}${f.user_id ? ` <a href="#users" onclick="D.openUser(${f.user_id})">Open user</a>` : ''}</div>`).join('') || '<div class="empty">No flags right now.</div>'}`);
  };

  V.users = async () => {
    const l = await P.api('/admin/users');
    setMain(`<h1>Users</h1><div class="field" style="max-width:340px"><input id="uq" placeholder="Search name, username or email" oninput="D.usearch()"></div><div id="ul"></div>`);
    D._users = l; D.drawUsers(l);
  };
  D.drawUsers = (l) => { $('#ul').innerHTML = tbl(['#', 'Player', 'Contact', 'Status', 'Verification', 'Creator', 'Cash', 'In orders', ''], l.map((u) => `<tr><td>${u.id}</td><td><b>${P.esc(u.display_name)}</b><div class="xs muted">@${P.esc(u.username)}${u.staff_roles ? ' · ' + u.staff_roles : ''}</div></td><td class="xs">${P.esc(u.email)}<br>${P.esc(u.phone)}</td><td>${u.status}</td><td>${u.kyc_status}</td><td>${u.market_creator ? 'Approved' : '–'}</td><td>${P.kes(u.balances.available_minor)}</td><td>${P.kes(u.balances.reserved_orders_minor)}</td><td><button class="btn btn-ghost btn-sm" onclick="D.openUser(${u.id})">Open</button></td></tr>`)); };
  D.usearch = async () => { const v = $('#uq').value; D.drawUsers(await P.api('/admin/users?q=' + encodeURIComponent(v))); };
  D.openUser = async (id) => {
    const d = await P.api('/admin/users/' + id); const u = d.user;
    P.modal(`<h3>${P.esc(u.display_name)} <span class="xs muted">@${P.esc(u.username)}</span></h3>
      <dl class="kv"><dt>Status</dt><dd>${u.status}</dd><dt>Verification</dt><dd>${u.kyc_status}</dd><dt>Cash</dt><dd>${P.kes(d.balances.available_minor)}</dd><dt>In open orders</dt><dd>${P.kes(d.balances.reserved_orders_minor)}</dd><dt>Can propose markets</dt><dd>${u.market_creator ? 'Yes' : 'No'}</dd><dt>Deposit limit</dt><dd>${d.limits && d.limits.daily_deposit_limit_minor != null ? P.kes(d.limits.daily_deposit_limit_minor) : 'None'}</dd></dl>
      <div class="inline" style="margin:12px 0">${can('users.manage') ? `<button class="btn btn-ghost btn-sm" onclick="D.ustatus(${u.id},'${u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}')">${u.status === 'ACTIVE' ? 'Suspend account' : 'Reactivate'}</button><button class="btn btn-ghost btn-sm" onclick="D.ukyc(${u.id},'VERIFIED')">Mark verified</button><button class="btn btn-ghost btn-sm" onclick="D.ukyc(${u.id},'REJECTED')">Reject verification</button><button class="btn btn-ghost btn-sm" onclick="D.ucreator(${u.id},${!u.market_creator})">${u.market_creator ? 'Remove market creator' : 'Approve as market creator'}</button>` : ''}</div>
      <h4>Positions</h4><div class="xs">${(d.positions || []).filter((p) => p.yes_shares || p.no_shares).map((p) => `#${p.market_id} ${P.esc(p.title || '')}: ${p.yes_shares ? p.yes_shares + ' Yes ' : ''}${p.no_shares ? p.no_shares + ' No' : ''}`).join('<br>') || 'None'}</div>
      <h4>Open orders</h4><div class="xs">${(d.orders || []).filter((o) => ['OPEN', 'PARTIAL'].includes(o.status)).map((o) => `#${o.id} ${o.action} ${o.asset} ${o.remaining_shares != null ? o.remaining_shares : o.qty} @ ${o.limit_kes} ${can('market.suspend') ? `<a href="#" onclick="D.cancelOrder(${o.id});return false">cancel</a>` : ''}`).join('<br>') || 'None'}</div>
      <h4>Recent activity</h4><div class="xs">${d.transactions.slice(0, 8).map((t) => `${P.date(t.created_at)} · ${P.esc(t.description || t.transaction_type)}`).join('<br>') || 'None'}</div>`);
  };
  D.ustatus = (id, status) => { const r = ask('Reason'); if (r) act(() => P.api(`/admin/users/${id}/status`, { body: { status, reason: r } }), 'Updated').then(() => document.querySelector('.overlay') && document.querySelector('.overlay').remove()); };
  D.ucreator = (id, on) => act(() => P.api(`/admin/users/${id}/market-creator`, { body: { on } }), 'Updated').then(() => document.querySelector('.overlay') && document.querySelector('.overlay').remove());
  D.cancelOrder = (id) => act(() => P.api(`/admin/orders/${id}/cancel`, { method: 'POST' }), 'Order cancelled').then(() => document.querySelector('.overlay') && document.querySelector('.overlay').remove());
  D.ukyc = (id, status) => act(() => P.api(`/admin/users/${id}/kyc`, { body: { status } }), 'Updated').then(() => document.querySelector('.overlay') && document.querySelector('.overlay').remove());

  V.tax = async () => {
    const t = await P.api('/admin/tax');
    const types = { DEPOSIT_EXCISE: 'Deposit excise duty', WITHDRAWAL_WHT: 'Withdrawal withholding tax', WINNINGS_WHT: 'Winnings withholding tax', EXIT_WHT: 'Withholding tax on profitable sales' };
    const kinds = { DEPOSIT_FEE: 'Deposit fee', WITHDRAWAL_FEE: 'Withdrawal fee', PROFIT_COMMISSION: 'Profit commission' };
    setMain(`<div class="pagehead"><h1 style="margin:0">Tax and revenue</h1>${can('finance.tax') ? '<button class="btn btn-primary" onclick="D.remit()">Record KRA remittance</button>' : ''}</div>
      <div class="grid g3" style="margin-bottom:12px">${stat('Withheld, awaiting remittance', P.kes(t.pending_remittance_minor), t.pending_remittance_minor ? 'neg' : '')}${stat('Events awaiting remittance', t.pending_events)}${stat('GGR tax rate', (t.ggr_tax_bps / 100).toFixed(1) + '%')}</div>
      <p class="hint">Rates are settings, not code. Finance must confirm whether withholding tax applies to gross profit or net, whether it applies to early sales, and the statutory definition of gross gaming revenue before real money is used. Platform revenue here stands in for GGR.</p>
      <h3>Monthly GGR tax (due by the 20th of the next month)</h3>${tbl(['Month', 'Platform revenue (GGR)', 'GGR tax', 'Due'], t.ggr.map((g) => `<tr><td>${g.period}</td><td>${P.kes(g.ggr_minor)}</td><td>${P.kes(g.ggr_tax_minor)}</td><td>${g.due_date}</td></tr>`), 'No revenue booked yet.')}
      <h3 style="margin-top:20px">Tax withheld</h3>${tbl(['Month', 'Tax', 'Status', 'Events', 'Amount'], t.by_type.map((r) => `<tr><td>${r.period}</td><td>${types[r.tax_type] || r.tax_type}</td><td>${r.status === 'REMITTED' ? 'Remitted' : 'Pending'}</td><td>${r.events}</td><td>${P.kes(r.amount_minor)}</td></tr>`), 'Nothing withheld yet.')}
      <h3 style="margin-top:20px">Platform revenue</h3>${tbl(['Month', 'Source', 'Amount'], t.revenue.map((r) => `<tr><td>${r.period}</td><td>${kinds[r.kind] || r.kind}</td><td>${P.kes(r.amount_minor)}</td></tr>`), 'No revenue yet.')}
      <h3 style="margin-top:20px">KRA remittances</h3>${tbl(['Receipt', 'Month', 'Amount', 'Events', 'By', 'When'], t.remittances.map((r) => `<tr><td class="mono">${P.esc(r.receipt_ref)}</td><td>${r.period || 'All'}</td><td>${P.kes(r.amount_minor)}</td><td>${r.events}</td><td>${P.esc(r.username)}</td><td class="xs">${P.date(r.created_at)}</td></tr>`), 'None recorded.')}`);
  };
  D.remit = async () => {
    P.modal(`<h3>Record a KRA remittance</h3><p class="sm muted">Marks the pending tax as paid and moves it from payable to remitted. Enter the receipt reference from the KRA payment.</p>
      <div class="field"><label>KRA receipt reference</label><input id="k_r"></div><div class="field"><label>Month (optional, e.g. 2026-11)</label><input id="k_p" placeholder="All pending"></div><div class="err" id="k_e"></div><button class="btn btn-primary" id="k_go">Continue</button>`, (o, close) => {
      o.querySelector('#k_go').onclick = async () => {
        const receipt_ref = o.querySelector('#k_r').value, period = o.querySelector('#k_p').value.trim() || undefined; close();
        const totp = await P.askCode('Record this remittance?', 'This posts to the ledger. Confirm with your authenticator code.'); if (!totp) return;
        act(() => P.api('/admin/tax/remit', { body: { receipt_ref, period, totp } }), 'Remittance recorded');
      };
    });
  };

  V.reports = async () => {
    const l = await P.api('/admin/reports');
    setMain(`<h1>Reported markets</h1>${tbl(['Market', 'Reason', 'By', 'Status', ''], l.map((r) => `<tr><td><a href="/#/market/${r.market_id}" target="_blank" rel="noopener">${P.esc(r.title)}</a></td><td>${P.esc(r.reason)}</td><td>${P.esc(r.reporter)}</td><td>${r.status}</td><td>${r.status === 'OPEN' ? `<button class="btn btn-ghost btn-sm" onclick="D.rep(${r.id},'ACTIONED')">Actioned</button> <button class="btn btn-ghost btn-sm" onclick="D.rep(${r.id},'DISMISSED')">Dismiss</button>` : ''}</td></tr>`), 'No reports.')}`);
  };
  D.rep = (id, status) => act(() => P.api(`/admin/reports/${id}`, { body: { status } }), 'Updated');

  V.audit = async () => {
    const l = await P.api('/admin/audit?limit=200');
    setMain(`<h1>Audit log</h1><p class="muted">Append-only. Entries cannot be edited or deleted.</p>${tbl(['When', 'Who', 'Action', 'Entity', 'Details'], l.map((a) => `<tr><td class="xs">${P.date(a.created_at)}</td><td>${P.esc(a.actor || 'system')}</td><td>${P.esc(a.action)}</td><td>${P.esc(a.entity_type)} ${a.entity_id || ''}</td><td class="mono">${P.esc(JSON.stringify(a.details || {}))}</td></tr>`))}`);
  };

  V.staff = async () => {
    const l = await P.api('/admin/staff');
    setMain(`<h1>Staff roles</h1><p class="muted">Creating a market never grants staff power. Roles are granted only here.</p>
      <div class="card" style="margin-bottom:16px"><div class="row"><div class="field"><label>Username</label><input id="sf_u"></div><div class="field"><label>Role</label><select id="sf_r">${['moderator', 'settlement_officer', 'finance_officer', 'risk_officer', 'administrator', 'super_administrator'].map((r) => `<option value="${r}">${r.replace(/_/g, ' ')}</option>`).join('')}</select></div></div>
        <button class="btn btn-primary btn-sm" onclick="D.grant(true)">Grant role</button> <button class="btn btn-ghost btn-sm" onclick="D.grant(false)">Remove role</button></div>
      ${tbl(['User', 'Roles'], l.map((s) => `<tr><td><b>${P.esc(s.display_name)}</b> <span class="xs muted">@${P.esc(s.username)}</span></td><td>${P.esc(s.roles || '')}</td></tr>`))}`);
  };
  D.grant = async (grant) => { const totp = await P.askCode('Change staff roles', 'Role changes need your authenticator code.'); if (!totp) return; act(() => P.api('/admin/staff', { body: { username: $('#sf_u').value, role: $('#sf_r').value, grant, totp } }), 'Roles updated'); };

  boot();
})();
