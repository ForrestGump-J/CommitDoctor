(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // NLP commit-intent label from src/intent.js; low-confidence guesses get a "?".
  function intentTag(it) {
    if (!it) return '';
    const title = `Commit intent (guessed from the message): ${it.intent}, ${Math.round(it.confidence * 100)}% confidence`;
    return `<span class="tag intent intent-${esc(it.intent)}${it.sure ? '' : ' unsure'}" title="${esc(title)}">${esc(it.intent)}${it.sure ? '' : '?'}</span>`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const VIEWS = ['digest', 'team', 'timeline'];

  const state = {
    overview: null, repository: null, trend: [], summary: null, commits: [], flags: [], contributors: [],
    prediction: null, subscribers: [], date: null, token: null, drawn: false, key: '',
    hookSecret: null, form: { open: false, step: 1, repo: '', private: false, method: null }, view: 'digest',
  };

  // --- small storage helpers (per-browser conveniences only) ---------------------
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  // --- helpers ---------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await fetch(path, { method: opts.method || 'GET', headers, body, keepalive: Boolean(opts.keepalive) });
    const resBody = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(resBody.error || resBody.reason || res.statusText);
      err.status = res.status;
      err.body = resBody;
      throw err;
    }
    return resBody;
  }
  const errText = (err) => (err.body && err.body.error ? err.body.error : err.message);

  /** Run fn; if the server wants an admin token, ask once and retry. */
  async function withAdmin(fn, what) {
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 401) throw err;
      const t = window.prompt(`This server needs an admin token to ${what}. Enter it:`);
      if (!t) throw err;
      state.token = t;
      return fn();
    }
  }

  const utcNoon = (d) => new Date(`${d}T12:00:00Z`);
  const shift = (d, n) => {
    const t = new Date(`${d}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const dayLong = (d) => {
    const sameYear = d.slice(0, 4) === state.overview.today.slice(0, 4);
    return utcNoon(d).toLocaleDateString('en-US', {
      timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    });
  };
  const dayMed = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const dayShort = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const stamp = (iso) =>
    new Date(iso).toLocaleString('en-GB', {
      timeZone: state.overview.timezone, day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr ago`;
    return `${plural(Math.floor(h / 24), 'day')} ago`;
  };
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  const isLocal = () => /^(localhost|127\.|\[::1\])/.test(window.location.hostname);

  // --- header status -----------------------------------------------------------------
  function renderStatus() {
    const r = state.repository;
    let s = 'idle';
    let t = 'No repository connected';
    if (r && r.repo) {
      if (r.method === 'poll') {
        if (r.poll.last_error) { s = 'warn'; t = 'Could not reach GitHub on the last check'; }
        else if (r.poll.last_polled_at) { s = 'ok'; t = `Checked GitHub ${ago(r.poll.last_polled_at)}`; }
        else t = 'Waiting for the first check';
      } else if (r.webhook.state === 'failing' || r.webhook.state === 'other_repo') {
        s = 'warn'; t = 'GitHub deliveries are being rejected';
      } else if (state.overview.last_push_at) {
        s = 'ok'; t = `Last push ${ago(state.overview.last_push_at)}`;
      } else if (r.webhook.state === 'connected') {
        s = 'ok'; t = 'Connected; waiting for the first push';
      } else {
        t = 'Waiting for GitHub';
      }
    }
    $('#status').dataset.state = s;
    $('#status-text').textContent = t;
  }

  // --- repository card ---------------------------------------------------------------
  // Accept "owner/name" or anything pasted from GitHub (https://github.com/owner/name(.git)/...).
  const parseRepo = (v) => {
    const m = v.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
  };
  // Private repos, and servers GitHub can't reach, use polling; public repos on a public server use the webhook.
  const recommendedMethod = (isPrivate) => (isPrivate || isLocal() ? 'poll' : 'webhook');
  const payloadUrlDefault = () => (isLocal() ? '' : `${window.location.origin}/webhook/github`);
  const PAYLOAD_KEY = 'commitdoctor.payloadUrl';

  function renderRepoCard() {
    const r = state.repository;
    const connected = Boolean(r && r.repo);
    const showForm = !connected || state.form.open;
    $('#repo-connected').hidden = showForm;
    $('#repo-form').hidden = !showForm;
    if (showForm) renderRepoForm(connected);
    else renderConnected(r);
  }

  function renderConnected(r) {
    const repoLink = `<a href="https://github.com/${esc(r.repo)}" target="_blank" rel="noopener"><strong>${esc(r.repo)}</strong></a>`;
    let tone = 'ok';
    let text;
    if (r.method === 'poll') {
      const p = r.poll;
      if (p.last_error) {
        tone = 'bad';
        text = `Connected to ${repoLink}, but the last check failed: ${esc(p.last_error)} <button type="button" class="text-btn" id="repo-retoken-btn">Use a new token</button>`;
      } else {
        text = `Connected to ${repoLink} · checks for new commits every ${plural(p.interval_minutes, 'minute')}${p.last_polled_at ? ` · last checked ${esc(ago(p.last_polled_at))}` : ''}`;
      }
    } else {
      const w = r.webhook;
      if (w.state === 'connected') {
        text = `Connected to ${repoLink} · updates instantly when someone pushes${w.last_ok_event === 'push' ? ` · last push ${esc(ago(w.last_ok_at))}` : ''}`;
      } else if (w.state === 'failing') {
        tone = 'bad';
        text = `GitHub reached this server for ${repoLink}, but the delivery was rejected: ${esc(w.detail || 'unknown error')}. Check the secret below, then click Redeliver on GitHub.`;
      } else if (w.state === 'other_repo') {
        tone = 'bad';
        text = `GitHub is sending pushes from <code>${esc(w.repo_seen)}</code>, not ${repoLink}. Remove that webhook, or change the repository here.`;
      } else {
        tone = 'wait';
        text = `Waiting for GitHub to contact this server for ${repoLink}… <button type="button" class="text-btn" id="repo-recheck-btn">Check now</button>`;
      }
    }
    const line = $('#repo-line');
    line.dataset.tone = tone;
    line.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${text}</span>`;

    // Manual webhook details only matter while the webhook isn't working yet (or on request).
    const manual = $('#manual-setup');
    const needsManual = r.method === 'webhook' && r.webhook.state !== 'connected';
    manual.hidden = r.method !== 'webhook';
    if (needsManual && !manual.dataset.touched) manual.open = true;
    if (r.method === 'webhook') {
      $('#manual-gh-link').href = `https://github.com/${r.repo}/settings/hooks/new`;
      $('#manual-url').textContent = store.get(PAYLOAD_KEY) || payloadUrlDefault() || '(your server\'s public address)/webhook/github';
      const hint = $('#manual-local-hint');
      hint.hidden = !isLocal();
      hint.innerHTML = `GitHub can't reach <code>localhost</code>. Either run <code>npx smee-client --target ${esc(window.location.origin)}/webhook/github</code> and use the address it prints, or click <em>Change repository</em> and connect with a token instead.`;
      if (manual.open && state.hookSecret === null) loadHookSecret();
    }
  }

  function renderRepoForm(connected) {
    const f = state.form;
    $('#repo-cancel-btn').hidden = !connected;
    $('#repo-step1').hidden = f.step !== 1;
    $('#repo-step2').hidden = f.step !== 2;
    if (f.step === 1) return;

    const method = f.method || recommendedMethod(f.private);
    $('#step2-repo').textContent = f.repo;
    for (const el of $$('input[name="repo-method"]')) el.checked = el.value === method;
    $('#adv-webhook').hidden = method !== 'webhook';

    const steps = $('#token-steps');
    if (method === 'poll') {
      $('#method-explain').innerHTML = `Commit Doctor will check <strong>${esc(f.repo)}</strong> for new commits every few minutes using a <strong>read-only</strong> GitHub token. The token is stored encrypted on this server and deleted if you disconnect.`;
      steps.innerHTML = `<li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token on GitHub</a>.</li>
        <li>Under <em>Repository access</em>, choose <em>Only select repositories</em> and pick <code>${esc(f.repo)}</code>.</li>
        <li>Under <em>Permissions</em>, set <em>Contents</em> to <em>Read-only</em>. Nothing else is needed.</li>
        <li>Generate the token and paste it below.</li>`;
      $('#repo-connect-btn').textContent = 'Connect';
    } else {
      $('#method-explain').innerHTML = `GitHub will tell Commit Doctor the moment someone pushes to <strong>${esc(f.repo)}</strong>. Paste a token once so Commit Doctor can set this up for you. The token is used once and <strong>not saved</strong>.`;
      steps.innerHTML = `<li><a href="https://github.com/settings/tokens/new?scopes=admin:repo_hook&amp;description=Commit%20Doctor%20webhook" target="_blank" rel="noopener">Create a token on GitHub</a> (the <code>admin:repo_hook</code> box is already ticked).</li>
        <li>Generate it and paste it below.</li>`;
      $('#repo-connect-btn').textContent = 'Connect';
      const url = $('#payload-url');
      if (!url.value) url.value = store.get(PAYLOAD_KEY) || payloadUrlDefault();
      const hint = $('#payload-hint');
      hint.hidden = !isLocal();
      hint.innerHTML = 'This server is running on <code>localhost</code>, which GitHub can\'t reach. Use a public address (for example from <code>npx smee-client</code> or <code>ngrok</code>), or switch to "Every few minutes" above.';
    }
  }

  function openForm({ repo = '', step = 1, isPrivate = false, method = null } = {}) {
    state.form = { open: true, step, repo, private: isPrivate, method };
    $('#repo-error').hidden = true;
    $('#token-input').value = '';
    if (step === 1) {
      $('#repo-input').value = repo;
      for (const el of $$('input[name="repo-private"]')) el.checked = el.value === (isPrivate ? 'yes' : 'no');
    }
    renderRepoCard();
    (step === 1 ? $('#repo-input') : $('#token-input')).focus();
  }
  function closeForm() {
    state.form.open = false;
    renderRepoCard();
  }
  function formError(msg) {
    const el = $('#repo-error');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  function continueToStep2() {
    const repo = parseRepo($('#repo-input').value);
    if (!repo) { formError('Enter the repository as owner/name, or paste its GitHub link.'); $('#repo-input').focus(); return; }
    const isPrivate = $('input[name="repo-private"]:checked').value === 'yes';
    formError('');
    state.form = { ...state.form, step: 2, repo, private: isPrivate, method: null };
    $('#token-input').value = '';
    $('#advanced').open = false;
    renderRepoCard();
    $('#token-input').focus();
  }

  /** Ask before a switch wipes the previous project. Resolves true to go ahead. */
  function confirmSwitch(info, repo) {
    const dlg = $('#switch-dialog');
    $('#switch-text').innerHTML = `Commit Doctor follows one repository at a time. Switching to <strong>${esc(repo)}</strong> deletes the history of <strong>${esc(info.current)}</strong> (${plural(info.commits, 'commit')}), with its saved summaries and flags. Subscribers and the deadline are kept. This can't be undone.`;
    if (typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm($('#switch-text').textContent));
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.showModal();
    });
  }

  async function connectRepo({ manual = false } = {}) {
    const f = state.form;
    const method = manual ? 'webhook' : (f.method || recommendedMethod(f.private));
    const token = manual ? '' : $('#token-input').value.trim();
    const payloadUrl = $('#payload-url').value.trim();
    if (!manual && !token) { formError('Paste the GitHub token first.'); $('#token-input').focus(); return; }
    if (method === 'webhook' && token) {
      if (!payloadUrl) { $('#advanced').open = true; formError('Enter the address GitHub should send pushes to (under Advanced).'); $('#payload-url').focus(); return; }
      store.set(PAYLOAD_KEY, payloadUrl);
    }
    formError('');
    const btn = $('#repo-connect-btn');
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    const send = (replace) => api('/api/repository', {
      method: 'POST', token: state.token,
      body: { repo: f.repo, method, token: token || undefined, payload_url: method === 'webhook' && token ? payloadUrl : undefined, replace },
    });
    try {
      let result;
      try {
        result = await withAdmin(() => send(false), 'connect a repository');
      } catch (err) {
        if (!(err.status === 409 && err.body && err.body.needs_replace)) throw err;
        if (!(await confirmSwitch(err.body, f.repo))) return;
        result = await send(true);
      }
      state.repository = result;
      $('#token-input').value = '';
      state.form.open = false;
      if (manual) $('#manual-setup').open = true;
      state.date = null;
      await refresh({ force: true });
      await loadPrediction();
    } catch (err) {
      if (err.status !== 401) formError(errText(err));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect';
    }
  }

  async function disconnectRepo() {
    const r = state.repository;
    if (!window.confirm(`Stop following ${r.repo}? Its history stays visible until you connect another repository.${r.method === 'poll' ? ' The saved token is deleted.' : ' Also remove the webhook on GitHub (Settings › Webhooks).'}`)) return;
    try {
      state.repository = await withAdmin(() => api('/api/repository', { method: 'DELETE', token: state.token }), 'disconnect the repository');
      await refresh({ force: true });
    } catch (err) {
      if (err.status !== 401) window.alert(errText(err));
    }
  }

  async function loadHookSecret() {
    state.hookSecret = '';
    const el = $('#manual-secret');
    try {
      const setup = await api('/api/webhook-setup', { token: state.token });
      state.hookSecret = setup.secret;
      el.textContent = setup.secret;
    } catch (err) {
      state.hookSecret = null;
      el.innerHTML = err.status === 401
        ? '<button type="button" class="text-btn" id="manual-secret-unlock">Enter admin token to show</button>'
        : esc(err.message);
    }
  }

  async function copyField(id, btn) {
    const text = $(`#${id}`).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select and copy';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }

  // After connecting a webhook, re-check every few seconds so the card flips to
  // "Connected" as soon as GitHub's ping lands.
  function watchWebhook() {
    const r = state.repository;
    const waiting = r && r.method === 'webhook' && r.webhook.state !== 'connected';
    if (waiting && !state.watchTimer) {
      const until = Date.now() + 2 * 60 * 1000;
      state.watchTimer = setInterval(() => {
        if (Date.now() > until || (state.repository && state.repository.webhook && state.repository.webhook.state === 'connected')) {
          clearInterval(state.watchTimer);
          state.watchTimer = null;
        }
        refresh().catch(showError);
      }, 3000);
    }
  }

  // --- the day header ----------------------------------------------------------------
  const TRIGGER = { scheduled: 'by the daily job', catchup: 'on restart, to catch up', manual: 'manually' };

  function renderNote() {
    const { overview: o, summary: s, date } = state;
    const nothingYet = o.totals.commits === 0;
    $('#repo').textContent = o.repo ? `${o.repo} · times in ${o.timezone}` : `Times in ${o.timezone}`;
    $('#day-title').textContent = dayLong(date);

    const deadlineInput = $('#deadline-input');
    const deadline = o.settings && o.settings.deadline_date;
    if (document.activeElement !== deadlineInput) deadlineInput.value = deadline || '';
    $('#deadline-clear-btn').hidden = !deadline;

    let text = '';
    if (nothingYet) {
      text = state.repository && state.repository.repo
        ? 'No commits recorded yet. They appear here as soon as someone pushes.'
        : 'Connect a repository above to start, or run npm run seed to load demo data.';
    } else if (s.source === 'saved') text = `Saved ${stamp(s.generated_at)} ${TRIGGER[s.trigger] || ''}.`;
    else if (date >= o.today) text = `Live view of today so far. The summary is saved automatically after midnight (${o.timezone}).`;
    else if (s.total_commits > 0) text = 'No summary was saved for this day, so this one is computed live.';
    $('#provenance').textContent = text;

    const btn = $('#save-btn');
    btn.hidden = nothingYet || s.total_commits === 0;
    btn.textContent = s.source === 'saved' ? 'Update saved summary' : 'Save summary now';

    $('#date-input').value = date;
    $('#date-input').max = o.today;
    $('#next').disabled = date >= o.today;
    $('#today').disabled = date === o.today;
  }

  // --- deadline prediction ------------------------------------------------------------
  const PRED_LABEL = {
    'on-pace': 'On pace', 'at-risk': 'At risk', behind: 'Behind pace',
    'deadline-passed': 'Deadline passed', 'insufficient-data': 'Not enough history yet',
  };

  function renderPrediction() {
    const p = state.prediction;
    const el = $('#prediction');
    if (!p || p.status === 'no-deadline') { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.status = p.status;
    const strong = `<strong>${esc(PRED_LABEL[p.status] || p.status)}</strong>`;
    if (p.status === 'insufficient-data') { el.innerHTML = `<span class="dot" aria-hidden="true"></span>${strong}: deadline in ${plural(p.days_remaining, 'day')}.`; return; }
    if (p.status === 'deadline-passed') { el.innerHTML = `<span class="dot" aria-hidden="true"></span>${strong} (${plural(Math.abs(p.days_remaining), 'day')} ago).`; return; }
    const pace = p.recent_commit_rate >= p.earlier_commit_rate
      ? `averaging ${p.recent_commit_rate} commits a day over the last ${plural(p.window_days, 'day')}, matching or beating the ${p.earlier_commit_rate} a day before that`
      : `averaging ${p.recent_commit_rate} commits a day over the last ${plural(p.window_days, 'day')}, down from ${p.earlier_commit_rate} a day before that`;
    el.innerHTML = `<span class="dot" aria-hidden="true"></span>${strong}: ${pace}. ${plural(p.days_remaining, 'day')} left.`;
  }

  async function loadPrediction() {
    try {
      state.prediction = await api('/api/prediction');
      renderPrediction();
      if (state.summary) renderDigest();
    } catch (err) {
      console.error(err);
    }
  }

  async function setDeadline(value) {
    try {
      await withAdmin(() => api('/api/settings', { method: 'POST', token: state.token, body: { deadline_date: value } }), 'change the deadline');
      await refresh({ force: true });
      await loadPrediction();
    } catch (err) {
      if (err.status !== 401) window.alert(errText(err));
    }
  }

  // --- the pulse trace ---------------------------------------------------------
  function renderTrace() {
    const host = $('#trace');
    const days = state.trend;
    if (!days.length) return;
    const W = Math.max(320, host.clientWidth);
    const H = 214;
    const slot = W / days.length;
    const y0 = 138;
    const maxH = y0 - 34;
    const max = Math.max(4, ...days.map((d) => d.commits));
    const narrow = slot < 34;

    let path = `M0 ${y0}`;
    const peaks = [];
    days.forEach((day, i) => {
      const cx = slot * i + slot / 2;
      const h = day.commits ? Math.max(12, (day.commits / max) * maxH) : 0;
      if (!h) { path += ` L${(cx + slot / 2).toFixed(1)} ${y0}`; return; }
      const p = (dx, dy) => ` L${(cx + dx * slot).toFixed(1)} ${(y0 + dy).toFixed(1)}`;
      path += p(-0.3, 0) + p(-0.22, -h * 0.14) + p(-0.14, 0) + p(-0.07, h * 0.1) + p(0, -h) +
              p(0.07, h * 0.24) + p(0.13, 0) + p(0.25, -h * 0.18) + p(0.34, 0) + p(0.5, 0);
      peaks.push({ i, cx, y: y0 - h, n: day.commits });
    });

    const parts = [];
    parts.push(`<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Commits per day">`);
    parts.push(`<defs>
      <pattern id="g-minor" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" class="g-minor"/></pattern>
      <pattern id="g-major" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" class="g-major"/></pattern>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g-minor)"/><rect width="${W}" height="${H}" fill="url(#g-major)"/>`);
    days.forEach((day, i) => {
      if (day.date === state.date) parts.push(`<rect class="band" x="${(slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>`);
    });
    parts.push(`<path class="trace-line${state.drawn ? '' : ' draw'}" pathLength="1" d="${path}"/>`);
    peaks.forEach((pk) => {
      if (days[pk.i].date === state.date) parts.push(`<circle class="peak-dot" cx="${pk.cx.toFixed(1)}" cy="${pk.y.toFixed(1)}" r="5"/>`);
      parts.push(`<text class="peak-label" x="${pk.cx.toFixed(1)}" y="${(pk.y - 9).toFixed(1)}">${pk.n}</text>`);
    });
    days.forEach((day, i) => {
      const cx = slot * i + slot / 2;
      const sel = day.date === state.date;
      const name = day.is_today ? 'Today' : dayShort(day.date);
      parts.push(`<g class="${sel ? 'is-selected' : ''}">
        <text class="day-num" x="${cx.toFixed(1)}" y="188">${Number(day.date.slice(8))}</text>
        ${narrow ? '' : `<text class="day-name" x="${cx.toFixed(1)}" y="203">${esc(name)}</text>`}
        ${day.saved ? `<circle class="saved-dot" cx="${cx.toFixed(1)}" cy="170" r="2.6"/>` : ''}
      </g>`);
    });
    days.forEach((day, i) => {
      const label = `${dayLong(day.date)}: ${plural(day.commits, 'commit')}${day.saved ? ', summary saved' : ''}`;
      parts.push(`<rect class="hit" x="${(slot * i).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"
        tabindex="0" role="button" aria-pressed="${day.date === state.date}" aria-label="${esc(label)}" data-date="${day.date}"><title>${esc(label)}</title></rect>`);
    });
    parts.push('</svg>');
    host.innerHTML = parts.join('');
    state.drawn = true;
    if (state.refocus) {
      const el = host.querySelector(`.hit[data-date="${state.refocus}"]`);
      if (el) el.focus();
      state.refocus = null;
    }
  }

  // --- view 1: Digest (whole repo, a few plain sentences) -----------------------------
  const FLAG_LABEL = {
    activity_above_baseline: ['Activity above baseline', 'ok'],
    activity_below_baseline: ['Activity below baseline', 'bad'],
    contributor_inactive: ['Contributor inactive', 'bad'],
    deadline_at_risk: ['Deadline at risk', 'bad'],
    deadline_behind: ['Behind deadline pace', 'bad'],
  };
  const inactiveAfter = () => state.overview.rules.comparison_days;
  const quietPeople = () => state.contributors.filter((c) => c.idle_days >= inactiveAfter());

  function renderDigest() {
    const s = state.summary;
    const c = s.comparison;
    const items = [];
    if (s.total_commits === 0) {
      items.push(['', 'No commits on this day.']);
    } else {
      let first = `${plural(s.total_commits, 'commit')} from ${plural(s.contributor_count, 'contributor')}`;
      if (c.trend === 'above') first += c.delta_pct != null ? `, ${c.delta_pct}% above the usual ${c.baseline_days}-day average` : ', after a quiet stretch';
      else if (c.trend === 'below') first += `, ${Math.abs(c.delta_pct)}% below the usual ${c.baseline_days}-day average`;
      else if (c.trend === 'steady') first += ', about the usual amount';
      items.push(['', `${first}.`]);
      const top = s.contributors[0];
      items.push(['', s.contributor_count > 1 ? `${top.name} was the most active, with ${plural(top.commits, 'commit')}.` : `All of it by ${top.name}.`]);
    }
    for (const q of quietPeople()) items.push(['bad', `${q.name} hasn't committed in ${plural(q.idle_days, 'day')} (last on ${dayMed(q.last_date)}).`]);

    const p = state.prediction;
    if (p && p.deadline_date) {
      const when = dayMed(p.deadline_date);
      const left = plural(Math.abs(p.days_remaining), 'day');
      const line = {
        'on-pace': ['ok', `On pace for the ${when} deadline (${left} left).`],
        'at-risk': ['bad', `At risk of missing the ${when} deadline (${left} left): the pace has slowed.`],
        behind: ['bad', `Behind pace for the ${when} deadline (${left} left).`],
        'insufficient-data': ['', `Deadline ${when} (${left} left). Not enough history yet to judge the pace.`],
        'deadline-passed': ['', `The ${when} deadline passed ${left} ago.`],
      }[p.status];
      if (line) items.push(line);
    }
    $('#digest').innerHTML = items.map(([tone, t]) => `<li${tone ? ` data-tone="${tone}"` : ''}>${esc(t)}</li>`).join('');

    const vs = c.trend === 'no-baseline' ? '—' : c.delta_pct == null ? 'Up' : `${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%`;
    const tiles = [
      ['Commits', s.total_commits],
      ['Contributors', s.contributor_count],
      [`Vs. ${c.baseline_days || inactiveAfter()}-day average`, vs],
      ['Days to deadline', p && p.deadline_date && p.days_remaining >= 0 ? p.days_remaining : '—'],
    ];
    $('#tiles').innerHTML = tiles.map(([k, v]) => `<div class="tile"><span class="tile-v">${esc(v)}</span><span class="tile-k">${esc(k)}</span></div>`).join('');

    const flags = state.flags.filter((f) => f.type !== 'contributor_inactive');
    $('#flags').innerHTML = flags.length
      ? flags.map((f) => {
          const [label, tone] = FLAG_LABEL[f.type] || [f.type, ''];
          return `<li data-tone="${tone}"><strong>${esc(label)}</strong><span>${esc(f.detail)}</span></li>`;
        }).join('')
      : `<li class="empty">${s.source === 'saved' ? 'Nothing unusual on this day.' : 'Activity flags are checked when the day\'s summary is saved.'}</li>`;
  }

  // --- view 2: Team (grouped by contributor) -------------------------------------------
  function renderTeam() {
    const today = new Map(state.summary.contributors.map((c) => [c.name, c]));
    const people = state.contributors.map((p) => ({ ...p, day: today.get(p.name) || null }));
    for (const c of state.summary.contributors) {
      if (!people.some((p) => p.name === c.name)) people.push({ name: c.name, display_name: c.display_name, idle_days: 0, commits_7d: c.commits, day: c });
    }
    if (!people.length) { $('#team').innerHTML = '<p class="empty">Nobody has committed yet.</p>'; return; }
    people.sort((a, b) => (b.day ? b.day.commits : 0) - (a.day ? a.day.commits : 0) || a.idle_days - b.idle_days || a.name.localeCompare(b.name));
    const max = Math.max(1, ...people.map((p) => (p.day ? p.day.commits : 0)));

    $('#team').innerHTML = people.map((p) => {
      const d = p.day;
      let badge;
      if (d) badge = '<span class="badge" data-tone="ok">Active this day</span>';
      else if (p.idle_days >= inactiveAfter()) badge = `<span class="badge" data-tone="bad">Inactive ${plural(p.idle_days, 'day')}</span>`;
      else badge = `<span class="badge">Last commit ${esc(dayMed(p.last_date))}</span>`;
      const alias = p.display_name && p.display_name !== p.name ? `<small>${esc(p.display_name)}</small>` : '';
      const span = d ? (d.first_time === d.last_time ? d.first_time : `${d.first_time} to ${d.last_time}`) : '';
      const lines = d && d.lines_changed != null
        ? `<span class="lines"><span class="add">+${d.lines_added}</span> <span class="del">&minus;${d.lines_deleted}</span></span>` : '';
      return `<article class="person">
        <div class="person-head"><h3>${esc(p.name)}${alias}</h3>${badge}</div>
        <div class="person-stats">
          <span class="person-big">${d ? d.commits : 0}</span><span class="muted">commits this day</span>
          <div class="bar" role="img" aria-label="${esc(p.name)}: ${plural(d ? d.commits : 0, 'commit')}"><span style="width:${((d ? d.commits : 0) / max) * 100}%"></span></div>
        </div>
        <p class="person-meta">${[span && `Active ${esc(span)}`, lines, `${plural(p.commits_7d, 'commit')} in the last 7 days`].filter(Boolean).join(' · ')}</p>
      </article>`;
    }).join('');
  }

  // --- view 3: Timeline (grouped by time of day) ---------------------------------------
  const PERIODS = [['Night', 0, 5], ['Morning', 6, 11], ['Afternoon', 12, 17], ['Evening', 18, 23]];

  function renderTimeline() {
    const s = state.summary;
    const h = s.hourly;
    const max = Math.max(1, ...h);
    const desc = h.map((n, i) => (n ? `${hh(i)}: ${n}` : null)).filter(Boolean).join(', ') || 'no commits';
    $('#hours').innerHTML = `<div class="hours" role="img" aria-label="Commits by hour of day. ${esc(desc)}">
      ${h.map((n, i) => `<i data-n="${n}" title="${hh(i)}, ${plural(n, 'commit')}" style="height:${(n / max) * 100}%"></i>`).join('')}
    </div>
    <div class="hour-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;

    const rows = [
      ['First commit', s.first_commit_time || '—'],
      ['Last commit', s.last_commit_time || '—'],
      ['Busiest hour', s.peak_hour == null ? '—' : hh(s.peak_hour)],
      ['Merge commits', s.merge_commits],
    ];
    $('#vitals').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');

    const commits = [...state.commits].reverse(); // oldest first
    if (!commits.length) { $('#timeline').innerHTML = '<p class="empty">No commits on this day.</p>'; return; }
    $('#timeline').innerHTML = PERIODS.map(([name, from, to]) => {
      const list = commits.filter((c) => { const hr = Number(String(c.time).slice(0, 2)); return hr >= from && hr <= to; });
      if (!list.length) return '';
      return `<h3 class="period">${name} <span class="muted">${hh(from)}–${String(to).padStart(2, '0')}:59 · ${plural(list.length, 'commit')}</span></h3>
        <ol class="commit-list">${list.map((c) => {
          const url = safeUrl(c.url);
          const sha = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(c.short_sha)}</a>` : esc(c.short_sha);
          const first = String(c.message).split('\n')[0] || '(no message)';
          return `<li><span class="c-time">${esc(c.time)}</span>
            <div><span class="c-msg">${esc(first)}</span>${c.is_merge ? '<span class="tag">merge</span>' : intentTag(c.intent)}
            <span class="c-meta">${esc(c.contributor)}${c.branch ? ` on ${esc(c.branch)}` : ''}, ${sha}</span></div></li>`;
        }).join('')}</ol>`;
    }).join('');
  }

  // --- view switching and anonymous usage logging (research question 5) ---------------
  const sessionId = (() => {
    const KEY = 'commitdoctor.session';
    let id = store.get(KEY);
    if (!/^[a-f0-9]{32}$/.test(id || '')) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      store.set(KEY, id);
    }
    return id;
  })();
  const logView = (kind, extra = {}) => api('/api/views/events', {
    method: 'POST', keepalive: true, body: { session: sessionId, view: state.view, kind, day: state.date, ...extra },
  }).catch(() => { /* usage logging must never break the dashboard */ });

  let shownAt = null; // when the current view became visible
  function startDwell() { if (!document.hidden) shownAt = performance.now(); }
  function flushDwell() {
    if (shownAt == null) return;
    const ms = Math.round(performance.now() - shownAt);
    shownAt = null;
    if (ms >= 500) logView('dwell', { value: ms });
  }

  function showView(view, { log = true, focus = false } = {}) {
    if (!VIEWS.includes(view)) view = 'digest';
    if (log && view !== state.view) flushDwell();
    const changed = view !== state.view;
    state.view = view;
    store.set('commitdoctor.view', view);
    for (const v of VIEWS) {
      const tab = $(`#tab-${v}`);
      const on = v === view;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`#panel-${v}`).hidden = !on;
    }
    if (focus) $(`#tab-${view}`).focus();
    renderFeedback();
    if (log && (changed || shownAt == null)) { logView('open'); startDwell(); }
  }

  const feedbackKey = () => `commitdoctor.fb.${state.view}.${state.date}`;
  function renderFeedback() {
    const chosen = store.get(feedbackKey());
    $('#feedback-q').textContent = `Was the ${state.view[0].toUpperCase()}${state.view.slice(1)} view helpful for this day?`;
    for (const b of $$('.fb-btn')) b.setAttribute('aria-pressed', String(b.dataset.value === chosen));
    $('#fb-thanks').hidden = chosen == null;
  }
  function sendFeedback(value) {
    store.set(feedbackKey(), String(value));
    logView('feedback', { value });
    renderFeedback();
  }

  // --- subscribers -----------------------------------------------------------------
  function renderSubscribers() {
    const list = state.subscribers;
    const host = $('#sub-list');
    if (!list.length) { host.innerHTML = '<li class="empty">Nobody yet.</li>'; return; }
    host.innerHTML = list.map((s) => `<li>
      <div>${esc(s.name)}<small>${esc(s.email)}</small></div>
      <button type="button" class="text-btn sub-remove" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button>
    </li>`).join('');
  }
  async function loadSubscribers() {
    try { state.subscribers = await api('/api/subscribers'); renderSubscribers(); } catch (err) { console.error(err); }
  }
  async function addSubscriber() {
    const btn = $('#sub-add-btn');
    const name = $('#sub-name').value.trim();
    const email = $('#sub-email').value.trim();
    const hint = $('#sub-hint');
    hint.hidden = true;
    if (!name || !email) return;
    btn.disabled = true;
    try {
      await withAdmin(() => api('/api/subscribers', { method: 'POST', token: state.token, body: { name, email } }), 'add a subscriber');
      $('#sub-name').value = '';
      $('#sub-email').value = '';
      await loadSubscribers();
    } catch (err) {
      if (err.status !== 401) { hint.hidden = false; hint.textContent = errText(err); }
    }
    btn.disabled = false;
  }
  async function removeSubscriber(id) {
    try {
      await withAdmin(() => api(`/api/subscribers/${id}`, { method: 'DELETE', token: state.token }), 'remove a subscriber');
      await loadSubscribers();
    } catch (err) {
      if (err.status !== 401) window.alert(errText(err));
    }
  }

  // --- rendering and data loading ----------------------------------------------------
  function renderAll() {
    renderStatus();
    renderRepoCard();
    renderNote();
    renderTrace();
    renderDigest();
    renderTeam();
    renderTimeline();
    renderFeedback();
  }

  async function refresh({ force = false } = {}) {
    const [overview, repository] = await Promise.all([api('/api/overview'), api('/api/repository')]);
    if (!state.date) state.date = overview.today;
    const [trend, summary, commits, flags, contributors] = await Promise.all([
      api('/api/trend?days=14'),
      api(`/api/summaries/${state.date}`),
      api(`/api/commits?date=${state.date}`),
      api(`/api/flags?date=${state.date}`),
      api(`/api/contributors?date=${state.date}`),
    ]);
    state.overview = overview;
    state.repository = repository;
    const key = JSON.stringify([overview.totals, overview.last_saved_date, overview.settings, repository, trend, summary, commits, flags, contributors, state.date]);
    if (!force && key === state.key) { renderStatus(); return; } // nothing changed; keep focus and hover as they are
    Object.assign(state, { trend, summary, commits, flags, contributors, key });
    renderAll();
    watchWebhook();
  }

  function select(date) {
    if (!date || date > state.overview.today || date === state.date) return;
    flushDwell();
    state.date = date;
    refresh({ force: true }).then(() => startDwell()).catch(showError);
  }

  function showError(err) {
    console.error(err);
    $('#status').dataset.state = 'warn';
    $('#status-text').textContent = 'Cannot reach the Commit Doctor server';
  }

  async function saveNow() {
    const btn = $('#save-btn');
    btn.disabled = true;
    try {
      const saved = await withAdmin(() => api(`/api/summaries/${state.date}/generate`, { method: 'POST', token: state.token }), 'save summaries');
      await refresh({ force: true });
      if (state.date >= state.overview.today) {
        $('#provenance').textContent = `Saved ${stamp(saved.summary.generated_at)}. Today stays live and is saved again after midnight.`;
      }
    } catch (err) {
      if (err.status !== 401) $('#provenance').textContent = `Not saved: ${err.body && err.body.reason ? err.body.reason : err.message}`;
    }
    btn.disabled = false;
  }

  // --- system log ----------------------------------------------------------------
  async function loadLog() {
    const [a, views] = await Promise.all([api('/api/activity?limit=25'), api('/api/views/stats')]);
    const pill = (s) => `<span class="${s === 'accepted' || s === 'saved' ? 'pill-ok' : s === 'rejected' ? 'pill-bad' : ''}">${esc(s)}</span>`;
    const deliveries = a.webhook_events.length
      ? `<table><thead><tr><th>Received</th><th>Event</th><th>Result</th><th>Stored</th><th>Note</th></tr></thead><tbody>${a.webhook_events
          .map((e) => `<tr><td>${esc(stamp(e.received_at))}</td><td>${esc(e.event || '')}</td><td>${pill(e.status)}</td><td>${e.commits_new} of ${e.commits_received}</td><td class="wrap">${esc(e.detail || '')}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">No deliveries yet.</p>';
    const runs = a.summary_runs.length
      ? `<table><thead><tr><th>Run</th><th>Day</th><th>Trigger</th><th>Result</th><th>Commits</th></tr></thead><tbody>${a.summary_runs
          .map((r) => `<tr><td>${esc(stamp(r.run_at))}</td><td>${esc(r.date)}</td><td>${esc(r.trigger)}</td><td>${pill(r.outcome)}</td><td>${r.total_commits}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">No summaries generated yet.</p>';
    const usage = `<table><thead><tr><th>View</th><th>Opened</th><th>Browsers</th><th>Avg. seconds open</th><th>👍</th><th>👎</th><th>Helpful</th></tr></thead><tbody>${views
      .map((v) => `<tr><td>${esc(v.view)}</td><td>${v.opens}</td><td>${v.sessions}</td><td>${v.avg_seconds_per_open ?? '—'}</td><td>${v.helpful}</td><td>${v.not_helpful}</td><td>${v.helpful_pct == null ? '—' : `${v.helpful_pct}%`}</td></tr>`)
      .join('')}</tbody></table>`;
    $('#log-body').innerHTML = `<div><h3>Summary view usage</h3><p class="muted small">Anonymous. Compares the Digest, Team and Timeline views (research question 5). The feasibility study lives on the <a href="study.html">study page</a>.</p><div class="tbl-wrap">${usage}</div></div>
      <div><h3>Webhook deliveries</h3><div class="tbl-wrap">${deliveries}</div></div>
      <div><h3>Summary runs</h3><div class="tbl-wrap">${runs}</div></div>`;
  }

  // --- wiring --------------------------------------------------------------------
  function bind() {
    $('#prev').addEventListener('click', () => select(shift(state.date, -1)));
    $('#next').addEventListener('click', () => select(shift(state.date, 1)));
    $('#today').addEventListener('click', () => select(state.overview.today));
    $('#date-input').addEventListener('change', (e) => select(e.target.value));
    $('#save-btn').addEventListener('click', saveNow);

    // repository card
    $('#repo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.form.step === 1) continueToStep2(); else connectRepo();
    });
    $('#repo-back-btn').addEventListener('click', () => openForm({ repo: state.form.repo, isPrivate: state.form.private }));
    $('#repo-cancel-btn').addEventListener('click', closeForm);
    $('#repo-change-btn').addEventListener('click', () => openForm());
    $('#repo-disconnect-btn').addEventListener('click', disconnectRepo);
    $('#manual-connect-btn').addEventListener('click', () => connectRepo({ manual: true }));
    $('#payload-url').addEventListener('input', (e) => store.set(PAYLOAD_KEY, e.target.value.trim()));
    for (const el of $$('input[name="repo-method"]')) {
      el.addEventListener('change', () => { state.form.method = el.value; formError(''); renderRepoCard(); });
    }
    $('#repo-connected').addEventListener('click', (e) => {
      if (e.target.id === 'repo-recheck-btn') refresh({ force: true }).catch(showError);
      if (e.target.id === 'repo-retoken-btn') openForm({ repo: state.repository.repo, step: 2, isPrivate: true, method: 'poll' });
      if (e.target.id === 'manual-secret-unlock') {
        const t = window.prompt('Enter the admin token:');
        if (t) { state.token = t; loadHookSecret(); }
      }
      if (e.target.classList.contains('copy-btn')) copyField(e.target.dataset.copy, e.target);
    });
    $('#manual-setup').addEventListener('toggle', (e) => {
      e.target.dataset.touched = '1';
      if (e.target.open && state.hookSecret === null) loadHookSecret();
    });

    // deadline
    $('#deadline-btn').addEventListener('click', () => { const v = $('#deadline-input').value; if (v) setDeadline(v); });
    $('#deadline-clear-btn').addEventListener('click', () => setDeadline(null));

    // views
    const tabs = $('.view-tabs');
    tabs.addEventListener('click', (e) => { const t = e.target.closest('[role="tab"]'); if (t) showView(t.dataset.view); });
    tabs.addEventListener('keydown', (e) => {
      const i = VIEWS.indexOf(state.view);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: VIEWS.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      showView(VIEWS[(next + VIEWS.length) % VIEWS.length], { focus: true });
    });
    $('#feedback').addEventListener('click', (e) => { const b = e.target.closest('.fb-btn'); if (b) sendFeedback(Number(b.dataset.value)); });
    document.addEventListener('visibilitychange', () => (document.hidden ? flushDwell() : startDwell()));
    window.addEventListener('pagehide', flushDwell);

    // subscribers
    $('#sub-form').addEventListener('submit', (e) => { e.preventDefault(); addSubscriber(); });
    $('#sub-list').addEventListener('click', (e) => { const b = e.target.closest('.sub-remove'); if (b) removeSubscriber(b.dataset.id); });

    // trace
    const trace = $('#trace');
    trace.addEventListener('click', (e) => { const r = e.target.closest('.hit'); if (r) select(r.dataset.date); });
    trace.addEventListener('keydown', (e) => {
      const r = e.target.closest('.hit');
      if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); state.refocus = r.dataset.date; select(r.dataset.date); }
    });

    $('#log').addEventListener('toggle', (e) => { if (e.target.open) loadLog().catch(showError); });

    let t;
    window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => state.trend.length && renderTrace(), 150); });
    setInterval(() => {
      if (document.hidden) return;
      refresh().catch(showError);
      loadPrediction();
      if ($('#log').open) loadLog().catch(() => {});
    }, 30000);
  }

  bind();
  const fromUrl = new URLSearchParams(window.location.search).get('view');
  const firstView = VIEWS.includes(fromUrl) ? fromUrl : (store.get('commitdoctor.view') || 'digest');
  refresh({ force: true })
    .then(() => showView(firstView, { log: true }))
    .catch(showError);
  loadPrediction();
  loadSubscribers();
})();
