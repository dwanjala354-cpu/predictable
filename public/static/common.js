/* Shared helpers for the market app and the admin console. */
(function () {
  const TOKEN_KEY = 'predictable_token', THEME_KEY = 'predictable_theme';
  const P = (window.P = {});
  P.token = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
  P.setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} };
  P.theme = () => { try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; } };
  P.applyTheme = (t) => { if (t) document.documentElement.setAttribute('data-theme', t); try { t ? localStorage.setItem(THEME_KEY, t) : localStorage.removeItem(THEME_KEY); } catch (e) {} };
  P.toggleTheme = () => {
    const cur = document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    P.applyTheme(cur === 'dark' ? 'light' : 'dark');
  };
  if (P.theme()) document.documentElement.setAttribute('data-theme', P.theme());

  P.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  P.api = async (path, opts = {}) => {
    const res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(P.token() ? { Authorization: 'Bearer ' + P.token() } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || 'Request failed');
      err.code = data && data.error && data.error.code; err.status = res.status; err.data = data && data.error; throw err;
    }
    return data;
  };

  // Money is integer minor units on the wire.
  P.kes = (m) => { const neg = m < 0 ? '-' : ''; const a = Math.abs(m); const w = Math.floor(a / 100).toLocaleString('en-KE'); const f = String(a % 100).padStart(2, '0'); return `${neg}KES ${w}${f === '00' ? '' : '.' + f}`; };
  P.kesShort = (m) => { const v = m / 100; if (v >= 1e6) return `KES ${(v / 1e6).toFixed(1)}M`; if (v >= 1e3) return `KES ${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}K`; return `KES ${Math.round(v)}`; };
  // Contract prices are whole KES 1-99 (the AMM quote can carry 2 d.p.). A price is also the market's chance, in percent.
  P.price = (k) => (k == null ? '–' : 'KES ' + (Math.round(k * 100) % 100 ? Number(k).toFixed(2) : Math.round(k)));
  P.pc = (k) => (k == null ? '–' : Math.round(k) + '%');
  P.n = (x) => Number(x || 0).toLocaleString('en-KE');
  P.date = (d) => d ? new Date(d).toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  P.left = (d) => {
    const ms = new Date(d) - Date.now(); if (ms <= 0) return 'Closed';
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60), dd = Math.floor(h / 24);
    return dd >= 1 ? `${dd}d ${h % 24}h left` : h >= 1 ? `${h}h ${m % 60}m left` : `${m}m left`;
  };
  P.statusBadge = (s) => {
    const cls = s === 'OPEN' ? 'b-open' : ['LOCKED', 'EVENT_PENDING', 'RESULT_PENDING', 'SUSPENDED', 'PENDING_REVIEW', 'DISPUTED'].includes(s) ? 'b-lock' : ['VOID', 'REJECTED', 'CANCELLED'].includes(s) ? 'b-void' : s === 'SETTLED' ? 'b-set' : '';
    return `<span class="badge ${cls}">${P.esc(s === 'PENDING_REVIEW' ? 'In review' : s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()))}</span>`;
  };
  const ICON_BG = { sports: '#1677E8', politics: '#7A4FD6', entertainment: '#D6409F', economy: '#16934A', weather: '#0E9AA7', community: '#E0742B' };
  P.icon = (m) => `<div class="mico" style="background:${ICON_BG[m.category_slug] || '#1677E8'}" aria-hidden="true">${P.esc((m.category_name || '?')[0])}</div>`;

  P.toast = (msg, bad) => {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast' + (bad ? ' bad' : ''); t.setAttribute('role', bad ? 'alert' : 'status'); t.textContent = msg;
    box.appendChild(t); setTimeout(() => t.remove(), bad ? 6500 : 3800);
  };
  P.fail = (e) => P.toast(e.message || 'Something went wrong', true);
  P.modal = (html, onMount) => {
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    const close = () => o.remove();
    o.addEventListener('click', (e) => { if (e.target === o) close(); });
    o.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.appendChild(o);
    const first = o.querySelector('input,select,textarea,button'); if (first) first.focus();
    if (onMount) onMount(o, close);
    return close;
  };
  // Asks for a 6-digit authenticator code; resolves with the code or null if cancelled.
  P.askCode = (title, hint) => new Promise((res) => {
    let done = false; const fin = (v, close) => { if (!done) { done = true; close(); res(v); } };
    P.modal(`<h3>${P.esc(title)}</h3><p class="sm muted">${P.esc(hint || 'Enter the 6-digit code from your authenticator app.')}</p>
      <div class="field"><label for="ac_c">Authenticator code</label><input id="ac_c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="letter-spacing:.3em;font-size:20px;text-align:center"></div>
      <div class="inline"><button class="btn btn-primary" id="ac_ok">Confirm</button><button class="btn btn-ghost" id="ac_no">Cancel</button></div>`, (o, close) => {
      const inp = o.querySelector('#ac_c'); const ok = () => fin(inp.value.replace(/\s/g, ''), close);
      o.querySelector('#ac_ok').onclick = ok; o.querySelector('#ac_no').onclick = () => fin(null, close);
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      new MutationObserver(() => { if (!document.body.contains(o)) fin(null, close); }).observe(document.body, { childList: true });
    });
  });
  P.logoSvg = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#1677E8"/><path d="M8 21 L13 15 L17 18 L24 9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="24" cy="9" r="3" fill="#A6F04B"/></svg>';
})();
