/* Dashboard: one day of the shown repository, read three ways (Digest, Team, Timeline). */
(function () {
  'use strict';
  const { $, $$, esc, plural, ic, avatar, pill, get, send, act, toast } = CD;
  const VIEWS = ['digest', 'team', 'timeline'];
  const RANGES = [7, 14, 30];
  const TRIGGER = { scheduled: 'by the daily job', catchup: 'on restart, to catch up', manual: 'manually' };
  const PERIODS = [['Night', 0, 5], ['Morning', 6, 11], ['Afternoon', 12, 17], ['Evening', 18, 23]];

  const state = { date: null, range: Number(CD.store.get('comdoc.range')) || 14, view: 'digest', key: '' };

  /* ---------- anonymous usage logging of the three views (research question 5) ---------- */
  const sessionId = (() => {
    const KEY = 'commitdoctor.session';
    let id = CD.store.get(KEY);
    if (!/^[a-f0-9]{32}$/.test(id || '')) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      CD.store.set(KEY, id);
    }
    return id;
  })();
  const logView = (kind, extra = {}) => fetch('/api/views/events', {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, view: state.view, kind, day: state.date, ...extra }),
  }).catch(() => { /* usage logging must never break the dashboard */ });
  let shownAt = null;
  const startDwell = () => { if (!document.hidden) shownAt = performance.now(); };
  function flushDwell() {
    if (shownAt == null) return;
    const ms = Math.round(performance.now() - shownAt);
    shownAt = null;
    if (ms >= 500) logView('dwell', { value: ms });
  }

  /* ---------- data ---------- */
  async function load() {
    const d = state.date;
    const [overview, repository, trend, summary, commits, flags, contributors, prediction, recent] = await Promise.all([
      get('/overview'), get('/repository'), get(`/trend?days=${state.range}`), get(`/summaries/${d}`), get(`/commits?date=${d}`),
      get(`/flags?date=${d}`), get(`/contributors?date=${d}`), get('/prediction'), get('/flags?limit=5'),
    ]);
    CD.ctx = { overview, repository };
    return { overview, repository, trend, summary, commits, flags, contributors, prediction, recent };
  }

  /* ---------- repository area: single panel or several cards ---------- */
  function repoArea(o, r) {
    if (!o.repo) {
      return `<section class="card" data-tour="status"><div class="card-head"><h2>Connect your repository</h2></div>
        <p class="hint">Commit Doctor follows a GitHub repository and turns each day's commits into a short summary. Public repositories need no token.</p>
        <p style="margin-top:12px"><button class="btn btn-primary" data-open="connect">${ic('plus', 14)} Connect repository</button></p>
        <p class="note" style="margin-top:12px">Just trying it out? Run <code>npm run seed</code> to load two weeks of demo data.</p></section>`;
    }
    if (o.repo_mode === 'multi') {
      const cards = o.repositories.filter((x) => x.active || x.shown).map((x) => `<button type="button" class="card repo" data-switch="${esc(x.repo)}"${x.shown ? ' aria-current="true"' : ''}>
        <div class="repo-top"><strong>${esc(x.repo)}</strong><span class="status-dot${x.shown ? '' : ' idle'}" aria-hidden="true"></span></div>
        <div class="repo-lang"><i style="--c:${x.method === 'poll' ? '#A855F7' : '#22D3EE'}"></i>${x.method === 'poll' ? 'Checked with a token' : 'Webhook / public scan'}</div>
        <div class="note">${plural(x.commits, 'commit')}${x.last_commit_at ? ` · last ${esc(CD.ago(x.last_commit_at))}` : ''}${x.shown ? ' · showing' : ''}</div></button>`).join('');
      return `<section class="rail" aria-label="Repositories" data-tour="status">${cards}<button class="repo-add" data-open="connect">${ic('plus', 20)}<span>Connect repository</span></button></section>`;
    }
    const st = CD.repoStatus(r, o);
    return `<section class="card" data-tour="status"><div class="status-line"><span class="status-dot ${st.tone === 'ok' ? '' : st.tone}" aria-hidden="true"></span>
      <div style="flex:1;min-width:0"><a href="https://github.com/${CD.repoPath(o.repo)}" target="_blank" rel="noopener"><strong>${esc(o.repo)}</strong></a>
      <span class="hint" style="display:block">${esc(st.text)}</span></div>
      <div class="field-row">${r.method ? '<button type="button" class="btn" id="scan-btn">' + ic('refresh', 14) + ' Check now</button>' : ''}<a class="btn" href="settings.html">${ic('gear', 14)} Manage</a></div></div></section>`;
  }

  /* ---------- stat cards ---------- */
  function stats(v) {
    const s = v.summary;
    const c = s.comparison;
    const [vs, vsCls] = CD.compareShort(c, s.total_commits);
    let added = 0; let deleted = 0; let known = false; let files = 0; let withFiles = 0;
    for (const cm of v.commits) {
      const n = CD.fileCount(cm.churn);
      if (n != null) { files += n; withFiles += 1; }
      if (cm.churn.lines_added != null && cm.churn.lines_deleted != null) { known = true; added += cm.churn.lines_added; deleted += cm.churn.lines_deleted; }
    }
    let churn;
    let churnNote;
    if (known) { churn = `<span class="add">+${added}</span> <span class="del">−${deleted}</span>`; churnNote = 'Lines added and removed · context only'; }
    else if (withFiles) { churn = `${files}<small>${files === 1 ? 'file' : 'files'}</small>`; churnNote = withFiles < v.commits.length ? `From ${withFiles} of ${plural(v.commits.length, 'commit')}; the rest came from a scan` : 'Files changed · line counts need a token'; }
    else { churn = '—'; churnNote = v.commits.length ? 'Not recorded: these commits came from a scan, which has no file lists' : 'No commits'; }
    const p = v.prediction;
    const pred = CD.PRED[p.status] || [p.status, '#9AA3B5'];
    const people = s.contributors.slice(0, 4).map((x) => avatar(x.name, 24)).join('');
    const ctxNote = '<div class="note">Context only · not a performance measure</div>';
    return `<section class="stats" aria-label="This day at a glance" data-tour="stats">
      <article class="card stat"><div class="stat-label">Commits${CD.help('baseline')}</div><div class="stat-row"><div class="stat-value">${s.total_commits}</div>${CD.spark(v.trend.map((d) => d.commits), '#60A5FA')}</div><div class="note ${vsCls}">${esc(vs)}</div></article>
      <article class="card stat"><div class="stat-label">Code churn${CD.help('churn')}</div><div class="stat-row"><div class="stat-value">${churn}</div>${ic('file', 22, '#A855F7')}</div><div class="note">${esc(churnNote)}</div></article>
      <article class="card stat"><div class="stat-label">Contributors</div><div class="stat-row"><div class="stat-value">${s.contributor_count}<small>active</small></div><span class="stack">${people}</span></div>${ctxNote}</article>
      ${p.deadline_date
        ? `<article class="card stat"><div class="stat-label">Deadline${CD.help('pace')}</div><div class="stat-row"><div class="stat-value" style="font-size:18px">${p.days_remaining >= 0 ? `${p.days_remaining}<small>${p.days_remaining === 1 ? 'day left' : 'days left'}</small>` : esc(CD.dayMed(p.deadline_date))}</div>${pill(pred[0], pred[1])}</div>
          <div class="note">Due ${esc(CD.dayMed(p.deadline_date))}</div></article>`
        : `<article class="card stat"><div class="stat-label">Deadline</div><div class="stat-row"><div class="stat-value" style="font-size:18px">No deadline</div></div>
          <div class="note"><a class="link" href="settings.html">Set one →</a> to see if the pace will make it</div></article>`}</section>`;
  }

  /* ---------- daily summary card (rule-based, not AI) ---------- */
  function summaryCard(v) {
    const s = v.summary;
    const o = v.overview;
    let prov;
    if (o.totals.commits === 0) prov = 'No commits recorded yet';
    else if (s.source === 'saved') prov = `Saved ${CD.stamp(s.generated_at)} ${TRIGGER[s.trigger] || ''}`;
    else if (state.date >= o.today) prov = 'Live · saved after midnight';
    else prov = 'Computed live (not saved)';
    const canSave = o.totals.commits > 0 && s.total_commits > 0;
    return `<section class="ai" aria-labelledby="sum-h" data-tour="summary"><div class="ai-title"><span class="ai-icon">${ic('note', 18)}</span><h2 id="sum-h">Daily summary</h2>${CD.help('summary')}${pill(prov, '#9AA3B5')}</div>
      <p id="sum-text">${esc(s.headline)}</p>
      <div class="ai-foot">${CD.intentPills(s.intents)}${Object.keys(s.intents || {}).length ? CD.help('intent') : ''}<span class="spacer"></span>
        ${canSave ? `<button class="btn" id="save-btn">${ic('save', 14)} ${s.source === 'saved' ? 'Update saved summary' : 'Save summary now'}</button>` : ''}
        <button class="btn" data-copy="#sum-text">${ic('copy', 14)} Copy</button></div>
    </section>`;
  }

  /* ---------- view 1: Digest ---------- */
  function digest(v) {
    const s = v.summary;
    const c = s.comparison;
    const items = [];
    if (s.total_commits === 0) items.push(['', 'No commits on this day.']);
    else {
      const phrase = CD.comparePhrase(c, s.total_commits);
      items.push(['', `${plural(s.total_commits, 'commit')} from ${plural(s.contributor_count, 'contributor')}${phrase ? `, ${phrase}` : ''}.`]);
      const top = s.contributors[0];
      items.push(['', s.contributor_count > 1 ? `${top.name} was the most active, with ${plural(top.commits, 'commit')}.` : `All of it by ${top.name}.`]);
    }
    const quietAfter = v.overview.rules.comparison_days;
    for (const q of v.contributors.filter((x) => x.idle_days >= quietAfter)) items.push(['bad', `${q.name} hasn't committed in ${plural(q.idle_days, 'day')} (last on ${CD.dayMed(q.last_date)}).`]);
    const p = v.prediction;
    if (p.deadline_date) items.push([p.status === 'on-pace' ? 'ok' : p.status === 'at-risk' || p.status === 'behind' ? 'bad' : '', CD.predictionText(p)]);

    const vs = c.trend === 'no-baseline' ? '—' : c.average != null ? `${c.average}/day` : '—';
    const tiles = [['Commits', s.total_commits], ['Contributors', s.contributor_count], [`Usual (last ${c.baseline_days || quietAfter} days)`, vs],
      ['Days to deadline', p.deadline_date && p.days_remaining >= 0 ? p.days_remaining : '—']];
    const flags = v.flags.filter((f) => f.type !== 'contributor_inactive');
    const flagList = flags.length
      ? flags.map((f) => { const [label, icon, color] = CD.flagMeta(f.type); return `<div class="flag-item"><span class="tile" style="--c:${color}">${ic(icon, 16)}</span><div><b>${esc(label)}</b><small>${esc(f.detail)}</small></div></div>`; }).join('')
      : `<p class="note" style="padding:8px 0">${s.source === 'saved' ? 'Nothing unusual on this day.' : "Activity flags are checked when the day's summary is saved."}</p>`;
    return `<ul class="digest-list">${items.map(([t, x]) => `<li${t ? ` data-tone="${t}"` : ''}>${esc(x)}</li>`).join('')}</ul>
      <div class="tiles">${tiles.map(([k, x]) => `<div class="tile-box"><b>${esc(x)}</b><span>${esc(k)}</span></div>`).join('')}</div>
      <h3 class="stat-label" style="margin-bottom:4px">Flags${CD.help('flag')}</h3>${flagList}`;
  }

  /* ---------- view 2: Team (commits that day; everyone with history, 0 if none) ---------- */
  function team(v) {
    const day = new Map(v.summary.contributors.map((c) => [c.name, c]));
    const people = v.contributors.map((p) => ({ ...p, day: day.get(p.name) || null }));
    for (const c of v.summary.contributors) if (!people.some((p) => p.name === c.name)) people.push({ name: c.name, display_name: c.display_name, idle_days: 0, commits_7d: c.commits, day: c });
    if (!people.length) return '<p class="empty">Nobody has committed yet.</p>';
    people.sort((a, b) => (b.day ? b.day.commits : 0) - (a.day ? a.day.commits : 0) || a.idle_days - b.idle_days || a.name.localeCompare(b.name));
    const quietAfter = v.overview.rules.comparison_days;
    // What each person worked on that day, from the intent of their commits.
    const areas = new Map();
    for (const c of v.commits) {
      const k = c.is_merge ? 'merge' : c.intent && c.intent.intent;
      if (!k) continue;
      const m = areas.get(c.contributor) || {};
      m[k] = (m[k] || 0) + 1;
      areas.set(c.contributor, m);
    }
    return `<div class="people">${people.map((p) => {
      const d = p.day;
      const n = d ? d.commits : 0;
      let badge;
      if (d) badge = pill('Active this day', '#34D399');
      else if (p.idle_days >= quietAfter) badge = pill(`Inactive ${plural(p.idle_days, 'day')}`, '#F59E0B');
      else badge = pill(`Last commit ${CD.dayMed(p.last_date)}`, '#9AA3B5');
      const span = d ? (d.first_time === d.last_time ? d.first_time : `${d.first_time}–${d.last_time}`) : '';
      const lines = d && d.lines_changed != null ? `<span><span class="add">+${d.lines_added}</span> <span class="del">−${d.lines_deleted}</span></span>` : '';
      return `<article class="person-card${d ? '' : ' idle'}"><div class="person-head">${avatar(p.name, 32)}<div class="who"><b>${esc(p.name)}</b>${p.display_name && p.display_name !== p.name ? `<small>${esc(p.display_name)}</small>` : ''}</div>${badge}</div>
        <div class="person-num"><b>${n}</b><span>${n === 1 ? 'commit' : 'commits'} this day</span></div>
        ${areas.get(p.name) ? `<div class="chips">${CD.intentPills(areas.get(p.name), 3)}</div>` : ''}
        <div class="person-meta">${[span && `<span>Active ${esc(span)}</span>`, lines, `<span>${plural(p.commits_7d, 'commit')} in the last 7 days</span>`].filter(Boolean).join('')}</div></article>`;
    }).join('')}</div><p class="note" style="margin-top:12px">Shows who worked on what, to help coordination. Commit counts are context, not a performance measure. "Inactive" means no commits for ${plural(quietAfter, 'day')} or more.</p>`;
  }

  /* ---------- view 3: Timeline (time of day) ---------- */
  function timeline(v) {
    const s = v.summary;
    const h = s.hourly;
    const max = Math.max(1, ...h);
    const desc = h.map((n, i) => (n ? `${CD.hh(i)}: ${n}` : null)).filter(Boolean).join(', ') || 'no commits';
    const vitals = [['First commit', s.first_commit_time || '—'], ['Last commit', s.last_commit_time || '—'], ['Busiest hour', s.peak_hour == null ? '—' : CD.hh(s.peak_hour)], ['Merge commits', s.merge_commits]];
    const commits = [...v.commits].reverse();
    const groups = commits.length ? PERIODS.map(([name, from, to]) => {
      const list = commits.filter((c) => { const hr = Number(String(c.time).slice(0, 2)); return hr >= from && hr <= to; });
      return list.length ? `<div class="period">${name} <span>· ${CD.hh(from)}–${String(to).padStart(2, '0')}:59 · ${plural(list.length, 'commit')}</span></div>${list.map(CD.feedItem).join('')}` : '';
    }).join('') : '<p class="empty">No commits on this day.</p>';
    return `<div class="hours" role="img" aria-label="Commits by hour of day. ${esc(desc)}">${h.map((n, i) => `<i data-n="${n}" title="${CD.hh(i)}, ${plural(n, 'commit')}" style="height:${(n / max) * 100}%"></i>`).join('')}</div>
      <div class="hour-scale" aria-hidden="true"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
      <div class="tiles">${vitals.map(([k, x]) => `<div class="tile-box"><b>${esc(x)}</b><span>${esc(k)}</span></div>`).join('')}</div>${groups}`;
  }

  /* ---------- side: commits per day and notable changes ---------- */
  function trendCard(v) {
    const seg = RANGES.map((n) => `<button type="button" data-range="${n}" aria-pressed="${n === state.range}">${n}d</button>`).join('');
    return `<section class="card" data-tour="trend"><div class="card-head"><h2>Commits per day</h2><div class="seg" role="group" aria-label="Range">${seg}</div></div>
      ${CD.dayBars(v.trend, state.date)}<p class="note" style="margin-top:14px">Select a day to read it. A green dot means its summary was saved.</p></section>`;
  }
  function notable(v) {
    const list = v.recent.length ? v.recent.map((f) => {
      const [label, icon, color] = CD.flagMeta(f.type);
      return `<a class="notif" href="index.html?date=${esc(f.date)}"><span class="tile" style="--c:${color}">${ic(icon, 16)}</span><div><b>${esc(label)}</b><small>${esc(CD.dayMed(f.date))} · ${esc(f.detail)}</small></div>${f.id > CD.seenId() ? '<span class="unread-dot" title="Unread"></span>' : ''}</a>`;
    }).join('') : '<p class="note" style="padding:8px 0">No flags yet. They appear when a saved day stands out from the recent baseline.</p>';
    return `<section class="card glass" data-tour="notable"><div class="card-head"><h2>Notable changes${CD.help('flag')}</h2></div>${list}<div style="padding-top:12px"><a class="link" href="notifications.html">View all notifications →</a></div></section>`;
  }

  /* ---------- file changes (hideable) ---------- */
  function filesCard(v) {
    let a = 0; let m = 0; let r = 0; let la = 0; let ld = 0; let known = false; let withFiles = 0;
    for (const c of v.commits) {
      if (CD.fileCount(c.churn) != null) withFiles += 1;
      a += c.churn.files_added || 0; m += c.churn.files_modified || 0; r += c.churn.files_removed || 0;
      if (c.churn.lines_added != null && c.churn.lines_deleted != null) { known = true; la += c.churn.lines_added; ld += c.churn.lines_deleted; }
    }
    const max = Math.max(1, a, m, r);
    const row = (label, n, cls) => `<div class="file-row"><span class="${cls}">${label}</span><div class="track"><i style="--w:${Math.round((n / max) * 100)}%"></i></div><span class="count">${n}</span></div>`;
    const body = !v.commits.length ? '<p class="note">No commits on this day.</p>'
      : !withFiles ? `<p class="hint">${esc(CD.NO_FILES.replace('this commit was', "this day's commits were"))}</p>`
      : `${withFiles < v.commits.length ? `<p class="hint" style="margin-bottom:8px">From ${withFiles} of ${plural(v.commits.length, 'commit')}; the others came from a scan, which has no file lists.</p>` : ''}${row('Files added', a, 'add')}${row('Files modified', m, '')}${row('Files removed', r, 'del')}
        <p class="hint" style="margin-top:10px">${known ? `Lines: <span class="add">+${la}</span> <span class="del">−${ld}</span> (where known)` : 'Line counts are only recorded for repositories checked with a token.'}</p>`;
    return CD.hideable('File changes', body, 'Counts across this day\'s commits. Only commit metadata is recorded, never file contents.');
  }

  /* ---------- first-run explainer (until dismissed in this browser) ---------- */
  function intro(o) {
    if (CD.store.get('comdoc.introDismissed') === '1') return '';
    const n = o.rules.comparison_days;
    return `<section class="card glass" id="intro" aria-labelledby="intro-h"><div class="card-head"><h2 id="intro-h">How Commit Doctor works</h2><div class="field-row"><button type="button" class="btn btn-primary" data-tour-start>${ic('guide', 14)} Take the tour</button><button type="button" class="btn" id="intro-close">Got it, hide this</button></div></div>
      <div class="intro">
        <div><h3>1. Commits come in</h3><p>From GitHub, instantly by webhook or by checking every few minutes. Only commit details are kept (who, when, message, file counts), never the code.</p></div>
        <div><h3>2. Each day gets a summary</h3><p>Written by fixed rules, not AI. Today stays live and is saved after midnight. Read it three ways with the Digest, Team and Timeline tabs.</p></div>
        <div><h3>3. Flags point out changes</h3><p>A saved day well above or below the usual, someone with no commits for ${plural(n, 'day')}, or a slipping deadline pace. Subscribers get them by email.</p></div>
        <div><h3>Context, not scores</h3><p>The numbers help the team stay in sync; nothing here ranks or rates people. Look for ${CD.help('baseline').replace('class="help"', 'class="help" tabindex="-1"')} next to a term for a plain explanation.</p></div>
      </div></section>`;
  }

  /* ---------- render ---------- */
  function render(main, v) {
    const o = v.overview;
    const tabs = VIEWS.map((x) => `<button type="button" role="tab" id="tab-${x}" aria-controls="panel-${x}" aria-selected="${x === state.view}" tabindex="${x === state.view ? 0 : -1}" data-view="${x}">${x[0].toUpperCase()}${x.slice(1)}</button>`).join('');
    const panels = [['digest', digest(v)], ['team', team(v)], ['timeline', timeline(v)]]
      .map(([x, html]) => `<div role="tabpanel" id="panel-${x}" aria-labelledby="tab-${x}" tabindex="0"${x === state.view ? '' : ' hidden'}>${html}</div>`).join('');
    main.innerHTML = CD.pageHead(CD.dayLong(state.date), o.repo ? `${o.repo} · times in ${o.timezone}` : `Times in ${o.timezone}`, CD.dayNav(state.date)) +
      (o.repo ? intro(o) : '') + repoArea(o, v.repository) +
      (o.repo || o.totals.commits ? stats(v) + summaryCard(v) +
        `<div class="cols cols-feed"><section class="card solid" aria-label="Day views" data-tour="views"><div class="card-head"><div class="tabs pills" role="tablist" aria-label="How to show this day">${tabs}</div></div>${panels}
          <div class="feedback" id="feedback"><span id="fb-q"></span><button type="button" class="fb-btn" data-value="1" aria-pressed="false" aria-label="Yes, helpful">👍</button><button type="button" class="fb-btn" data-value="0" aria-pressed="false" aria-label="No, not helpful">👎</button><span id="fb-thanks" hidden>Thanks!</span></div></section>
          <div class="stack-col">${trendCard(v)}${notable(v)}</div></div>` + filesCard(v) : '') +
      '<p class="footnote">Commit Doctor helps your team stay in sync. It never scores or ranks people.</p>';
    renderFeedback();
  }

  const fbKey = () => `commitdoctor.fb.${state.view}.${state.date}`;
  function renderFeedback() {
    const q = $('#fb-q');
    if (!q) return;
    const chosen = CD.store.get(fbKey());
    q.textContent = `Was the ${state.view[0].toUpperCase()}${state.view.slice(1)} view helpful for this day?`;
    for (const b of $$('.fb-btn')) b.setAttribute('aria-pressed', String(b.dataset.value === chosen));
    $('#fb-thanks').hidden = chosen == null;
  }

  function showView(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) view = 'digest';
    const changed = view !== state.view;
    if (changed) flushDwell();
    state.view = view;
    CD.store.set('commitdoctor.view', view);
    for (const x of VIEWS) {
      const tab = $(`#tab-${x}`);
      if (!tab) return;
      tab.setAttribute('aria-selected', String(x === view));
      tab.tabIndex = x === view ? 0 : -1;
      $(`#panel-${x}`).hidden = x !== view;
    }
    if (focus) $(`#tab-${view}`).focus();
    renderFeedback();
    if (changed || shownAt == null) { logView('open'); startDwell(); }
  }

  async function refresh(main, { force = false } = {}) {
    const v = await load();
    const key = JSON.stringify([v.overview.totals, v.overview.last_saved_date, v.repository, v.trend, v.summary, v.commits, v.flags, v.contributors, v.prediction, v.recent, state.date, state.range]);
    if (!force && key === state.key) return;
    state.key = key;
    const focusId = document.activeElement && document.activeElement.id;
    render(main, v);
    if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  }

  CD.start('dashboard', async (main) => {
    state.date = CD.initialDate();
    const fromUrl = new URLSearchParams(window.location.search).get('view');
    state.view = VIEWS.includes(fromUrl) ? fromUrl : (CD.store.get('commitdoctor.view') || 'digest');
    await refresh(main, { force: true });
    logView('open');
    startDwell();

    const pick = (d) => {
      if (d === state.date) return;
      flushDwell();
      state.date = d;
      CD.setDateParam(d);
      refresh(main, { force: true }).then(() => { logView('open'); startDwell(); }).catch((e) => toast(e.message));
    };
    CD.wireDayNav(main, () => state.date, pick);
    main.addEventListener('click', async (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.dataset.view) showView(t.dataset.view);
      if (t.dataset.date) pick(t.dataset.date);
      if (t.dataset.switch && !t.hasAttribute('aria-current')) CD.switchRepo(t.dataset.switch);
      if (t.dataset.range) { state.range = Number(t.dataset.range); CD.store.set('comdoc.range', String(state.range)); refresh(main, { force: true }); }
      if (t.classList.contains('fb-btn')) { CD.store.set(fbKey(), t.dataset.value); logView('feedback', { value: Number(t.dataset.value) }); renderFeedback(); }
      if (t.id === 'intro-close') { CD.store.set('comdoc.introDismissed', '1'); const el = $('#intro'); if (el) el.remove(); return; }
      if (t.id === 'save-btn') {
        t.disabled = true;
        const r = await act(() => send(`/summaries/${state.date}/generate`, 'POST'));
        if (r) { toast(state.date >= CD.today() ? 'Saved. Today stays live and is saved again after midnight.' : 'Summary saved.'); await refresh(main, { force: true }); } else t.disabled = false;
      }
      if (t.id === 'scan-btn') {
        t.disabled = true;
        const r = await act(() => send('/repository/scan', 'POST'));
        if (r) { toast('Checked GitHub.'); await refresh(main, { force: true }); } else t.disabled = false;
      }
    });
    main.addEventListener('keydown', (e) => {
      if (!e.target.closest('[role="tablist"]')) return;
      const i = VIEWS.indexOf(state.view);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: VIEWS.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      showView(VIEWS[(next + VIEWS.length) % VIEWS.length], { focus: true });
    });
    document.addEventListener('visibilitychange', () => (document.hidden ? flushDwell() : startDwell()));
    window.addEventListener('pagehide', flushDwell);
    setInterval(() => { if (!document.hidden) refresh(main).catch(() => {}); }, 30000);
  }, { title: 'Dashboard' });
})();
