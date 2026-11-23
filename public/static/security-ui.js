/* Shared account-security panel (two-step verification, sessions, password). Used by the player app and the staff console. */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const S = (window.SecUI = {});
  let host = null, opts = {};
  S.render = async (el, o) => {
    host = el; opts = o || {};
    host.innerHTML = '<div class="empty">Loading…</div>';
    const [me, sessions] = await Promise.all([P.api('/me'), P.api('/me/sessions')]);
    const on = me.user.mfa_enabled;
    host.innerHTML = `
      <div class="card" style="margin-bottom:16px"><div class="spread"><h3 style="margin:0">Two-step verification</h3><span class="badge ${on ? 'b-open' : 'b-lock'}">${on ? 'On' : 'Off'}</span></div>
        <p class="sm muted" style="margin:8px 0 12px">${on ? 'Your account asks for a code from your authenticator app when you sign in.' : opts.staff ? 'Staff accounts must turn this on before using the console.' : 'Add a second step to sign-in. Use any authenticator app, such as Google Authenticator or Authy.'}</p>
        <div id="mfa_area">${on ? (opts.staff ? '<p class="xs muted">Staff accounts cannot turn this off.</p>' : '<button class="btn btn-ghost btn-sm" id="mfa_off">Turn off</button>') : '<button class="btn btn-primary btn-sm" id="mfa_on">Turn on</button>'}</div></div>
      <div class="card" style="margin-bottom:16px"><h3 style="margin-top:0">Where you are signed in</h3>
        <div class="tscroll"><table><tr><th>Device</th><th>Network</th><th>Last active</th><th></th></tr>${sessions.map((s) => `<tr><td class="xs">${P.esc((s.user_agent || 'Unknown').slice(0, 60))}${s.current ? ' <span class="badge b-open">This device</span>' : ''}</td><td class="mono xs">${P.esc(s.ip || '–')}</td><td class="xs">${P.date(s.last_seen || s.created_at)}</td><td>${s.current ? '' : `<button class="btn btn-ghost btn-sm" data-rev="${s.id}">Sign out</button>`}</td></tr>`).join('')}</table></div></div>
      <div class="card"><h3 style="margin-top:0">Change password</h3>
        <div class="row"><div class="field"><label for="pw_c">Current password</label><input id="pw_c" type="password" autocomplete="current-password"></div><div class="field"><label for="pw_n">New password</label><input id="pw_n" type="password" autocomplete="new-password"><div class="hint">At least 8 characters with a letter and a number. Changing it signs out your other devices.</div></div></div>
        <div class="err" id="pw_e"></div><button class="btn btn-primary btn-sm" id="pw_go">Change password</button></div>`;
    host.querySelectorAll('[data-rev]').forEach((b) => (b.onclick = async () => { try { await P.api('/me/sessions/' + b.dataset.rev, { method: 'DELETE' }); S.render(host, opts); } catch (e) { P.fail(e); } }));
    const onBtn = $('#mfa_on', host), offBtn = $('#mfa_off', host);
    if (onBtn) onBtn.onclick = async () => {
      try {
        const r = await P.api('/me/mfa/setup', { method: 'POST' });
        $('#mfa_area', host).innerHTML = `<div class="inline" style="align-items:flex-start;gap:18px;flex-wrap:wrap"><div style="background:#fff;padding:6px;border-radius:8px;line-height:0">${r.qr_svg}</div>
          <div style="flex:1;min-width:220px"><p class="sm">1. Scan the code with your authenticator app, or type this key in: <b class="mono">${P.esc(r.secret)}</b></p><p class="sm">2. Enter the 6-digit code it shows.</p>
          <div class="field"><input id="mfa_code" inputmode="numeric" maxlength="6" placeholder="123456" style="max-width:160px"></div><div class="err" id="mfa_e"></div><button class="btn btn-primary btn-sm" id="mfa_go">Turn on</button></div></div>`;
        $('#mfa_go', host).onclick = async () => { try { await P.api('/me/mfa/enable', { body: { code: $('#mfa_code', host).value } }); P.toast('Two-step verification is on'); S.render(host, opts); if (opts.onChange) opts.onChange(); } catch (e) { $('#mfa_e', host).textContent = e.message; } };
      } catch (e) { P.fail(e); }
    };
    if (offBtn) offBtn.onclick = async () => { const code = await P.askCode('Turn off two-step verification', 'Confirm with a current code from your authenticator app.'); if (!code) return; try { await P.api('/me/mfa/disable', { body: { code } }); P.toast('Two-step verification is off'); S.render(host, opts); } catch (e) { P.fail(e); } };
    $('#pw_go', host).onclick = async () => { try { await P.api('/me/password', { body: { current: $('#pw_c', host).value, next: $('#pw_n', host).value } }); P.toast('Password changed'); S.render(host, opts); } catch (e) { $('#pw_e', host).textContent = e.message; } };
  };
})();
