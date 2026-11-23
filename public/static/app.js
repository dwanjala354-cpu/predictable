/* Predictable — player app (single page, hash routes). Binary Yes/No contracts that pay KES 100. */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const view = $('#view');
  const S = { me: null, bal: null, cats: [], cfg: null, unread: 0, q: '' };
  const A = (window.A = {});
  const SHARE = 10000; // minor units paid by one winning contract (KES 100)

  const html = (el, h) => { el.innerHTML = h; };
  const setView = (h) => { html(view, h); window.scrollTo(0, 0); };
  const loading = () => setView('<div class="empty">Loading…</div>');
  const fees = () => (S.cfg && S.cfg.fees) || { winnings_wht_bps: 2000, profit_commission_bps: 1000, deposit_excise_bps: 500, deposit_fee_bps: 500, withdrawal_wht_bps: 500, withdrawal_fee_bps: 500, tax_on_exit_sales: true };
  const pctBps = (b) => (b / 100).toFixed(b % 100 ? 1 : 0) + '%';
  // What a buyer nets if the contracts win: tax and commission apply to gross profit only (payout minus cost).
  const ifWins = (cost, shares) => {
    const f = fees(), payout = shares * SHARE, profit = Math.max(0, payout - cost);
    const wht = Math.floor((profit * f.winnings_wht_bps) / 10000), comm = Math.floor((profit * f.profit_commission_bps) / 10000);
    return { payout, profit, wht, comm, net: payout - wht - comm };
  };
  const kv = (rows) => `<dl class="kv">${rows.map((r) => `<dt>${r[0]}</dt><dd>${r[1]}</dd>`).join('')}</dl>`;
  const line = (label, val, cls = '') => `<div class="tline ${cls}"><span>${label}</span><b>${val}</b></div>`;

  async function refreshMe() {
    if (!P.token()) { S.me = null; S.bal = null; return; }
    try { const r = await P.api('/me'); S.me = r.user; S.bal = r.balances; const n = await P.api('/notifications'); S.unread = n.unread; }
    catch (e) { P.setToken(null); S.me = null; S.bal = null; }
  }

  // ───────── chrome ─────────
  function drawHeader() {
    const me = S.me;
    html($('#hdr'), `
      <a class="logo" href="#/">${P.logoSvg}Predictable</a>
      <form class="search" role="search" onsubmit="A.search(event)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="Search markets" aria-label="Search markets" value="${P.esc(S.q)}">
      </form>
      <div class="right">
        <button class="iconbtn" onclick="P.toggleTheme()" aria-label="Toggle dark mode" title="Toggle dark mode"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg></button>
        ${me ? `
          <a class="iconbtn" href="#/notifications" aria-label="Notifications">🔔${S.unread ? `<b>${S.unread}</b>` : ''}</a>
          <a class="bal" href="#/wallet"><span>Cash</span>${P.kes(S.bal.available_minor)}</a>
          <div class="menu"><button class="btn btn-ghost btn-sm" aria-haspopup="true" onclick="A.menu(event)">${P.esc(me.display_name)} ▾</button>
            <div class="pop hidden" id="pop">
              <a href="#/portfolio">Portfolio</a><a href="#/create">Propose a market</a><a href="#/wallet">Wallet</a><a href="#/profile">Limits and safety</a><a href="#/security">Account security</a>
              ${me.permissions.includes('admin.dashboard') ? '<a href="/admin">Admin console</a>' : ''}
              <button onclick="A.logout()">Sign out</button></div></div>`
        : `<a class="btn btn-ghost btn-sm" href="#/login">Log in</a><a class="btn btn-primary btn-sm" href="#/register">Sign up</a>`}
      </div>`);
  }
  A.menu = (e) => { e.stopPropagation(); $('#pop').classList.toggle('hidden'); };
  document.addEventListener('click', () => { const p = $('#pop'); if (p) p.classList.add('hidden'); });
  A.search = (e) => { e.preventDefault(); S.q = $('#q').value.trim(); location.hash = '#/?q=' + encodeURIComponent(S.q); };

  function drawNav(route, params) {
    const cat = params.get('cat') || '', sort = params.get('sort') || '';
    const l = (href, label, on) => `<a href="${href}" class="${on ? 'on' : ''}">${label}</a>`;
    const home = route === '' || route === '/';
    html($('#nav2'), [
      l('#/', 'Trending', home && !cat && !sort),
      l('#/?sort=new', 'New', home && sort === 'new'),
      l('#/?sort=closing', 'Closing soon', home && sort === 'closing'),
      '<span class="sep"></span>',
      ...S.cats.map((c) => l('#/?cat=' + c.slug, P.esc(c.name), home && cat === c.slug)),
      '<span class="sep"></span>',
      l('#/portfolio', 'Portfolio', route === '/portfolio'),
      l('#/leaderboard', 'Leaderboard', route === '/leaderboard'),
      l('#/how', 'How it works', route === '/how'),
    ].join(''));
  }

  // ───────── market card ─────────
  const stats = (m) => `<span>${P.kesShort(m.volume_minor || 0)} volume</span><span>${P.kesShort(m.open_interest_minor || 0)} open interest</span>`;
  function card(m) {
    const live = m.status === 'OPEN' && new Date(m.closes_at) - Date.now() < 3600e3;
    return `<a class="mcard" href="#/market/${m.id}">
      <div class="mtop">${P.icon(m)}<h3>${P.esc(m.title)}</h3>
        <div class="pct"><b>${P.pc(m.yes_price_kes)}</b><span>chance</span></div></div>
      <div class="two-b"><span class="bigb yes-b">Yes <small>${P.price(m.yes_price_kes)}</small></span><span class="bigb no-b">No <small>${P.price(m.no_price_kes)}</small></span></div>
      <div class="mfoot"><span class="stats">${stats(m)}</span>
        <span>${live ? '<span class="tag-live">Closing</span> ' : ''}${m.status === 'OPEN' ? P.left(m.closes_at) : P.statusBadge(m.status)}</span></div>
      <div class="mmeta"><span>${P.esc(m.category_name)}</span></div>
    </a>`;
  }

  // ───────── home ─────────
  async function home(params) {
    loading();
    const qs = new URLSearchParams();
    for (const k of ['cat', 'q']) if (params.get(k)) qs.set(k === 'cat' ? 'category' : k, params.get(k));
    const status = params.get('status') || 'OPEN';
    if (status !== 'ALL') qs.set('status', status);
    qs.set('limit', '120');
    if (params.get('q')) S.q = params.get('q');
    const list = await P.api('/markets?' + qs);
    const sort = params.get('sort') || 'volume';
    const by = { volume: (a, b) => b.volume_minor - a.volume_minor, new: (a, b) => b.id - a.id, closing: (a, b) => new Date(a.closes_at) - new Date(b.closes_at) };
    list.sort(by[sort] || by.volume);
    const plain = status === 'OPEN' && !params.get('cat') && !params.get('q') && !params.get('sort');
    const totalVol = list.reduce((s, m) => s + (m.volume_minor || 0), 0), totalOi = list.reduce((s, m) => s + (m.open_interest_minor || 0), 0);
    const feat = plain && list[0];
    setView(`
      ${!S.me ? `<section class="strip"><div><h1>Trade what happens next in Kenya.</h1><p>Every market is a Yes/No question. A Yes contract and a No contract each pay KES 100 if they are right, so the price in shillings is the market's chance in percent. Buy now, sell any time before the event.</p></div>
        <div class="stats"><div><span class="num">${list.length}</span><span class="xs muted">open markets</span></div><div><span class="num">${P.kesShort(totalVol)}</span><span class="xs muted">traded</span></div><div><span class="num">${P.kesShort(totalOi)}</span><span class="xs muted">open interest</span></div></div></section>` : ''}
      ${feat ? `<div class="feat">
        <a class="featbig" href="#/market/${feat.id}"><div class="mmeta"><span class="badge b-open">Top market</span><span>${P.esc(feat.category_name)}</span><span>${P.left(feat.closes_at)}</span></div>
          <h2>${P.esc(feat.title)}</h2>
          <div class="bigchance"><b>${P.pc(feat.yes_price_kes)}</b><span class="muted">chance of Yes</span></div>
          <div class="two-b"><span class="bigb yes-b">Yes <small>${P.price(feat.yes_price_kes)}</small></span><span class="bigb no-b">No <small>${P.price(feat.no_price_kes)}</small></span></div>
          <div class="mfoot"><span class="stats">${stats(feat)}</span><span>${feat.holders || 0} holders</span></div></a>
        <div class="newslist"><h3 style="padding:10px 0 0">Closing soon</h3>${[...list].sort(by.closing).slice(0, 4).map((m) => `<a href="#/market/${m.id}">${P.icon(m)}<span style="flex:1"><b>${P.esc(m.title)}</b><br><span class="xs muted">${P.left(m.closes_at)} · Yes ${P.price(m.yes_price_kes)}</span></span></a>`).join('')}</div></div>` : ''}
      <div class="spread"><h2 style="margin:0">${params.get('q') ? `Results for “${P.esc(params.get('q'))}”` : 'All markets'}</h2>
        <button class="btn btn-primary btn-sm" onclick="location.hash='#/create'">+ Propose a market</button></div>
      <div class="filters" style="margin-top:12px">
        ${['OPEN', 'ALL'].map((s) => `<button class="pill ${status === s ? 'on' : ''}" onclick="A.setParam('status','${s}')">${s === 'OPEN' ? 'Active' : 'All'}</button>`).join('')}
        <select aria-label="Sort" onchange="A.setParam('sort',this.value)"><option value="volume" ${sort === 'volume' ? 'selected' : ''}>Sort: most traded</option><option value="new" ${sort === 'new' ? 'selected' : ''}>Sort: newest</option><option value="closing" ${sort === 'closing' ? 'selected' : ''}>Sort: closing soon</option></select>
      </div>
      ${list.length ? `<div class="mgrid">${list.map(card).join('')}</div>` : `<div class="empty"><h3>No markets here yet</h3><p>Approved creators can propose one.</p><a class="btn btn-primary" href="#/create">Propose a market</a></div>`}`);
  }
  A.setParam = (k, v) => { const [r, q] = location.hash.slice(1).split('?'); const p = new URLSearchParams(q || ''); p.set(k, v); location.hash = '#' + (r || '/') + '?' + p; };

  // ───────── price chart (inline SVG, numbers only) ─────────
  function chart(hist, m) {
    const W = 640, H = 200, L = 34, R = 8, T = 10, B = 20;
    let pts = hist.map((h) => Number(h.price_kes));
    if (!pts.length) pts = [Number(m.initial_price_kes), Number(m.yes_price_kes)];
    else if (pts.length === 1) pts = [Number(m.initial_price_kes), pts[0]];
    const x = (i) => L + (i * (W - L - R)) / Math.max(1, pts.length - 1), y = (p) => T + ((100 - p) * (H - T - B)) / 100;
    const path = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p).toFixed(1)).join(' ');
    const grid = [0, 25, 50, 75, 100].map((g) => `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" class="cg"/><text x="${L - 6}" y="${y(g) + 4}" text-anchor="end" class="ct">${g}%</text>`).join('');
    const last = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Price history of Yes, now ${Math.round(last)} percent">${grid}<path d="${path}" class="cl" fill="none"/><circle cx="${x(pts.length - 1)}" cy="${y(last)}" r="4" class="cd"/></svg>
      <div class="xs muted">${hist.length ? `Yes price at each of the last ${hist.length} trade${hist.length > 1 ? 's' : ''}.` : 'No trades yet. The line starts at the opening estimate.'}</div>`;
  }

  // ───────── order book ─────────
  function bookHtml(b, m) {
    const max = Math.max(1, ...b.bids.map((x) => x.qty), ...b.asks.map((x) => x.qty));
    const rows = (l, cls) => l.length ? l.map((x) => `<div class="brow ${cls}"><i style="width:${Math.round((x.qty / max) * 100)}%"></i><span>${x.price_kes}</span><span>${P.n(x.qty)}</span><span class="muted">${x.orders}</span></div>`).join('') : '<div class="brow muted"><span>–</span><span>–</span><span></span></div>';
    return `<div class="grid g2" style="gap:14px"><div><div class="bhead"><b>Buyers of Yes</b><span class="xs muted">Bids</span></div><div class="bcols xs muted"><span>Price (KES)</span><span>Contracts</span><span>Orders</span></div>${rows(b.bids, 'bid')}</div>
      <div><div class="bhead"><b>Sellers of Yes</b><span class="xs muted">Asks</span></div><div class="bcols xs muted"><span>Price (KES)</span><span>Contracts</span><span>Orders</span></div>${rows(b.asks, 'ask')}</div></div>
      ${b.amm ? `<div class="info" style="margin-top:12px"><b>Market maker</b> always quotes Yes ${P.price(b.amm.yes_price_kes)} · No ${P.price(b.amm.no_price_kes)}, moving a little with each trade. Your order takes whichever is cheaper, the market maker or a trader on the book.</div>` : '<p class="hint" style="margin-top:12px">This market has no market maker, so trades happen only against other traders\' orders.</p>'}
      <p class="hint">The book is quoted in the price of Yes. Buying No at KES 45 appears here as a sell of Yes at KES 55, since the two always add to KES 100.</p>`;
  }

  // ───────── market detail ─────────
  const T = { action: 'BUY', asset: 'YES', limit: 50, qty: 1, market: false, seq: 0 };
  async function market(id) {
    loading();
    const m = await P.api(`/markets/${id}`);
    const [hist, pos] = await Promise.all([P.api(`/markets/${id}/history`).catch(() => []), S.me ? P.api('/my/positions').catch(() => []) : Promise.resolve([])]);
    const mine = pos.find((p) => p.market_id === m.id) || null;
    let payout = [];
    if (S.me && ['SETTLED', 'VOID', 'DISPUTED'].includes(m.status)) payout = await P.api(`/markets/${id}/my-payout`).catch(() => []);
    A._m = m; A._pos = mine;
    if (T.mid !== m.id) { Object.assign(T, { mid: m.id, action: 'BUY', asset: 'YES', market: false, qty: 1 }); T.limit = Math.round(m.yes_price_kes); }
    const open = m.status === 'OPEN', b = m.book, rules = m.rules, f = m.fees;
    const win = m.settlement && m.settlement.status === 'EXECUTED' ? m.outcomes.find((o) => o.id === m.settlement.outcome_id) : null;
    setView(`
      <div class="twocol"><div class="stack">
        <div class="card">
          <div class="mtop">${P.icon(m)}<div style="flex:1"><div class="mmeta" style="margin-bottom:6px"><span>${P.esc(m.category_name)}</span>${P.statusBadge(m.status)}<span>proposed by ${P.esc(m.creator_name)}</span></div>
            <h1 style="font-size:1.6rem;margin:0">${P.esc(m.title)}</h1></div></div>
          ${m.description ? `<p class="muted" style="margin:12px 0 0">${P.esc(m.description)}</p>` : ''}
          <hr class="divider">
          <div class="chance"><div class="bigchance"><b>${P.pc(m.yes_price_kes)}</b><span class="muted">chance of Yes</span></div>
            <div class="two-b" style="min-width:min(280px,100%)"><span class="bigb yes-b">Yes <small>${P.price(m.yes_price_kes)}</small></span><span class="bigb no-b">No <small>${P.price(m.no_price_kes)}</small></span></div></div>
          <div style="margin-top:14px">${chart(hist, m)}</div>
          <hr class="divider">
          <div class="grid g4">
            <div><div class="xs muted">Volume</div><div class="num" style="font-size:1.2rem">${P.kes(m.volume_minor)}</div><div class="xs muted">${P.n(m.trade_count)} trades</div></div>
            <div><div class="xs muted">Open interest</div><div class="num" style="font-size:1.2rem">${P.kes(m.open_interest_minor)}</div><div class="xs muted">${P.n(m.holders)} holders</div></div>
            <div><div class="xs muted">Trading closes</div><div style="font-weight:600">${P.date(m.closes_at)}</div><div class="xs muted">${open ? P.left(m.closes_at) : ''}</div></div>
            <div><div class="xs muted">Event</div><div style="font-weight:600">${P.date(m.event_at)}</div></div>
          </div>
        </div>

        ${resultCard(m, win, payout)}
        ${m.status === 'PENDING_REVIEW' ? '<div class="card notice">This market is in review. A different staff member checks the wording and the source, then it opens for trading.</div>' : ''}
        ${m.status === 'SUSPENDED' ? '<div class="card notice">Trading is paused. It resumes when staff re-open the market.</div>' : ''}
        ${['LOCKED', 'EVENT_PENDING', 'RESULT_PENDING'].includes(m.status) ? '<div class="card notice">Trading is closed. The result is being confirmed from the official source.</div>' : ''}

        <div class="card"><h3>Order book</h3>${bookHtml(b, m)}</div>

        <div class="card">
          <div class="tabs" role="tablist"><button class="tab" role="tab" aria-selected="true" onclick="A.tab(this,'t-rules')">Rules</button><button class="tab" role="tab" aria-selected="false" onclick="A.tab(this,'t-research')">Research</button><button class="tab" role="tab" aria-selected="false" onclick="A.tab(this,'t-trades')">Recent trades</button></div>
          <div id="t-rules" class="tabpane"><dl class="kv">
            <dt>Resolution source</dt><dd>${P.esc(rules.resolution_source)}</dd><dt>How it is read</dt><dd>${P.esc(rules.resolution_method)}</dd>
            <dt>If cancelled</dt><dd>${P.esc(rules.cancellation_rules)}</dd><dt>If postponed</dt><dd>${P.esc(rules.postponement_rules)}</dd><dt>Payouts</dt><dd>Each contract pays KES 100 if its side is right and KES 0 if not. Withholding tax of ${pctBps(f.winnings_wht_bps)} and a ${pctBps(f.profit_commission_bps)} commission apply to your profit only, never to your cost.${f.tax_on_exit_sales ? ' The same applies to a profit when you sell early.' : ' Selling early before the result carries no tax in this release.'}</dd>
            <dt>Dispute window</dt><dd>${m.dispute_window_hours} hours after settlement</dd></dl>
            <div style="margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="A.report(${m.id})">Report this market</button></div></div>
          <div id="t-research" class="tabpane hidden"><div class="info">${P.esc(m.research.summary)}</div>${researchHtml(m.research)}
            ${m.analysis ? `<h4 style="margin-top:14px">Question check</h4>${(m.analysis.summary.issues || []).length ? m.analysis.summary.issues.map((i) => `<div class="issue"><span class="tg sev-${P.esc(i.severity)}">${P.esc(i.severity)}</span><span>${P.esc(i.message)}</span></div>`).join('') : '<p class="muted">No wording problems found.</p>'}` : ''}
            <p class="hint">Research uses source-linked evidence only. Estimates come from reproducible models, never from a chatbot's guess, and the assistant cannot move money or decide results.</p></div>
          <div id="t-trades" class="tabpane hidden">${b.recent_trades.length ? `<div class="tscroll"><table><tr><th>When</th><th>Price of Yes</th><th>Contracts</th></tr>${b.recent_trades.map((t) => `<tr><td class="xs">${P.date(t.created_at)}</td><td>${P.price(t.price_kes)}</td><td>${P.n(t.qty)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No trades yet.</p>'}</div>
        </div>
      </div>
      <aside class="slip stack" aria-label="Trade">
        <div class="card" id="ticket">${ticket(m)}</div>
        ${S.me ? positionCard(m, mine) : ''}
        ${S.me && b.my_orders && b.my_orders.length ? ordersCard(b.my_orders) : ''}
      </aside></div>`);
    if (S.me && open && !m.is_creator) {
      if (T.pendingSell) { const s = mine && mine[T.pendingSell.toLowerCase()]; const a = T.pendingSell; T.pendingSell = null; if (s && s.shares - s.locked > 0) { A.sellPos(a, s.shares - s.locked); return; } }
      A.preview();
    }
  }
  function resultCard(m, win, payout) {
    if (m.status === 'VOID' || (m.settlement && m.settlement.status === 'EXECUTED' && !m.settlement.outcome_id)) {
      const px = m.settlement && m.settlement.summary && m.settlement.summary.void_price_kes;
      return `<div class="card info"><h3>Market voided</h3><p style="margin:0">${P.esc((m.settlement && m.settlement.reason) || 'The event did not take place as described.')} Every contract was redeemed at the last traded price${px != null ? ' of Yes ' + P.price(px) : ''}. No tax or commission was charged.</p>${payoutBreakdown(payout)}</div>`;
    }
    if (!win) return '';
    return `<div class="card info"><div class="spread"><h3 style="margin:0">Result: <span class="${win.outcome_code === 'YES' ? 'pos' : 'neg'}">${P.esc(win.outcome_name)}</span> won</h3>
      ${m.status === 'SETTLED' || m.status === 'DISPUTED' ? '<button class="btn btn-ghost btn-sm" onclick="A.dispute(' + m.id + ')">Dispute this result</button>' : ''}</div>
      <p style="margin:6px 0 0">${win.outcome_code === 'YES' ? 'Yes' : 'No'} contracts paid KES 100 each. ${m.status === 'DISPUTED' ? 'A dispute is open, so payouts may be corrected.' : ''}</p>${payoutBreakdown(payout)}</div>`;
  }
  function payoutBreakdown(rows) {
    if (!rows || !rows.length) return '';
    const sum = (k) => rows.reduce((s, r) => s + Number(r[k]), 0);
    return `<h4 style="margin:14px 0 6px">Your payout</h4>${rows.map((r) => `<div class="xs muted">${P.n(r.shares)} ${P.esc(r.side)} contract${r.shares > 1 ? 's' : ''}</div>`).join('')}
      <div class="tlines">${line('Payout (gross)', P.kes(sum('gross_minor')))}${line('Cost of your contracts', '−' + P.kes(sum('cost_basis_minor')))}${line('Profit', P.kes(sum('profit_minor')))}${line('Withholding tax on profit', '−' + P.kes(sum('wht_minor')))}${line('Platform commission on profit', '−' + P.kes(sum('commission_minor')))}${line('Paid to your wallet', P.kes(sum('net_minor')), 'tot')}</div>`;
  }
  function researchHtml(r) {
    const model = r.model && r.model.outcomes ? `<div class="card" style="margin-top:12px"><b class="sm">Statistical estimate</b><div style="margin:8px 0">${r.model.outcomes.map((o) => `<div class="oline"><span class="nm">${P.esc(o.outcome)}</span><span class="pc num">${Math.round(o.probability * 100)}%</span></div>`).join('')}</div><p class="hint">${r.model.expected_goals ? `Expected goals ${P.esc(r.model.expected_goals.home)}–${P.esc(r.model.expected_goals.away)}. ` : ''}${P.esc(r.model.note || '')}</p></div>` : '';
    const sec = (r.sections || []).filter((x) => x.items.length).map((x) => `<h4 style="margin:14px 0 6px">${P.esc(x.title)}</h4>` + x.items.map((i) => i.source_url && i.claim ? `<div class="issue"><span>${P.esc(i.claim)} <a href="${P.esc(i.source_url)}" target="_blank" rel="noopener noreferrer">${P.esc(i.source_name)}</a></span></div>` : i.source_url ? `<div class="xs"><a href="${P.esc(i.source_url)}" target="_blank" rel="noopener noreferrer">${P.esc(i.source_name)}</a></div>` : `<div class="sm">${P.esc(i.claim)}</div>`).join('')).join('');
    return model + sec;
  }
  A.tab = (btn, id) => { btn.parentElement.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t === btn)); btn.closest('.card').querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== id)); };

  // ───────── trade ticket ─────────
  function ticket(m) {
    if (!S.me) return `<h3>Trade this market</h3><p class="muted">Create an account to buy and sell contracts. It takes a minute.</p><a class="btn btn-primary btn-block" href="#/register">Sign up</a><a class="btn btn-ghost btn-block" style="margin-top:8px" href="#/login?next=market/${m.id}">Log in</a>`;
    if (m.is_creator) return `<h3>Trading is off for you</h3><p class="muted">You proposed this market, so you can't trade it. That keeps creators from profiting on questions they control. You can still follow it and share it.</p>`;
    if (m.status !== 'OPEN') return `<h3>Trading is closed</h3><p class="muted">${m.status === 'PENDING_REVIEW' ? 'The market opens for trading once a reviewer approves it.' : m.status === 'SUSPENDED' ? 'Trading is paused by staff.' : ['SETTLED', 'VOID', 'DISPUTED'].includes(m.status) ? 'This market has finished. Your payout is shown in the result above.' : 'This market closed for trading. The result is being confirmed.'}</p>`;
    const buy = T.action === 'BUY', px = T.asset === 'YES' ? m.yes_price_kes : m.no_price_kes;
    return `<div class="seg" role="tablist"><button class="${buy ? 'on' : ''}" onclick="A.setT('action','BUY')">Buy</button><button class="${buy ? '' : 'on'}" onclick="A.setT('action','SELL')">Sell</button></div>
      <div class="two-b" style="margin:12px 0"><button class="bigb yes-b ${T.asset === 'YES' ? 'sel' : ''}" onclick="A.setT('asset','YES')">Yes <small>${P.price(m.yes_price_kes)}</small></button><button class="bigb no-b ${T.asset === 'NO' ? 'sel' : ''}" onclick="A.setT('asset','NO')">No <small>${P.price(m.no_price_kes)}</small></button></div>
      <div class="field"><div class="spread"><label for="t_lim" style="margin:0">${buy ? 'Highest' : 'Lowest'} price you accept (KES 1–99)</label><button class="btn btn-ghost btn-sm" onclick="A.mkt()" title="Take the best prices available right now">Market</button></div>
        <input id="t_lim" type="number" inputmode="numeric" min="1" max="99" step="1" value="${T.limit}" oninput="A.onT()" ${T.market ? 'readonly' : ''}>
        <div class="hint" id="t_mode">${T.market ? `Market order: ${buy ? 'pays up to KES 99' : 'sells down to KES 1'} per contract, takes the best prices now, and cancels anything left over.` : `Limit order: matches anything at ${buy ? 'this price or lower' : 'this price or higher'}. The rest waits on the order book. Now ${P.price(px)}.`}</div></div>
      <div class="field"><label for="t_qty">Contracts</label><div class="inline"><input id="t_qty" type="number" inputmode="numeric" min="1" step="1" value="${T.qty}" oninput="A.onT()" style="flex:1">${[1, 5, 10, 50].map((n) => `<button class="btn btn-ghost btn-sm" onclick="A.addQty(${n})">+${n}</button>`).join('')}</div>
        <div class="hint">Each contract pays KES 100 if ${T.asset === 'YES' ? 'Yes' : 'No'} is right.</div></div>
      <div id="t_pv" class="tpv"></div><div class="err" id="t_err"></div>
      <button class="btn ${T.asset === 'YES' ? 'btn-yes' : 'btn-no'} btn-block" id="t_go" onclick="A.place()" disabled>${buy ? 'Buy' : 'Sell'} ${T.asset === 'YES' ? 'Yes' : 'No'}</button>
      ${S.me.kyc_status !== 'VERIFIED' ? `<p class="hint">You need to <a href="#/wallet">verify your account</a> before you can trade.</p>` : ''}
      <p class="hint">Cash available: ${P.kes(S.bal.available_minor)}. Simulated funds.</p>`;
  }
  A.setT = (k, v) => {
    if (T[k] === v) return; T[k] = v; T.market = false;
    const m = A._m; if (k === 'asset' || k === 'action') T.limit = Math.round(T.asset === 'YES' ? m.yes_price_kes : m.no_price_kes);
    html($('#ticket'), ticket(m)); A.preview();
  };
  A.mkt = () => { T.market = !T.market; T.limit = T.market ? (T.action === 'BUY' ? 99 : 1) : Math.round(T.asset === 'YES' ? A._m.yes_price_kes : A._m.no_price_kes); html($('#ticket'), ticket(A._m)); A.preview(); };
  A.addQty = (n) => { T.qty = Math.min(10000, (parseInt($('#t_qty').value, 10) || 0) + n); $('#t_qty').value = T.qty; A.onT(); };
  A.onT = () => { T.limit = parseInt($('#t_lim').value, 10) || 0; T.qty = parseInt($('#t_qty').value, 10) || 0; clearTimeout(A._pt); A._pt = setTimeout(A.preview, 300); };
  const body = () => ({ action: T.action, asset: T.asset, limit_kes: T.limit, qty: T.qty, tif: T.market ? 'IOC' : 'GTC' });
  A.preview = async () => {
    const box = $('#t_pv'), btn = $('#t_go'), err = $('#t_err'); if (!box) return;
    const seq = ++T.seq, m = A._m;
    if (!(T.limit >= 1 && T.limit <= 99) || !(T.qty >= 1)) { box.innerHTML = '<p class="muted sm">Enter a price from 1 to 99 and at least one contract.</p>'; btn.disabled = true; return; }
    try {
      const r = await P.api(`/markets/${m.id}/orders/preview`, { body: body() });
      if (seq !== T.seq) return; err.textContent = ''; box.innerHTML = previewHtml(r, m); btn.disabled = !(r.filled > 0 || r.resting);
    } catch (e) { if (seq !== T.seq) return; box.innerHTML = ''; err.textContent = e.message; btn.disabled = true; }
  };
  function previewHtml(r, m) {
    const buy = T.action === 'BUY', side = T.asset === 'YES' ? 'Yes' : 'No', left = r.remaining, rest = r.resting && left > 0;
    const f = fees(); let h = '';
    if (r.filled > 0) {
      h += `<div class="tlines">${line(buy ? 'Matched now' : 'Sold now', `${P.n(r.filled)} of ${P.n(T.qty)} at avg ${P.price(r.avg_price_kes)}`)}`;
      if (buy) {
        const extra = rest ? left * T.limit * 100 : 0, cost = r.gross_minor + extra, n = r.filled + (rest ? left : 0), w = ifWins(cost, n);
        h += line(rest ? 'Cost if all fill' : 'Cost', P.kes(cost)) + line(`You win KES 100 per contract`, P.kes(w.payout)) + line('Profit if it wins', P.kes(w.profit)) +
          line(`Withholding tax (${pctBps(f.winnings_wht_bps)} of profit)`, '−' + P.kes(w.wht)) + line(`Commission (${pctBps(f.profit_commission_bps)} of profit)`, '−' + P.kes(w.comm)) + line(`Net if ${side} wins`, P.kes(w.net), 'tot');
        h += `<div class="xs muted">Tax is only taken when you win or sell at a profit, and only on the profit.</div>`;
      } else {
        h += line('Proceeds', P.kes(r.gross_minor));
        if (f.tax_on_exit_sales) h += line(`Withholding tax (${pctBps(f.winnings_wht_bps)} of profit)`, '−' + P.kes(r.tax_minor)) + line(`Commission (${pctBps(f.profit_commission_bps)} of profit)`, '−' + P.kes(r.commission_minor));
        else h += line('Tax and commission', 'None on early sales');
        h += line('You receive', P.kes(r.net_minor), 'tot');
      }
      h += '</div>';
    }
    if (rest) h += `<div class="info" style="margin-top:8px">${r.filled > 0 ? `${P.n(left)} contract${left > 1 ? 's' : ''} won't match right now.` : 'Nothing matches at this price right now.'} ${buy ? `${P.kes(left * T.limit * 100)} stays reserved from your cash while` : 'Those contracts are locked while'} your order waits on the order book at ${P.price(T.limit)}. It fills when someone takes it, and you can cancel any time.${buy && r.filled === 0 ? ` If it fills, you pay ${P.price(T.limit)} or less per contract.` : ''}</div>`;
    else if (left > 0) h += `<div class="notice" style="margin-top:8px">${P.n(left)} contract${left > 1 ? 's' : ''} can't be filled at ${buy ? 'or below' : 'or above'} ${P.price(T.limit)} right now and will be cancelled.</div>`;
    if (!r.filled && !rest) h += '<div class="notice">Nothing would be filled at this price.</div>';
    return h;
  }
  A.place = async () => {
    const m = A._m, btn = $('#t_go'); btn.disabled = true;
    try {
      const r = await P.api(`/markets/${m.id}/orders`, { body: body() });
      const w = T.asset === 'YES' ? 'Yes' : 'No';
      P.toast(r.filled ? `${T.action === 'BUY' ? 'Bought' : 'Sold'} ${r.filled} ${w} at avg ${P.price(r.avg_price_kes)}${r.resting ? `. ${r.remaining} resting on the book.` : ''}` : `Order placed: ${r.remaining} ${w} waiting on the book at ${P.price(T.limit)}`);
      await refreshMe(); drawHeader(); route();
    } catch (e) { P.fail(e); btn.disabled = false; A.preview(); }
  };

  function positionCard(m, pos) {
    const rows = pos ? ['yes', 'no'].filter((k) => pos[k].shares > 0).map((k) => ({ k, s: pos[k] })) : [];
    return `<div class="card"><h3>Your position</h3>${rows.length ? rows.map(({ k, s }) => `<div class="posrow"><div class="spread"><b class="${k === 'yes' ? 'pos' : 'neg'}">${P.n(s.shares)} ${k === 'yes' ? 'Yes' : 'No'}</b>${m.status === 'OPEN' && !m.is_creator ? `<button class="btn btn-ghost btn-sm" onclick="A.sellPos('${k.toUpperCase()}',${s.shares - s.locked})">Sell</button>` : ''}</div>
      <div class="xs muted">Avg entry ${P.price(s.avg_entry_kes)} · now ${P.price(pos[k + '_price_kes'])} · value ${P.kes(s.market_value_minor)}</div>
      <div class="xs">Unrealised <span class="${s.unrealized_minor >= 0 ? 'pos' : 'neg'}">${P.kes(s.unrealized_minor)}</span> · if it wins you net ${P.kes(s.net_if_wins_minor)} after ${P.kes(s.tax_if_wins_minor + s.commission_if_wins_minor)} tax and commission</div>${s.locked ? `<div class="xs muted">${P.n(s.locked)} locked in sell orders</div>` : ''}</div>`).join('') : '<p class="muted sm" style="margin:0">You hold no contracts in this market.</p>'}
      ${pos && pos.realized_pnl_minor ? `<div class="xs" style="margin-top:8px">Realised profit and loss: <span class="${pos.realized_pnl_minor >= 0 ? 'pos' : 'neg'}">${P.kes(pos.realized_pnl_minor)}</span></div>` : ''}</div>`;
  }
  A.sellPos = (asset, qty) => {
    const m = A._m; Object.assign(T, { action: 'SELL', asset, market: false, qty: Math.max(1, qty), limit: Math.round(asset === 'YES' ? m.yes_price_kes : m.no_price_kes) });
    html($('#ticket'), ticket(m)); A.preview(); $('#ticket').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  function ordersCard(list) {
    return `<div class="card"><h3>Your open orders</h3>${list.map((o) => `<div class="posrow"><div class="spread"><b>${o.action === 'BUY' ? 'Buy' : 'Sell'} ${o.asset === 'YES' ? 'Yes' : 'No'}</b><button class="btn btn-ghost btn-sm" onclick="A.cancel(${o.id})">Cancel</button></div>
      <div class="xs muted">${P.n(o.qty)} at ${P.price(o.limit_kes)} · filled ${P.n(o.filled)} of ${P.n(o.qty)}</div></div>`).join('')}</div>`;
  }
  A.cancel = async (id) => { try { await P.api('/orders/' + id, { method: 'DELETE' }); P.toast('Order cancelled'); await refreshMe(); drawHeader(); route(); } catch (e) { P.fail(e); } };
  A.report = (id) => P.modal(`<h3>Report this market</h3><div class="field"><label>What is wrong with it?</label><textarea id="rr" placeholder="e.g. The result can't be verified from the stated source"></textarea></div><div class="inline"><button class="btn btn-primary" id="rs">Send report</button></div>`, (o, close) => {
    o.querySelector('#rs').onclick = async () => { try { await P.api(`/markets/${id}/report`, { body: { reason: o.querySelector('#rr').value } }); P.toast('Report sent'); close(); } catch (e) { P.fail(e); } };
  });
  A.dispute = (id) => P.modal(`<h3>Dispute this result</h3><p class="muted sm">Explain why the result looks wrong and link any evidence. An independent reviewer decides.</p><div class="field"><label>Reason</label><textarea id="dr"></textarea></div><div class="field"><label>Evidence link (optional)</label><input id="de"></div><button class="btn btn-primary" id="ds">Submit dispute</button>`, (o, close) => {
    o.querySelector('#ds').onclick = async () => { try { await P.api(`/markets/${id}/dispute`, { body: { reason: o.querySelector('#dr').value, evidence: o.querySelector('#de').value } }); P.toast('Dispute filed'); close(); route(); } catch (e) { P.fail(e); } };
  });

  // ───────── auth ─────────
  function login() {
    setView(`<div class="card" style="max-width:420px;margin:30px auto"><h2>Log in</h2>
      <div class="field"><label for="li">Username or email</label><input id="li" autocomplete="username"></div>
      <div class="field"><label for="lp">Password</label><input id="lp" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')A.doLogin()"></div>
      <div id="lcode"></div><div class="err" id="le"></div><button class="btn btn-primary btn-block" onclick="A.doLogin()">Log in</button>
      <p class="sm muted" style="margin-top:14px">New here? <a href="#/register">Create an account</a></p></div>`);
  }
  A.doLogin = async () => {
    const t = $('#lt');
    try {
      const r = await P.api('/auth/login', { body: { identifier: $('#li').value, password: $('#lp').value, totp: t ? t.value : undefined } });
      if (r.mfa_required) {
        $('#lcode').innerHTML = '<div class="field"><label for="lt">Authenticator code</label><input id="lt" inputmode="numeric" autocomplete="one-time-code" maxlength="6" onkeydown="if(event.key===\'Enter\')A.doLogin()"><div class="hint">Open your authenticator app and enter the 6-digit code.</div></div>';
        $('#lt').focus(); $('#le').textContent = ''; return;
      }
      P.setToken(r.token); await boot();
      const next = new URLSearchParams(location.hash.split('?')[1] || '').get('next'); location.hash = '#/' + (next || '');
    } catch (e) {
      $('#le').innerHTML = P.esc(e.message) + (e.code === 'ACCOUNT_SUSPENDED' ? ' <a href="#" onclick="A.appeal();return false">Appeal this decision</a>' : '');
    }
  };
  A.appeal = () => P.modal(`<h3>Appeal a suspension</h3><p class="sm muted">Confirm it is you, then tell us why the suspension should be lifted. A staff member who was not involved will review it.</p>
    <div class="field"><label>Username or email</label><input id="ap_i" value="${P.esc($('#li') ? $('#li').value : '')}"></div><div class="field"><label>Password</label><input id="ap_p" type="password"></div>
    <div class="field"><label>Your message</label><textarea id="ap_m"></textarea></div><div class="err" id="ap_e"></div><button class="btn btn-primary" id="ap_go">Send appeal</button>`, (o, close) => {
    o.querySelector('#ap_go').onclick = async () => { try { await P.api('/appeals', { body: { identifier: o.querySelector('#ap_i').value, password: o.querySelector('#ap_p').value, message: o.querySelector('#ap_m').value } }); close(); P.toast('Appeal sent. We will reply in your account once reviewed.'); } catch (e) { o.querySelector('#ap_e').textContent = e.message; } };
  });
  function register() {
    setView(`<div class="card" style="max-width:480px;margin:30px auto"><h2>Create your account</h2><p class="muted sm">You must be 18 or older. Balances in this preview are simulated.</p>
      <div class="row"><div class="field"><label>Username</label><input id="ru" autocomplete="username"></div><div class="field"><label>Display name</label><input id="rn"></div></div>
      <div class="field"><label>Email</label><input id="re" type="email" autocomplete="email"></div>
      <div class="row"><div class="field"><label>Phone (M-Pesa)</label><input id="rp" placeholder="0712 345 678" inputmode="tel"></div><div class="field"><label>Date of birth</label><input id="rd" type="date"></div></div>
      <div class="field"><label>Password</label><input id="rw" type="password" autocomplete="new-password"><div class="hint">At least 8 characters, with a letter and a number.</div></div>
      <label class="inline" style="font-weight:400"><input type="checkbox" id="rt" style="width:auto"> I am 18 or older and accept the terms and the responsible-trading policy.</label>
      <div class="err" id="re2"></div><button class="btn btn-primary btn-block" onclick="A.doReg()">Create account</button></div>`);
  }
  A.doReg = async () => {
    try { const r = await P.api('/auth/signup-login', { body: { username: $('#ru').value.trim(), display_name: $('#rn').value.trim() || undefined, email: $('#re').value.trim(), phone: $('#rp').value, date_of_birth: $('#rd').value, password: $('#rw').value, accept_terms: $('#rt').checked } });
      P.setToken(r.token); await boot(); P.toast('Welcome to Predictable. Verify your account to start trading.'); location.hash = '#/wallet'; } catch (e) { $('#re2').textContent = e.message; }
  };
  A.logout = async () => { try { await P.api('/auth/logout', { method: 'POST' }); } catch (e) {} P.setToken(null); S.me = null; S.bal = null; drawHeader(); location.hash = '#/'; };

  // ───────── wallet ─────────
  const feeBox = (q, labels) => `<div class="tlines">${line(labels[0], P.kes(q.gross))}${line(labels[1], '−' + P.kes(q.tax))}${line(labels[2], '−' + P.kes(q.fee))}${line(labels[3], P.kes(q.net), 'tot')}</div>`;
  async function wallet() {
    if (!S.me) return guard();
    loading(); const w = await P.api('/wallet'); const b = w.balances, f = fees();
    setView(`<div class="pagehead"><h1 style="margin:0">Wallet</h1><span class="badge">Simulated funds</span></div>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="statbox"><span class="xs muted">Available</span><span class="num">${P.kes(b.available_minor)}</span></div>
        <div class="statbox"><span class="xs muted">Reserved for open orders</span><span class="num">${P.kes(b.reserved_orders_minor)}</span></div>
        <div class="statbox"><span class="xs muted">Pending withdrawal</span><span class="num">${P.kes(b.pending_withdrawal_minor)}</span></div>
        <div class="statbox"><span class="xs muted">Total</span><span class="num">${P.kes(b.total_minor)}</span></div></div>
      ${S.me.kyc_status !== 'VERIFIED' ? `<div class="card notice" style="margin-bottom:16px"><b>Verify your age and identity</b> to deposit, trade or withdraw. In this preview it is simulated.<div style="margin-top:10px"><button class="btn btn-primary btn-sm" onclick="A.kyc()">Verify (simulated)</button></div></div>` : ''}
      <div class="grid g2">
        <div class="card"><h3>Add money</h3><p class="muted sm">Simulated M-Pesa deposit. A ${pctBps(f.deposit_excise_bps)} excise duty (paid to KRA) and a ${pctBps(f.deposit_fee_bps)} platform fee come off each deposit.</p>
          <div class="field"><label for="da">Amount to pay (KES)</label><input id="da" type="number" min="1" step="1" value="1000" oninput="A.quote('deposit')"></div><div id="dq"></div><button class="btn btn-primary" onclick="A.deposit()">Deposit</button></div>
        <div class="card"><h3>Withdraw</h3><p class="muted sm">A ${pctBps(f.withdrawal_wht_bps)} withholding tax and a ${pctBps(f.withdrawal_fee_bps)} fee come off each withdrawal. Funds are held until a finance officer pays out.</p>
          <div class="row"><div class="field"><label for="wa">Amount (KES)</label><input id="wa" type="number" min="10" step="1" oninput="A.quote('withdrawal')"></div><div class="field"><label for="wd">M-Pesa number</label><input id="wd" value="${P.esc(S.me.phone)}"></div></div><div id="wq"></div>
          <div class="field"><label for="wo">Confirmation code</label><div class="inline"><input id="wo" inputmode="numeric" maxlength="6" placeholder="6 digits" style="max-width:140px"><button class="btn btn-ghost btn-sm" onclick="A.sendOtp()">Send code</button></div><div class="hint">We send a one-time code to ${P.esc(S.me.phone)}. In this preview it appears in your notifications.</div></div><button class="btn btn-ghost" onclick="A.withdraw()">Request withdrawal</button></div></div>
      ${w.withdrawals.length ? `<div class="card" style="margin-top:16px"><h3>Withdrawals</h3><div class="tscroll"><table><tr><th>Reference</th><th>Amount</th><th>To</th><th>Status</th><th>Requested</th></tr>${w.withdrawals.map((x) => `<tr><td class="mono">${P.esc(x.reference)}</td><td>${P.kes(x.amount_minor)}</td><td>${P.esc(x.destination)}</td><td>${P.esc(x.status)}</td><td>${P.date(x.requested_at)}</td></tr>`).join('')}</table></div></div>` : ''}
      <div class="card" style="margin-top:16px"><h3>History</h3><div class="tscroll"><table><tr><th>When</th><th>What</th><th class="right">Cash</th><th class="right">Reserved</th></tr>
        ${w.history.map((h) => `<tr><td class="xs">${P.date(h.created_at)}</td><td>${P.esc(h.description || h.transaction_type)}</td><td class="right ${h.available_delta_minor >= 0 ? 'pos' : 'neg'}">${h.available_delta_minor ? P.kes(h.available_delta_minor) : '–'}</td><td class="right">${h.reserved_delta_minor ? P.kes(h.reserved_delta_minor) : '–'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing yet. Add money to get started.</td></tr>'}</table></div></div>`);
    A.quote('deposit');
  }
  A.quote = async (type) => {
    const inp = $(type === 'deposit' ? '#da' : '#wa'), box = $(type === 'deposit' ? '#dq' : '#wq'); if (!inp || !box) return;
    const v = parseFloat(inp.value); if (!(v > 0)) { box.innerHTML = ''; return; }
    clearTimeout(A['_q' + type]);
    A['_q' + type] = setTimeout(async () => { try { const q = await P.api(`/fees/quote?type=${type}&amount_kes=${encodeURIComponent(v)}`); const f = fees();
      box.innerHTML = type === 'deposit' ? feeBox(q, ['You pay', `KRA excise duty (${pctBps(f.deposit_excise_bps)})`, `Platform fee (${pctBps(f.deposit_fee_bps)})`, 'Credited to your wallet']) : feeBox(q, ['Taken from your wallet', `Withholding tax (${pctBps(f.withdrawal_wht_bps)})`, `Platform fee (${pctBps(f.withdrawal_fee_bps)})`, 'Sent to your M-Pesa']); } catch (e) { box.innerHTML = `<div class="err">${P.esc(e.message)}</div>`; } }, 250);
  };
  A.kyc = async () => { try { await P.api('/me/kyc/simulate', { method: 'POST' }); P.toast('Verified'); await refreshMe(); drawHeader(); route(); } catch (e) { P.fail(e); } };
  A.deposit = async () => { try { const d = await P.api('/wallet/deposit', { body: { amount_kes: $('#da').value } }); const r = await P.api(`/wallet/deposit/${d.reference}/simulate-pay`, { method: 'POST' }); P.toast(`Deposit received. ${P.kes(r.net_minor)} credited after tax and fee.`); await refreshMe(); drawHeader(); route(); } catch (e) { P.fail(e); } };
  A.sendOtp = async () => { try { await P.api('/wallet/withdraw/otp', { method: 'POST' }); P.toast('Code sent. Check your notifications.'); await refreshMe(); drawHeader(); } catch (e) { P.fail(e); } };
  A.withdraw = async () => { try { await P.api('/wallet/withdraw', { body: { amount_kes: $('#wa').value, destination: $('#wd').value, otp: $('#wo').value } }); P.toast('Withdrawal requested'); await refreshMe(); drawHeader(); route(); } catch (e) { P.fail(e); } };

  // ───────── portfolio ─────────
  const KIND = { MINT: 'New contracts', MERGE: 'Contracts retired', TRANSFER_YES: 'Yes changed hands', TRANSFER_NO: 'No changed hands', AMM_BUY_YES: 'Bought Yes (market maker)', AMM_BUY_NO: 'Bought No (market maker)', AMM_SELL_YES: 'Sold Yes (market maker)', AMM_SELL_NO: 'Sold No (market maker)' };
  async function portfolio() {
    if (!S.me) return guard();
    loading();
    const [pos, orders, trades, created] = await Promise.all([P.api('/my/positions'), P.api('/my/orders'), P.api('/my/trades'), P.api('/markets?mine=1&limit=100').catch(() => [])]);
    const live = pos.filter((p) => !['SETTLED', 'VOID'].includes(p.status)), done = pos.filter((p) => ['SETTLED', 'VOID'].includes(p.status));
    const rows = [];
    live.forEach((p) => ['yes', 'no'].forEach((k) => { if (p[k].shares > 0) rows.push({ p, k, s: p[k] }); }));
    const value = rows.reduce((s, r) => s + r.s.market_value_minor, 0), unreal = rows.reduce((s, r) => s + r.s.unrealized_minor, 0), realized = pos.reduce((s, p) => s + p.realized_pnl_minor, 0);
    const payouts = (await Promise.all(done.map((p) => P.api(`/markets/${p.market_id}/my-payout`).catch(() => [])))).flat();
    const tot = (k) => payouts.reduce((s, r) => s + Number(r[k]), 0);
    setView(`<div class="pagehead"><h1 style="margin:0">Portfolio</h1></div>
      <div class="grid g4" style="margin-bottom:16px"><div class="statbox"><span class="xs muted">Positions value</span><span class="num">${P.kes(value)}</span></div>
        <div class="statbox"><span class="xs muted">Unrealised profit and loss</span><span class="num ${unreal >= 0 ? 'pos' : 'neg'}">${P.kes(unreal)}</span></div>
        <div class="statbox"><span class="xs muted">Realised profit and loss</span><span class="num ${realized >= 0 ? 'pos' : 'neg'}">${P.kes(realized)}</span></div>
        <div class="statbox"><span class="xs muted">Reserved for open orders</span><span class="num">${P.kes(S.bal.reserved_orders_minor)}</span></div></div>
      <div class="card"><h3>Positions</h3><div class="tscroll"><table><tr><th>Market</th><th>Side</th><th class="right">Contracts</th><th class="right">Avg entry</th><th class="right">Now</th><th class="right">Value</th><th class="right">Profit / loss</th><th class="right">Net if it wins</th><th></th></tr>
        ${rows.map(({ p, k, s }) => `<tr><td><a href="#/market/${p.market_id}">${P.esc(p.title)}</a></td><td><b class="${k === 'yes' ? 'pos' : 'neg'}">${k === 'yes' ? 'Yes' : 'No'}</b></td><td class="right">${P.n(s.shares)}</td><td class="right">${P.price(s.avg_entry_kes)}</td><td class="right">${P.price(p[k + '_price_kes'])}</td><td class="right">${P.kes(s.market_value_minor)}</td><td class="right ${s.unrealized_minor >= 0 ? 'pos' : 'neg'}">${P.kes(s.unrealized_minor)}</td><td class="right">${P.kes(s.net_if_wins_minor)}</td><td>${p.status === 'OPEN' ? `<a class="btn btn-ghost btn-sm" href="#/sell/${p.market_id}/${k.toUpperCase()}">Sell</a>` : P.statusBadge(p.status)}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No open positions. Pick a market and buy Yes or No.</td></tr>'}</table></div></div>
      <div class="card" style="margin-top:16px"><h3>Open orders</h3><div class="tscroll"><table><tr><th>Market</th><th>Order</th><th class="right">Price</th><th class="right">Filled</th><th></th></tr>
        ${orders.map((o) => `<tr><td><a href="#/market/${o.market_id}">${P.esc(o.title)}</a></td><td>${o.action === 'BUY' ? 'Buy' : 'Sell'} ${o.asset === 'YES' ? 'Yes' : 'No'}</td><td class="right">${P.price(o.limit_kes)}</td><td class="right">${P.n(o.filled)} of ${P.n(o.qty)}</td><td><button class="btn btn-ghost btn-sm" onclick="A.cancel(${o.id})">Cancel</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No open orders.</td></tr>'}</table></div></div>
      <div class="grid g2" style="margin-top:16px"><div class="card"><h3>Tax and commission on settled markets</h3>${payouts.length ? `<div class="tlines">${line('Payouts (gross)', P.kes(tot('gross_minor')))}${line('Cost of contracts', '−' + P.kes(tot('cost_basis_minor')))}${line('Profit', P.kes(tot('profit_minor')))}${line(`Withholding tax (${pctBps(fees().winnings_wht_bps)} of profit)`, '−' + P.kes(tot('wht_minor')))}${line(`Commission (${pctBps(fees().profit_commission_bps)} of profit)`, '−' + P.kes(tot('commission_minor')))}${line('Paid to your wallet', P.kes(tot('net_minor')), 'tot')}</div>` : '<p class="muted sm">Nothing settled yet. Tax is taken from profit only, when a market settles or you sell at a profit.</p>'}
          <p class="hint">Deposit and withdrawal taxes and fees are listed in your <a href="#/wallet">wallet history</a>.</p></div>
        <div class="card"><h3>Markets you proposed</h3>${created.filter((m) => m.creator_id === S.me.id).map((m) => `<div class="oline" style="padding:8px 0;border-bottom:1px solid var(--line)"><a class="nm" href="#/market/${m.id}">${P.esc(m.title)}</a>${P.statusBadge(m.status)}</div>`).join('') || '<p class="muted sm">You have not proposed any markets. <a href="#/create">Propose one</a>.</p>'}</div></div>
      <div class="card" style="margin-top:16px"><h3>Trade history</h3><div class="tscroll"><table><tr><th>When</th><th>Market</th><th>What</th><th class="right">Price of Yes</th><th class="right">Contracts</th><th class="right">Amount</th></tr>
        ${trades.map((t) => `<tr><td class="xs">${P.date(t.created_at)}</td><td><a href="#/market/${t.market_id}">${P.esc(t.title)}</a></td><td class="xs">${P.esc(KIND[t.kind] || t.kind)} · you ${t.my_side === 'BID' ? 'bid' : 'asked'}</td><td class="right">${P.price(t.price_kes)}</td><td class="right">${P.n(t.qty)}</td><td class="right">${P.kes(t.amount_minor)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No trades yet.</td></tr>'}</table></div></div>`);
  }

  // ───────── propose a market ─────────
  const CF = {};
  function create() {
    if (!S.me) return guard();
    const local = (dt) => new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const d = Object.assign({ price: 50, closes: local(new Date(Date.now() + 48 * 3600e3)), event: local(new Date(Date.now() + 49 * 3600e3)) }, CF);
    setView(`<div style="max-width:680px;margin:0 auto"><h1>Propose a market</h1><p class="muted">Ask a question with a clear Yes or No answer. A different staff member reviews every proposal before it opens, and you can't trade your own market.</p>
      <div class="card" id="cform">
        <div class="field"><label for="c_title">Question</label><input id="c_title" value="${P.esc(d.title || '')}" placeholder="Will Kenya win its next international football match?" oninput="A.live()"><div class="hint">Be specific: names, numbers and dates that anyone can check. It must be answerable with Yes or No.</div><div id="live" class="sm"></div></div>
        <div class="field"><label for="c_desc">Details (optional)</label><textarea id="c_desc">${P.esc(d.description || '')}</textarea></div>
        <div class="row"><div class="field"><label for="c_cat">Category</label><select id="c_cat">${S.cats.map((c) => `<option value="${P.esc(c.slug)}" ${d.cat === c.slug ? 'selected' : ''}>${P.esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="c_price">Your opening estimate of Yes (1–99)</label><input id="c_price" type="number" min="1" max="99" step="1" value="${d.price}" oninput="A.est()"><div class="hint" id="c_est"></div></div></div>
        <div class="row"><div class="field"><label for="c_close">Trading closes</label><input id="c_close" type="datetime-local" value="${P.esc(d.closes)}"></div><div class="field"><label for="c_event">Event time</label><input id="c_event" type="datetime-local" value="${P.esc(d.event)}"></div></div>
        <div class="field"><label for="c_src">Resolution source</label><input id="c_src" value="${P.esc(d.src || '')}" placeholder="Football Kenya Federation official match report"><div class="hint">An official, public source anyone can check.</div></div>
        <div class="field"><label for="c_meth">How the result is read</label><textarea id="c_meth" placeholder="Score at full time, excluding extra time and penalties.">${P.esc(d.meth || '')}</textarea></div>
        <div id="c_err"></div>
        <div class="inline"><button class="btn btn-primary" id="c_go" onclick="A.csubmit()">Submit for review</button><span class="xs muted">Status after submitting: <b>in review</b>.</span></div></div></div>`);
    A.est(); A.live();
  }
  A.est = () => { const v = parseInt($('#c_price').value, 10), el = $('#c_est'); if (!el) return; el.textContent = v >= 1 && v <= 99 ? `Opens at Yes KES ${v} · No KES ${100 - v}. Staff may fund a market maker that quotes around this estimate.` : 'Enter a whole number from 1 to 99.'; };
  A.live = () => {
    const t = $('#c_title').value; if (t.length < 8) { $('#live').innerHTML = ''; return; }
    clearTimeout(A._lt); A._lt = setTimeout(async () => { try { const r = await P.api('/ai/validate', { body: { title: t, outcomes: ['Yes', 'No'], resolution_source: 'x', resolution_method: 'x' } });
      const s = r.issues.filter((i) => !['NO_SOURCE', 'NO_METHOD', 'WEAK_SOURCE'].includes(i.code)); const el = $('#live'); if (el) el.innerHTML = s.map((i) => `<div class="issue"><span class="tg sev-${P.esc(i.severity)}">${P.esc(i.severity)}</span><span>${P.esc(i.message)}</span></div>`).join(''); } catch (e) {} }, 350);
  };
  A.csubmit = async () => {
    const g = (id) => $('#' + id).value, err = $('#c_err'); err.innerHTML = '';
    Object.assign(CF, { title: g('c_title'), description: g('c_desc'), cat: g('c_cat'), price: g('c_price'), closes: g('c_close'), event: g('c_event'), src: g('c_src'), meth: g('c_meth') });
    const bad = (t) => { err.innerHTML = `<div class="err">${P.esc(t)}</div>`; };
    const price = parseInt(CF.price, 10);
    if (CF.title.trim().length < 12) return bad('Write the question in at least 12 characters.');
    if (!(price >= 1 && price <= 99)) return bad('The opening estimate must be a whole number from 1 to 99.');
    if (!CF.closes || !CF.event) return bad('Choose when trading closes and when the event happens.');
    if (new Date(CF.closes) <= new Date()) return bad('Trading must close in the future.');
    if (new Date(CF.event) < new Date(CF.closes)) return bad('The event cannot start before trading closes.');
    if (!CF.src.trim() || !CF.meth.trim()) return bad('Name the official source and explain how the result is read.');
    $('#c_go').disabled = true;
    try {
      const r = await P.api('/markets', { body: { title: CF.title.trim(), description: CF.description, category_slug: CF.cat, initial_price_kes: price, closes_at: new Date(CF.closes).toISOString(), event_at: new Date(CF.event).toISOString(), resolution_source: CF.src.trim(), resolution_method: CF.meth.trim() } });
      Object.keys(CF).forEach((k) => delete CF[k]); P.toast('Submitted. Your market is in review.'); location.hash = '#/market/' + r.id;
    } catch (e) {
      $('#c_go').disabled = false;
      err.innerHTML = e.status === 403 ? `<div class="notice"><b>You can't propose markets yet.</b><br>${P.esc(e.message)}<br><span class="xs">Markets are proposed by staff and approved creators. Ask the Predictable team to approve your account as a market creator.</span></div>` : `<div class="err">${P.esc(e.message)}</div>`;
    }
  };

  // ───────── misc pages ─────────
  async function notifications() {
    if (!S.me) return guard(); loading(); const n = await P.api('/notifications'); await P.api('/notifications/read', { method: 'POST' }); S.unread = 0; drawHeader();
    setView(`<h1>Notifications</h1><div class="card">${n.items.map((x) => `<div style="padding:12px 0;border-bottom:1px solid var(--line)"><b>${P.esc(x.title)}</b>${!x.read_at ? ' <span class="badge b-set">new</span>' : ''}<div class="sm muted">${P.esc(x.body || '')}</div><div class="xs muted">${P.date(x.created_at)}</div></div>`).join('') || '<div class="empty">Nothing yet.</div>'}</div>`);
  }
  async function profile() {
    if (!S.me) return guard(); loading(); const l = await P.api('/me/limits');
    setView(`<div style="max-width:620px"><h1>Limits and safety</h1><div class="card stack">
      <div><h3>Daily deposit limit</h3><p class="muted sm">You can lower a limit at any time. Raising or removing it is blocked in this release.</p>
        <div class="inline"><input id="lim" type="number" min="0" placeholder="No limit" value="${l.daily_deposit_limit_minor != null ? l.daily_deposit_limit_minor / 100 : ''}" style="max-width:200px"><button class="btn btn-primary btn-sm" onclick="A.saveLimit()">Save limit</button></div></div>
      <hr class="divider"><div><h3>Take a break</h3><p class="muted sm">Self-exclusion blocks deposits and trading. It can be extended but not shortened.</p>
        ${l.self_excluded_until && new Date(l.self_excluded_until) > new Date() ? `<div class="notice">Excluded until ${P.date(l.self_excluded_until)}</div>` : ''}
        <div class="inline"><select id="exd" style="max-width:200px">${[1, 7, 30, 90, 180, 365].map((d) => `<option value="${d}">${d} day${d > 1 ? 's' : ''}</option>`).join('')}</select><button class="btn btn-ghost btn-sm" onclick="A.exclude()">Start break</button></div></div></div></div>`);
  }
  A.saveLimit = async () => { try { await P.api('/me/limits', { method: 'PUT', body: { daily_deposit_limit_kes: $('#lim').value } }); P.toast('Limit saved'); } catch (e) { P.fail(e); } };
  A.exclude = async () => { if (!confirm('Start your break? You will not be able to deposit or trade until it ends.')) return; try { await P.api('/me/limits', { method: 'PUT', body: { self_exclude_days: $('#exd').value } }); P.toast('Break started'); route(); } catch (e) { P.fail(e); } };
  async function leaderboard() {
    loading(); const r = await P.api('/leaderboard');
    setView(`<h1>Leaderboard</h1><div class="card"><div class="tscroll"><table><tr><th>#</th><th>Trader</th><th class="right">Profitable markets</th><th class="right">Realised profit and loss</th></tr>${r.map((x, i) => `<tr><td>${i + 1}</td><td>${P.esc(x.display_name)}</td><td class="right">${x.wins} / ${x.settled}</td><td class="right ${x.net_minor >= 0 ? 'pos' : 'neg'}">${P.kes(x.net_minor)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">The leaderboard fills as markets settle.</td></tr>'}</table></div></div>`);
  }
  function how() {
    const f = fees(), w = ifWins(40 * 10 * 100, 10), dep = 1000;
    setView(`<div style="max-width:780px"><h1>How Predictable works</h1>
      <div class="grid g2" style="margin:18px 0">
        <div class="card"><h3>1. Every market is Yes or No</h3><p class="muted">A Yes contract and a No contract each pay <b>KES 100</b> if they turn out right and KES 0 if not. Yes and No prices always add to KES 100, so a Yes price of KES 62 means the market sees about a 62% chance.</p></div>
        <div class="card"><h3>2. Buy and sell any time</h3><p class="muted">Pick a price from KES 1 to 99. Your order matches instantly against the best price on offer, or waits on the order book until someone takes it. You do not need to hold until the event: sell whenever you like while trading is open.</p></div>
        <div class="card"><h3>3. Where prices come from</h3><p class="muted">Traders' own orders set the price. Staff may also fund a market maker that always quotes both sides so you can trade at once. The market maker uses platform money and can lose it. It never uses your balance.</p></div>
        <div class="card"><h3>4. Your money is held safe</h3><p class="muted">Every shilling backing a contract is held in escrow until the market settles, and the platform checks that escrow equals KES 100 for every pair of Yes and No contracts. Every movement is a ledger record that is never edited, only reversed.</p></div></div>
      <h2>Taxes and fees</h2><div class="card"><table><tr><th>When</th><th>What is taken</th></tr>
        <tr><td>You deposit</td><td>${pctBps(f.deposit_excise_bps)} excise duty (paid to KRA) + ${pctBps(f.deposit_fee_bps)} platform fee. Deposit KES 1,000 and KES ${(dep * (10000 - f.deposit_excise_bps - f.deposit_fee_bps)) / 10000} reaches your wallet.</td></tr>
        <tr><td>A contract wins</td><td>${pctBps(f.winnings_wht_bps)} withholding tax + ${pctBps(f.profit_commission_bps)} platform commission, on your <b>profit only</b> (payout minus what you paid).</td></tr>
        <tr><td>You sell at a profit</td><td>${f.tax_on_exit_sales ? 'The same tax and commission, on the profit only. A sale at a loss pays none.' : 'Nothing in this release. Whether tax applies to early sales is still being confirmed.'}</td></tr>
        <tr><td>You withdraw</td><td>${pctBps(f.withdrawal_wht_bps)} withholding tax + ${pctBps(f.withdrawal_fee_bps)} platform fee.</td></tr></table></div>
      <h2 style="margin-top:22px">A worked example</h2><div class="card"><p class="muted" style="margin-top:0">You buy 10 Yes contracts at KES 40 each and Yes wins.</p><div class="tlines">${line('Paid when you bought (10 × KES 40)', P.kes(w.payout - w.profit))}${line('Payout (10 × KES 100)', P.kes(w.payout))}${line('Profit', P.kes(w.profit))}${line(`Withholding tax (${pctBps(f.winnings_wht_bps)} of profit)`, '−' + P.kes(w.wht))}${line(`Commission (${pctBps(f.profit_commission_bps)} of profit)`, '−' + P.kes(w.comm))}${line('You receive', P.kes(w.net), 'tot')}</div></div>
      <h2 style="margin-top:22px">From question to payout</h2><ol class="stack" style="padding-left:1.2em"><li>Staff and approved creators propose a market. A different reviewer checks the wording and the source before it opens.</li><li>Trading closes at the deadline. If the event is cancelled, every contract is redeemed at its last traded price with no tax.</li><li>A settlement officer checks the official source and proposes the result with evidence. Large settlements need a second officer.</li><li>Winning contracts pay KES 100 less tax and commission on profit. You then have a dispute window to challenge the result.</li></ol>
      <div class="card notice" style="margin-top:22px"><b>Simulated funds.</b> No real money is accepted or paid out until Predictable is licensed by the Gambling Regulatory Authority (GRA) under the Gambling Control Act, 2025.</div></div>`);
  }
  function guard() { setView(`<div class="card" style="max-width:420px;margin:30px auto;text-align:center"><h3>Log in to continue</h3><a class="btn btn-primary" href="#/login">Log in</a> <a class="btn btn-ghost" href="#/register">Sign up</a></div>`); }

  // ───────── router ─────────
  async function route() {
    const [path, qs] = (location.hash.slice(1) || '/').split('?'); const params = new URLSearchParams(qs || '');
    drawNav(path, params);
    try {
      let m;
      if (path === '/' || path === '') await home(params);
      else if ((m = path.match(/^\/market\/(\d+)/))) await market(+m[1]);
      else if ((m = path.match(/^\/sell\/(\d+)\/(YES|NO)$/))) { T.pendingSell = m[2]; location.replace('#/market/' + m[1]); }
      else if (path === '/login') login();
      else if (path === '/register') register();
      else if (path === '/wallet') await wallet();
      else if (path === '/portfolio') await portfolio();
      else if (path === '/create') create();
      else if (path === '/notifications') await notifications();
      else if (path === '/profile') await profile();
      else if (path === '/security') { if (!S.me) guard(); else { setView('<div style="max-width:680px"><h1>Account security</h1><div id="secbox"></div></div>'); await SecUI.render($('#secbox'), { staff: S.me.permissions.includes('admin.dashboard') }); } }
      else if (path === '/leaderboard') await leaderboard();
      else if (path === '/how') how();
      else setView('<div class="empty"><h3>Page not found</h3><a href="#/">Back to markets</a></div>');
    } catch (e) { setView(`<div class="card notice" style="max-width:560px;margin:20px auto"><h3>${e.status === 404 ? 'Not found' : 'Something went wrong'}</h3><p>${P.esc(e.message)}</p><a class="btn btn-ghost" href="#/">Back to markets</a></div>`); }
  }
  async function boot() { await refreshMe(); drawHeader(); }
  window.addEventListener('hashchange', route);
  (async () => {
    try { [S.cats, S.cfg] = await Promise.all([P.api('/categories'), P.api('/config')]); } catch (e) {}
    await boot(); route();
    setInterval(async () => { if (S.me) { await refreshMe(); drawHeader(); } }, 30000);
  })();
})();
