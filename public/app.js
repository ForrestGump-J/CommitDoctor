(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);

  const state = { hookSecret: null, hookOpen: false, overview: null, trend: [], summary: null, commits: [], flags: [], date: null, token: null, drawn: false, key: '', pollRepos: [], prediction: null, subscribers: [] };

  // --- helpers ---------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await fetch(path, { method: opts.method || 'GET', headers, body });
    const resBody = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(resBody.error || resBody.reason || res.statusText);
      err.status = res.status;
      err.body = resBody;
      throw err;
    }
    return resBody;
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

  // --- header ------------------------------------------------------------------
  function renderStatus() {
    const o = state.overview;
    const st = o.settings || {};
    const w = o.webhook || {};
    const sync = w.sync || {};
    $('#patient-name').textContent = st.tracked_repo || (st.untracked ? 'Tracking off' : 'No repository');
    let s = 'warn';
    let t = 'Not connected';
    if (!st.tracked_repo) { s = 'idle'; t = st.untracked ? 'Paused' : 'Choose a repository'; }
    else if (w.state === 'connected') { s = 'ok'; t = w.last_ok_event === 'push' ? `Live, last push ${ago(w.last_ok_at)}` : 'Live'; }
    else if (sync.at && !sync.error) { s = 'ok'; t = `Synced ${ago(sync.at)}`; }
    else if (sync.error) { s = 'warn'; t = 'Sync failed'; }
    $('#status').dataset.state = s;
    $('#status-text').textContent = t;
  }

  // --- the note ----------------------------------------------------------------
  const TRIGGER = { scheduled: 'by the daily job', catchup: 'on restart, to catch up', manual: 'manually' };

  function renderNote() {
    const { overview: o, summary: s, date } = state;
    const nothingYet = o.totals.commits === 0;
    $('#repo').textContent = `${o.repo || (o.totals.commits ? 'All repositories' : 'No repository yet')}, times in ${o.timezone}`;
    $('#day-title').textContent = dayLong(date);

    const trackInput = $('#repo-input');
    if (document.activeElement !== trackInput) trackInput.value = (o.settings && o.settings.tracked_repo) || '';
    renderRepoSwitch();
    renderHookSetup();

    const deadlineInput = $('#deadline-input');
    const deadline = o.settings && o.settings.deadline_date;
    if (document.activeElement !== deadlineInput) deadlineInput.value = deadline || '';
    $('#deadline-clear-btn').hidden = !deadline;

    $('#headline').innerHTML = nothingYet
      ? 'No commits recorded yet. Open <button type="button" class="text-btn headline-btn" id="headline-setup">Setup</button> and choose a repository to follow.'
      : esc(s.headline);

    let text = '';
    if (!nothingYet) {
      if (s.source === 'saved') text = `Saved ${stamp(s.generated_at)} ${TRIGGER[s.trigger] || ''}.`;
      else if (date >= o.today) text = `Live view of today so far. The summary is saved automatically after midnight (${o.timezone}).`;
      else if (s.total_commits > 0) text = 'No summary was saved for this day, so this one is computed live.';
    }
    $('#provenance').textContent = text;

    const btn = $('#save-btn');
    btn.hidden = nothingYet || s.total_commits === 0;
    btn.textContent = s.source === 'saved' ? 'Update saved summary' : 'Save summary now';

    $('#date-input').value = date;
    $('#date-input').max = o.today;
    $('#next').disabled = date >= o.today;
    $('#today').disabled = date === o.today;
  }

  // --- polled repos --------------------------------------------------------------
  function renderPollList() {
    const list = state.pollRepos;
    const host = $('#poll-list');
    if (!list.length) { host.innerHTML = '<li class="empty">No private repos added.</li>'; return; }
    host.innerHTML = list.map((r) => {
      let status;
      if (r.last_error) status = `<span class="pill-bad" title="${esc(r.last_error)}">error</span>`;
      else if (r.last_polled_at) status = `<span class="pill-ok">last checked ${esc(ago(r.last_polled_at))}</span>`;
      else status = '<span>not checked yet</span>';
      return `<li data-id="${r.id}">
        <span class="poll-repo-name">${esc(r.repo)}</span>
        ${status}
        <button type="button" class="text-btn poll-remove" data-id="${r.id}" aria-label="Stop polling ${esc(r.repo)}">Remove</button>
      </li>`;
    }).join('');
  }

  async function loadPollList() {
    try {
      state.pollRepos = await api('/api/tracked-repos');
      renderPollList();
    } catch (err) {
      console.error(err);
    }
  }

  async function addPolledRepo() {
    const btn = $('#poll-add-btn');
    const repoInput = $('#poll-repo-input');
    const tokenInput = $('#poll-token-input');
    const repo = repoInput.value.trim();
    const token = tokenInput.value.trim();
    const hint = $('#poll-hint');
    hint.hidden = true;
    if (!repo || !token) return;
    btn.disabled = true;
    try {
      await api('/api/tracked-repos', { method: 'POST', token: state.token, body: { repo, token } });
      tokenInput.value = '';
      repoInput.value = '';
      await loadPollList();
      await refresh({ force: true });
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to add a private repo. Enter it:');
        if (t) { state.token = t; btn.disabled = false; return addPolledRepo(); }
      } else {
        hint.hidden = false;
        hint.textContent = err.body && err.body.error ? err.body.error : err.message;
      }
    }
    btn.disabled = false;
    return undefined;
  }

  async function removePolledRepo(id) {
    try {
      await api(`/api/tracked-repos/${id}`, { method: 'DELETE', token: state.token });
      await loadPollList();
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to remove a private repo. Enter it:');
        if (t) { state.token = t; return removePolledRepo(id); }
      } else {
        window.alert(err.body && err.body.error ? err.body.error : err.message);
      }
    }
    return undefined;
  }

  // --- subscribers -----------------------------------------------------------------
  function renderSubscribers() {
    const list = state.subscribers;
    const host = $('#sub-list');
    if (!list.length) { host.innerHTML = '<li class="empty">Nobody gets alerts yet.</li>'; return; }
    host.innerHTML = list.map((s) => `<li>
      <div>${esc(s.name)}<small>${esc(s.email)}</small></div>
      <button type="button" class="text-btn sub-remove" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button>
    </li>`).join('');
  }

  async function loadSubscribers() {
    try {
      state.subscribers = await api('/api/subscribers');
      renderSubscribers();
    } catch (err) {
      console.error(err);
    }
  }

  async function addSubscriber() {
    const btn = $('#sub-add-btn');
    const nameInput = $('#sub-name');
    const emailInput = $('#sub-email');
    const name = nameInput.value.trim();
    const email = emailInput.value.trim();
    const hint = $('#sub-hint');
    hint.hidden = true;
    if (!name || !email) return undefined;
    btn.disabled = true;
    try {
      await api('/api/subscribers', { method: 'POST', token: state.token, body: { name, email } });
      nameInput.value = '';
      emailInput.value = '';
      await loadSubscribers();
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to add a subscriber. Enter it:');
        if (t) { state.token = t; btn.disabled = false; return addSubscriber(); }
      } else {
        hint.hidden = false;
        hint.textContent = err.body && err.body.error ? err.body.error : err.message;
      }
    }
    btn.disabled = false;
    return undefined;
  }

  async function removeSubscriber(id) {
    try {
      await api(`/api/subscribers/${id}`, { method: 'DELETE', token: state.token });
      await loadSubscribers();
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to remove a subscriber. Enter it:');
        if (t) { state.token = t; return removeSubscriber(id); }
      } else {
        window.alert(err.body && err.body.error ? err.body.error : err.message);
      }
    }
    return undefined;
  }

  // --- deadline prediction --------------------------------------------------------
  const PRED_LABEL = {
    'on-pace': 'On pace',
    'at-risk': 'At risk',
    behind: 'Behind pace',
    'deadline-passed': 'Past deadline',
    'insufficient-data': 'Not enough history yet',
    'no-deadline': null,
  };
  function renderPrediction() {
    const p = state.prediction;
    const el = $('#prediction');
    if (!p || p.status === 'no-deadline') { el.hidden = true; return; }
    el.hidden = false;
    el.dataset.status = p.status;
    const label = `<strong>${esc(PRED_LABEL[p.status] || p.status)}</strong>`;
    const days = (n) => plural(Math.abs(n), 'day');
    let text;
    if (p.status === 'insufficient-data') text = `The deadline is in ${days(p.days_remaining)}. A pace estimate needs a few more days of commits.`;
    else if (p.status === 'deadline-passed') text = `The deadline was ${days(p.days_remaining)} ago.`;
    else {
      const trend = p.recent_commit_rate >= p.earlier_commit_rate ? 'at or above' : 'below';
      text = `${p.recent_commit_rate} commits a day over the last ${days(p.window_days)}, ${trend} the ${p.earlier_commit_rate} a day before that. ${days(p.days_remaining)} left.`;
    }
    el.innerHTML = `${label}<span>${esc(text)}</span>`;
  }

  async function loadPrediction() {
    try {
      state.prediction = await api('/api/prediction');
      renderPrediction();
    } catch (err) {
      console.error(err);
    }
  }

  async function setDeadline() {
    const btn = $('#deadline-btn');
    const input = $('#deadline-input');
    const value = input.value;
    if (!value) return;
    btn.disabled = true;
    try {
      await api('/api/settings', { method: 'POST', token: state.token, body: { deadline_date: value } });
      await refresh({ force: true });
      await loadPrediction();
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to change settings. Enter it:');
        if (t) { state.token = t; btn.disabled = false; return setDeadline(); }
      } else {
        window.alert(err.body && err.body.error ? err.body.error : err.message);
      }
    }
    btn.disabled = false;
    return undefined;
  }

  async function clearDeadline() {
    try {
      await api('/api/settings', { method: 'POST', token: state.token, body: { deadline_date: null } });
      await refresh({ force: true });
      await loadPrediction();
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to change settings. Enter it:');
        if (t) { state.token = t; return clearDeadline(); }
      } else {
        window.alert(err.body && err.body.error ? err.body.error : err.message);
      }
    }
    return undefined;
  }

  // --- the pulse trace ---------------------------------------------------------
  function renderTrace() {
    const host = $('#trace');
    const days = state.trend;
    if (!days.length) return;
    const W = Math.max(320, host.clientWidth);
    // Beside the readouts (wide screens), grow to their height so the paper has no empty band.
    const besideReadouts = window.matchMedia('(min-width: 881px)').matches;
    const fit = besideReadouts ? $('#vitals').offsetHeight - $('.trace-key').offsetHeight : 0;
    const H = Math.max(256, Math.min(420, fit));
    const slot = W / days.length;
    const y0 = H - 80;
    const maxH = y0 - 38;
    const max = Math.max(4, ...days.map((d) => d.commits));
    const narrow = slot < 34;

    let path = `M0 ${y0}`;
    const peaks = [];
    days.forEach((day, i) => {
      const cx = slot * i + slot / 2;
      const h = day.commits ? Math.max(12, (day.commits / max) * maxH) : 0;
      if (!h) { path += ` L${(cx + slot / 2).toFixed(1)} ${y0}`; return; }
      const p = (dx, dy) => ` L${(cx + dx * slot).toFixed(1)} ${(y0 + dy).toFixed(1)}`;
      // P wave, Q dip, R spike, S dip, T wave. Dips are capped so they never reach the date labels.
      path += p(-0.3, 0) + p(-0.22, -Math.min(h * 0.14, 16)) + p(-0.14, 0) + p(-0.07, Math.min(h * 0.1, 10)) + p(0, -h) +
              p(0.07, Math.min(h * 0.24, 24)) + p(0.13, 0) + p(0.25, -Math.min(h * 0.18, 20)) + p(0.34, 0) + p(0.5, 0);
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
        <text class="day-num" x="${cx.toFixed(1)}" y="${H - 28}">${Number(day.date.slice(8))}</text>
        ${narrow ? '' : `<text class="day-name" x="${cx.toFixed(1)}" y="${H - 12}">${esc(name)}</text>`}
        ${day.saved ? `<circle class="saved-dot" cx="${cx.toFixed(1)}" cy="${H - 48}" r="2.8"/>` : ''}
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

  // --- who / commits / vitals / hours ------------------------------------------
  function renderWho() {
    const list = state.summary.contributors;
    if (!list.length) { $('#who').innerHTML = '<p class="empty">Nobody committed on this day.</p>'; return; }
    const max = list[0].commits;
    $('#who').innerHTML = list.map((c) => {
      const span = c.first_time === c.last_time ? c.first_time : `${c.first_time} to ${c.last_time}`;
      const alias = c.display_name && c.display_name !== c.name ? `<small>${esc(c.display_name)}</small>` : '';
      const lines = c.lines_changed == null ? '' : `<small class="lines"><span class="add">+${c.lines_added}</span> <span class="del">&minus;${c.lines_deleted}</span> (${c.lines_changed} changed)</small>`;
      return `<div class="who-row">
        <div class="who-name">${esc(c.name)}${alias}<small>${esc(span)}</small>${lines}</div>
        <div class="bar" role="img" aria-label="${esc(c.name)}: ${plural(c.commits, 'commit')}"><span style="width:${(c.commits / max) * 100}%"></span></div>
        <div class="who-count">${c.commits}</div>
      </div>`;
    }).join('');
  }

  function renderCommits() {
    const list = state.commits;
    $('#commits').innerHTML = list.length
      ? list.map((c) => {
          const url = safeUrl(c.url);
          const sha = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(c.short_sha)}</a>` : esc(c.short_sha);
          const first = String(c.message).split('\n')[0] || '(no message)';
          return `<li><span class="c-time">${esc(c.time)}</span>
            <div><span class="c-msg">${esc(first)}</span>${c.is_merge ? '<span class="tag">merge</span>' : ''}
            <span class="c-meta">${esc(c.contributor)}${c.branch ? ` on ${esc(c.branch)}` : ''}, ${sha}</span></div></li>`;
        }).join('')
      : '<li class="empty" style="display:block;border:0">No commits on this day.</li>';
  }

  function renderVitals() {
    const s = state.summary;
    const c = s.comparison;
    let pace = { value: '—', note: 'No earlier days to compare', trend: '' };
    if (c.trend !== 'no-baseline') {
      const note = `vs. ${c.average} a day over ${c.baseline_days} days`;
      pace = c.delta_pct == null
        ? { value: 'Above', note, trend: 'up' }
        : { value: `${c.delta_pct > 0 ? '+' : ''}${c.delta_pct}%`, note, trend: c.delta_pct > 0 ? 'up' : c.delta_pct < 0 ? 'down' : '' };
    }
    const readout = (cls, label, value, note = '', trend = '') => `<div class="readout ${cls}"${trend ? ` data-trend="${trend}"` : ''}>
      <dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<small>${esc(note)}</small>` : ''}</dd></div>`;
    const span = s.first_commit_time
      ? (s.first_commit_time === s.last_commit_time ? s.first_commit_time : `${s.first_commit_time} to ${s.last_commit_time}`)
      : '—';
    $('#vitals').innerHTML = [
      readout('readout-main', 'Commits', s.total_commits),
      readout('', 'Contributors', s.contributor_count),
      readout('', 'Vs. recent days', pace.value, pace.note, pace.trend),
      readout('', 'Busiest hour', s.peak_hour == null ? '—' : hh(s.peak_hour), s.peak_hour == null ? '' : plural(s.hourly[s.peak_hour], 'commit')),
      readout('readout-minor', 'Active', span),
      readout('readout-minor', 'Merges', s.merge_commits),
    ].join('');
  }

  const FLAG_LABEL = {
    activity_above_baseline: ['Activity above baseline', 'ok'],
    activity_below_baseline: ['Activity below baseline', 'bad'],
    contributor_inactive: ['Contributor inactive', 'bad'],
    deadline_at_risk: ['Deadline at risk', 'bad'],
    deadline_behind: ['Behind deadline pace', 'bad'],
  };

  function renderFlags() {
    const list = state.flags;
    if (!list.length) {
      $('#flags').innerHTML = `<li class="empty" style="border:0;padding:0">${state.summary.source === 'saved' ? 'Nothing unusual on this day.' : 'Flags are checked when the day\'s summary is saved.'}</li>`;
      return;
    }
    $('#flags').innerHTML = list.map((f) => {
      const [label, tone] = FLAG_LABEL[f.type] || [f.type, ''];
      return `<li data-tone="${tone}"><strong>${esc(label)}</strong><span>${esc(f.detail)}</span></li>`;
    }).join('');
  }

  function renderHours() {
    const h = state.summary.hourly;
    const max = Math.max(1, ...h);
    const desc = h.map((n, i) => (n ? `${hh(i)}: ${n}` : null)).filter(Boolean).join(', ') || 'no commits';
    $('#hours').innerHTML = `<div class="hours" role="img" aria-label="Commits by hour of day. ${esc(desc)}">
      ${h.map((n, i) => `<i data-n="${n}" title="${hh(i)}, ${plural(n, 'commit')}" style="height:${(n / max) * 100}%"></i>`).join('')}
    </div>
    <div class="hour-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
  }

  function renderAll() {
    renderStatus();
    renderNote();
    renderVitals();
    renderTrace();
    renderWho();
    renderCommits();
    renderFlags();
    renderHours();
  }

  // --- data loading --------------------------------------------------------------
  async function refresh({ force = false } = {}) {
    const overview = await api('/api/overview');
    if (!state.date) state.date = overview.today;
    const [trend, summary, commits, flags] = await Promise.all([
      api('/api/trend?days=14'),
      api(`/api/summaries/${state.date}`),
      api(`/api/commits?date=${state.date}`),
      api(`/api/flags?date=${state.date}`),
    ]);
    state.overview = overview;
    const key = JSON.stringify([overview.totals, overview.last_saved_date, overview.webhook, overview.settings, trend, summary, commits, flags, state.date]);
    if (!force && key === state.key) { renderStatus(); return; } // nothing changed; keep focus and hover as they are
    Object.assign(state, { trend, summary, commits, flags, key });
    renderAll();
  }

  function select(date) {
    if (!date || date > state.overview.today || date === state.date) return;
    state.date = date;
    refresh({ force: true }).catch(showError);
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
      const saved = await api(`/api/summaries/${state.date}/generate`, { method: 'POST', token: state.token });
      await refresh({ force: true });
      if (state.date >= state.overview.today) {
        $('#provenance').textContent = `Saved ${stamp(saved.summary.generated_at)}. Today stays live and is saved again after midnight.`;
      }
    } catch (err) {
      if (err.status === 401) {
        const t = window.prompt('This server needs an admin token to save summaries. Enter it:');
        if (t) { state.token = t; btn.disabled = false; return saveNow(); }
      } else {
        $('#provenance').textContent = `Not saved: ${err.body && err.body.reason ? err.body.reason : err.message}`;
      }
    }
    btn.disabled = false;
    return undefined;
  }

  // Accept "owner/name" or anything pasted from GitHub (https://github.com/owner/name(.git)/...).
  const parseRepo = (v) => {
    const m = v.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
    return m ? `${m[1]}/${m[2]}` : v.trim();
  };

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

  async function trackRepo() {
    const btn = $('#track-btn');
    const input = $('#repo-input');
    const value = parseRepo(input.value);
    if (!value) return;
    input.value = value;
    btn.disabled = true;
    try {
      await withAdmin(() => api('/api/settings', { method: 'POST', token: state.token, body: { tracked_repo: value } }), 'change settings');
      state.hookOpen = true;
      state.autoSynced = true;
      await refresh({ force: true });
      await syncRepo();
      watchConnection();
    } catch (err) {
      if (err.status !== 401) window.alert(err.body && err.body.error ? err.body.error : err.message);
    }
    btn.disabled = false;
  }

  function renderRepoSwitch() {
    const st = state.overview.settings || {};
    const current = st.tracked_repo;
    const others = (st.known_repos || []).filter((r) => r !== current);
    const sel = $('#repo-switch');
    sel.hidden = others.length === 0;
    if (document.activeElement !== sel) {
      sel.innerHTML = `<option value="">${current ? 'Switch to…' : 'Track a recent repo…'}</option>` +
        others.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    }
    $('#untrack-btn').hidden = !current;
    $('#untrack-btn').parentElement.hidden = sel.hidden && !current;
    $('#untracked-hint').hidden = !(st.untracked);
    $('#track-btn').textContent = current ? 'Switch' : 'Track';
  }

  async function untrackRepo() {
    const repo = state.overview.settings && state.overview.settings.tracked_repo;
    if (!repo) return;
    if (!window.confirm(`Stop tracking ${repo}? Commits already recorded stay on the dashboard, but new pushes are ignored until you track a repo again.`)) return;
    try {
      await withAdmin(() => api('/api/settings', { method: 'POST', token: state.token, body: { tracked_repo: null } }), 'change settings');
      stopWatching();
      $('#repo-input').value = '';
      await refresh({ force: true });
    } catch (err) {
      if (err.status !== 401) window.alert(err.body && err.body.error ? err.body.error : err.message);
    }
  }

  // --- webhook setup panel -----------------------------------------------------------
  const isLocal = () => /^(localhost|127\.|\[::1\])/.test(window.location.hostname);
  const URL_KEY = 'commitdoctor.payloadUrl';
  const loadUrl = () => { try { return window.localStorage.getItem(URL_KEY) || ''; } catch { return ''; } };
  const saveUrl = (v) => { try { window.localStorage.setItem(URL_KEY, v); } catch { /* storage unavailable */ } };

  function renderHookSetup() {
    const o = state.overview;
    const repo = o.settings && o.settings.tracked_repo;
    const box = $('#hook-setup');
    box.hidden = !repo;
    if (!repo) return;

    const status = $('#hook-status');
    if (!o.webhook) {
      // Dashboard is newer than the running server; it can't report status yet.
      status.innerHTML = '<span class="hook-row" data-state="failing"><span class="dot" aria-hidden="true"></span><span>The server is running an older version. Restart it (<code>npm start</code>) to see connection status.</span></span>';
      return;
    }
    const w = o.webhook;
    const sync = w.sync || {};
    const live = w.state === 'connected';
    const synced = Boolean(sync.at && !sync.error);
    if (live) stopWatching();
    const r = `<code>${esc(repo)}</code>`;

    // Row 1: the repo itself, pulled through GitHub's API right after tracking.
    let syncState;
    let syncText;
    if (state.syncing) { syncState = 'waiting'; syncText = `Pulling recent commits from ${r}…`; }
    else if (sync.error) { syncState = 'failing'; syncText = `Couldn't pull ${r}: ${esc(sync.error)}`; }
    else if (sync.at) {
      syncState = 'connected';
      syncText = `Synced ${r} ${esc(ago(sync.at))}: ${sync.added ? `${plural(sync.added, 'new commit')} pulled` : 'already up to date'}.`;
      if (sync.interval_min) syncText += ` Re-syncs every ${sync.interval_min} min.`;
    } else { syncState = 'waiting'; syncText = `${r} hasn't been pulled yet.`; }
    const syncBtn = state.syncing ? '' : ' <button type="button" class="text-btn" id="hook-sync">Sync now</button>';

    // Row 2: live updates, which still need GitHub's webhook to reach this server.
    const liveText = {
      connected: w.last_ok_event === 'push'
        ? `Live updates on. Last push ${esc(ago(w.last_ok_at))}.`
        : `Live updates on. GitHub pinged ${esc(ago(w.last_ok_at))}.`,
      waiting: synced
        ? `Live updates: no webhook delivery yet. ${sync.interval_min ? `New commits are pulled automatically every ${sync.interval_min} min` : 'New commits appear when you click Sync now'}, or instantly once the webhook below reaches this server.`
        : 'Live updates: waiting for GitHub\'s webhook…',
      failing: `Live updates: GitHub's delivery was rejected (${esc(w.detail || 'unknown error')}). Check the secret and content type, then click Redeliver on GitHub.`,
      other_repo: `Live updates: nothing received from ${r} yet. The last delivery to this server (${esc(ago(w.at))}) came from <code>${esc(w.repo_seen)}</code>. If you added the webhook to ${r}, check its Recent Deliveries on GitHub: the Payload URL must reach this server (a smee/ngrok tunnel has to be running).`,
    }[w.state];
    const checking = state.watchUntil && !live ? ' <span class="hook-checking">checking…</span>' : '';
    const toggle = live ? ` <button type="button" class="text-btn" id="hook-toggle">${state.hookOpen ? 'Hide setup' : 'Show setup'}</button>` : '';
    const liveState = w.state === 'waiting' && synced ? 'idle' : w.state;

    const row = (st, text) => `<span class="hook-row" data-state="${st}"><span class="dot" aria-hidden="true"></span><span>${text}</span></span>`;
    status.innerHTML = row(syncState, syncText + syncBtn) + row(liveState, liveText + checking + toggle);
    $('#hook-steps').hidden = live && !state.hookOpen;
    // A repo tracked before syncing existed (or by another tab) gets pulled once on load.
    if (!sync.at && !state.syncing && !state.autoSynced) { state.autoSynced = true; setTimeout(() => syncRepo({ auto: true }), 0); }

    const urlInput = $('#hook-url-input');
    if (!urlInput.value) urlInput.value = loadUrl() || (isLocal() ? '' : `${window.location.origin}/webhook/github`);
    const urlHint = $('#hook-url-hint');
    urlHint.hidden = !isLocal();
    urlHint.innerHTML = 'GitHub cannot reach <code>localhost</code>. Run <code>npx smee-client --target ' +
      `${esc(window.location.origin)}/webhook/github</code> (or <code>ngrok http ${esc(window.location.port || '80')}</code>) and paste the public URL it prints.`;
    $('#hook-f-url').textContent = urlInput.value.trim() || '(fill in step 1)';
    $('#hook-gh-link').href = `https://github.com/${repo}/settings/hooks/new`;

    if (state.hookSecret === null) loadHookSecret();
  }

  async function loadHookSecret() {
    state.hookSecret = '';
    const el = $('#hook-f-secret');
    try {
      const setup = await api('/api/webhook-setup', { token: state.token });
      state.hookSecret = setup.secret;
      el.textContent = setup.secret;
    } catch (err) {
      state.hookSecret = null;
      el.innerHTML = err.status === 401
        ? '<button type="button" class="text-btn" id="hook-secret-unlock">Enter admin token to show</button>'
        : esc(err.message);
    }
  }

  // Pull the tracked repo's recent commits through GitHub's API right now
  // (public repos only; private ones belong under Private repos).
  async function syncRepo({ auto = false } = {}) {
    state.syncing = true;
    renderHookSetup();
    const call = () => api('/api/webhook-setup/sync', {
      method: 'POST', token: state.token, body: {},
    });
    try {
      // Don't pop an admin-token prompt for the automatic on-load sync.
      await (auto ? call() : withAdmin(call, 'sync the repository'));
    } catch (err) {
      // The server saves sync failures, so the indicator shows them after the refresh.
      if (err.status !== 422) console.error(err);
    }
    state.syncing = false;
    await refresh({ force: true }).catch(showError);
  }

  // Re-check every few seconds after a Track click so the indicator flips to
  // "Connected" as soon as GitHub's delivery lands, without reloading the page.
  const WATCH_MS = 3000;
  const WATCH_FOR_MS = 2 * 60 * 1000;
  function watchConnection() {
    stopWatching();
    state.watchUntil = Date.now() + WATCH_FOR_MS;
    state.watchTimer = setInterval(() => {
      if (Date.now() > state.watchUntil) { stopWatching(); renderHookSetup(); return; }
      refresh().catch(showError);
    }, WATCH_MS);
  }
  function stopWatching() {
    clearInterval(state.watchTimer);
    state.watchTimer = null;
    state.watchUntil = null;
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

  // --- system log ----------------------------------------------------------------
  async function loadLog() {
    const a = await api('/api/activity?limit=25');
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
    const sentPill = (st) => `<span class="${st === 'sent' ? 'pill-ok' : st === 'failed' ? 'pill-bad' : ''}">${esc(st)}</span>`;
    const notes = (a.notifications || []).length
      ? `<table><thead><tr><th>Time</th><th>Kind</th><th>Result</th><th>Delivered</th><th>Subject</th></tr></thead><tbody>${a.notifications
          .map((n) => `<tr><td>${esc(stamp(n.created_at))}</td><td>${esc(n.kind)}</td><td>${sentPill(n.status)}</td><td>${n.delivered} of ${n.recipients}</td><td class="wrap">${esc(n.subject || '')}${n.error ? `<br><span class="muted">${esc(n.error)}</span>` : ''}</td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="empty">No emails sent yet.</p>';
    $('#log-body').innerHTML = `<div><h3>Webhook deliveries</h3><div class="tbl-wrap">${deliveries}</div></div>
      <div><h3>Summary runs</h3><div class="tbl-wrap">${runs}</div></div>
      <div><h3>Emails</h3><div class="tbl-wrap">${notes}</div></div>`;
  }

  // --- setup sheet ----------------------------------------------------------------
  function openSetup() {
    const sheet = $('#setup');
    if (sheet.open) return;
    sheet.showModal();
    const first = !(state.overview && state.overview.settings && state.overview.settings.tracked_repo);
    if (first) $('#repo-input').focus();
  }

  // --- wiring --------------------------------------------------------------------
  function bind() {
    $('#open-setup').addEventListener('click', openSetup);
    $('#headline').addEventListener('click', (e) => { if (e.target.id === 'headline-setup') openSetup(); });
    $('#patient').addEventListener('click', openSetup);
    $('#close-setup').addEventListener('click', () => $('#setup').close());
    // A click on the backdrop lands on the dialog element itself.
    $('#setup').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('#prev').addEventListener('click', () => select(shift(state.date, -1)));
    $('#next').addEventListener('click', () => select(shift(state.date, 1)));
    $('#today').addEventListener('click', () => select(state.overview.today));
    $('#date-input').addEventListener('change', (e) => select(e.target.value));
    $('#save-btn').addEventListener('click', saveNow);
    $('#track-btn').addEventListener('click', trackRepo);
    $('#repo-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); trackRepo(); } });
    $('#untrack-btn').addEventListener('click', untrackRepo);
    $('#repo-switch').addEventListener('change', (e) => {
      if (!e.target.value) return;
      $('#repo-input').value = e.target.value;
      e.target.blur();
      trackRepo();
    });
    $('#hook-url-input').addEventListener('input', (e) => {
      saveUrl(e.target.value.trim());
      $('#hook-f-url').textContent = e.target.value.trim() || '(fill in step 1)';
    });
    $('#hook-setup').addEventListener('click', (e) => {
      if (e.target.id === 'hook-sync') syncRepo();
      if (e.target.id === 'hook-toggle') { state.hookOpen = !state.hookOpen; renderHookSetup(); }
      if (e.target.id === 'hook-secret-unlock') {
        const t = window.prompt('Enter the admin token:');
        if (t) { state.token = t; loadHookSecret(); }
      }
      if (e.target.classList.contains('copy-btn')) copyField(e.target.dataset.copy, e.target);
    });
    $('#deadline-btn').addEventListener('click', setDeadline);
    $('#deadline-clear-btn').addEventListener('click', clearDeadline);

    $('#poll-add-btn').addEventListener('click', addPolledRepo);
    $('#poll-token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPolledRepo(); } });
    $('#poll-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.poll-remove');
      if (btn) removePolledRepo(btn.dataset.id);
    });

    $('#sub-form').addEventListener('submit', (e) => { e.preventDefault(); addSubscriber(); });
    $('#sub-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.sub-remove');
      if (btn) removeSubscriber(btn.dataset.id);
    });

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
      loadPollList();
      loadPrediction();
      if ($('#log').open) loadLog().catch(() => {});
    }, 30000);
  }

  bind();
  refresh({ force: true })
    .then(() => {
      const o = state.overview;
      if (window.location.hash === '#setup' || (!o.settings.tracked_repo && o.totals.commits === 0)) openSetup();
    })
    .catch(showError);
  loadPollList();
  loadPrediction();
  loadSubscribers();
})();