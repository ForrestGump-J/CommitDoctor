(function () {
  'use strict';

  var BASE = '/api';
  var KEY = 'comdoc.adminToken';

  var PROBE = { method: 'POST', path: '/admin/ping' };

  function emitAuth() {
    try { window.dispatchEvent(new CustomEvent('comdoc:auth')); } catch (e) {}
  }
  var tokenStore = {
    get: function () { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    set: function (t) { try { sessionStorage.setItem(KEY, String(t)); } catch (e) {} emitAuth(); },
    clear: function () { try { sessionStorage.removeItem(KEY); } catch (e) {} emitAuth(); }
  };

  function classify(r) {
    if (r.network)               { r.kind = 'network';      r.message = 'Cannot reach the server. Check your connection.'; }
    else if (r.status >= 500)    { r.kind = 'server';       r.message = 'Server error (' + r.status + '). Try again shortly.'; }
    else if (r.unauthorized)     { r.kind = 'unauthorized'; r.message = 'Admin token required.'; }
    else if (!r.ok)              { r.kind = 'client';       r.message = r.error; }
    else                         { r.kind = 'ok';           r.message = ''; }
    return r;
  }

  function request(path, o) {
    o = o || {};
    if (path.charAt(0) !== '/') path = '/' + path;
    var h = { Accept: 'application/json' };
    var t = o.skipAuth ? '' : tokenStore.get();
    if (t) h.Authorization = 'Bearer ' + t;
    var body;
    if (o.body !== undefined) {
      h['Content-Type'] = 'application/json';
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    }
    if (o.headers) Object.keys(o.headers).forEach(function (k) { h[k] = o.headers[k]; });

    return fetch(BASE + path, {
      method: o.method || 'GET', headers: h, body: body,
      credentials: 'same-origin', signal: o.signal
    }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
        var err = null;
        if (!r.ok) {
          err = (data && typeof data === 'object' && (data.error || data.message)) ||
                r.statusText || ('HTTP ' + r.status);
          if (typeof err !== 'string') err = String(err.message || 'HTTP ' + r.status);
        }
        return classify({ ok: r.ok, status: r.status, data: data, error: err,
                          unauthorized: r.status === 401, network: false });
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw e;
      return classify({ ok: false, status: 0, data: null, error: 'Network error',
                        unauthorized: false, network: true });
    });
  }

  var lockState = null, probing = null;
  function probeLock(force) {
    if (!force && lockState) return Promise.resolve(lockState);
    if (probing) return probing;
    probing = request(PROBE.path, { method: PROBE.method, body: {}, skipAuth: true })
      .then(function (r) {
        lockState = r.status === 401 ? 'locked'
                  : (r.status === 400 || (r.status >= 200 && r.status < 300)) ? 'open'
                  : 'unknown'; // 404/5xx/network: check PROBE.path
        emitAuth(); 
        return lockState;
      })
      .then(function (s) { probing = null; return s; });
    return probing;
  }

  var dlg = null, pending = null, resolver = null, result = null;

  function build() {
    var st = document.createElement('style');
    st.textContent = '#cd-admin-token-dialog .cd-err{color:var(--coral,#F87171);font-size:12px;margin:0 0 8px}';
    document.head.appendChild(st);

    dlg = document.createElement('dialog');
    dlg.id = 'cd-admin-token-dialog';
    dlg.setAttribute('aria-labelledby', 'cd-admin-token-title');
    dlg.innerHTML =
      '<form id="cd-admin-token-form" autocomplete="off" novalidate>' +
        '<h2 id="cd-admin-token-title">Admin token</h2>' +
        '<p class="sub">Enter the admin token to continue. It is kept for this tab only.</p>' +
        '<div class="field">' +
          '<label for="cd-admin-token-input">Token</label>' +
          '<input id="cd-admin-token-input" type="password" autocomplete="off" spellcheck="false" required>' +
        '</div>' +
        '<p id="cd-admin-token-error" class="cd-err" role="alert" hidden></p>' +
        '<div class="dialog-actions">' +
          '<button type="button" class="btn" id="cd-admin-token-cancel">Cancel</button>' +
          '<button type="submit" class="btn btn-primary" id="cd-admin-token-save">Save token</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(dlg);

    var input = dlg.querySelector('#cd-admin-token-input');
    var err = dlg.querySelector('#cd-admin-token-error');

    dlg.querySelector('#cd-admin-token-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      if (!v) { err.textContent = 'Enter a token.'; err.hidden = false; input.focus(); return; }
      tokenStore.set(v);
      result = v;
      dlg.close();
    });
    dlg.querySelector('#cd-admin-token-cancel').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('close', function () {
      input.value = '';
      var r = resolver, v = result;
      resolver = pending = result = null;
      if (r) r(v);
    });
  }

  function promptToken(opts) {
    if (pending) return pending;
    if (!dlg) build();
    var err = dlg.querySelector('#cd-admin-token-error');
    var msg = opts && opts.message;
    err.textContent = msg || '';
    err.hidden = !msg;
    pending = new Promise(function (res) { resolver = res; });
    dlg.showModal();
    dlg.querySelector('#cd-admin-token-input').focus();
    return pending;
  }

  function mark(r, kind, msg) { r.ok = false; r.kind = kind; r.message = msg; return r; }
  function report(r) {
    if (r.kind === 'network' || r.kind === 'server' || r.kind === 'wrong_token') {
      var h = window.ComDocApi && window.ComDocApi.onError;
      if (typeof h === 'function') { try { h(r); } catch (e) {} }
    }
    return r;
  }
  function api(path, o) {
    return request(path, o).then(function (r) {
      if (!r.unauthorized) return report(r);
      // No ADMIN_TOKEN on the server: only the server machine may make changes, so a
      // token can't help. Show the server's explanation instead of asking for one.
      if (/^No ADMIN_TOKEN/.test(r.error || '')) return mark(r, 'client', r.error);
      lockState = 'locked'; emitAuth();                       // a 401 proves the backend is locked
      return promptToken({ message: 'Token rejected.' }).then(function (t) {
        if (t === null) { tokenStore.clear(); return mark(r, 'cancelled', 'Cancelled.'); }
        return request(path, o).then(function (r2) {          // retry exactly once
          if (!r2.unauthorized) return report(r2);
          tokenStore.clear();
          return report(mark(r2, 'wrong_token', 'Wrong admin token.'));
        });
      });
    });
  }

  function getAuthState() {
    if (lockState === 'open') return 'open';
    if (lockState === 'locked') return tokenStore.get() ? 'unlocked' : 'locked';
    return 'unknown';
  }
  window.ComDocApi = {
    BASE: BASE,
    token: tokenStore,
    request: request,        // raw, no auth flow
    api: api,                // use this from app.js
    probeLock: probeLock,
    getLockState: function () { return lockState; },
    getAuthState: getAuthState,
    promptToken: promptToken,
    onError: null            // optional: fn(result) for network/server/wrong_token
  };
})();