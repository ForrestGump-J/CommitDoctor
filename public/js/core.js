/* Commit Doctor: shared shell and helpers for every dashboard page.
   Each page script calls CD.start(pageKey, render). All interpolated values go
   through esc(), since commit messages and names are untrusted text. */
(function () {
  'use strict';

  const A = window.ComDocApi;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
  const repoPath = (repo) => String(repo).split('/').map(encodeURIComponent).join('/');

  // Per-browser conveniences only (remembered tab, unread markers); never required.
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  /* ---------- icons ---------- */
  const ICON = {
    dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    repo: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
    commit: '<circle cx="12" cy="12" r="3"/><path d="M3 12h6M15 12h6"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    chart: '<path d="M3 3v18h18M18 17V9M13 17V5M8 17v-3"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
    flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21.5h11.6a2 2 0 0 0 1.7-3L14 9V3"/><path d="M7 15h10"/>',
    spark: '<path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z"/>',
    note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
    alert: '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    crit: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9z"/><path d="M12 8v4M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    up: '<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/>',
    branch: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 8v8M18 10c0 5-12 2-12 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    act: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    right: '<path d="M9 6l6 6-6 6"/>',
    left: '<path d="M15 6l-6 6 6 6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    ext: '<path d="M7 17L17 7M8 7h9v9"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  };
  const ic = (k, size, color) => `<svg class="ic" width="${size || 18}" height="${size || 18}" viewBox="0 0 24 24" fill="none" stroke="${color || 'currentColor'}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

  /* ---------- people, pills, intent tags ---------- */
  const PALETTE = [['#6366F1', '#FFFFFF'], ['#22D3EE', '#0B0D12'], ['#A855F7', '#0B0D12'], ['#F59E0B', '#0B0D12'], ['#34D399', '#0B0D12'], ['#60A5FA', '#0B0D12'], ['#F87171', '#0B0D12']];
  const colorFor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  const initials = (name) => {
    const parts = String(name || '?').replace(/[^A-Za-z0-9 ._-]/g, '').split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : (parts[0] || '').slice(1, 2))).toUpperCase();
  };
  const avatar = (name, s = 28) => {
    const [c, ink] = colorFor(name);
    return `<span class="avatar" style="--c:${c};--ink:${ink};--s:${s}px" title="${esc(name)}">${esc(initials(name))}</span>`;
  };
  const pill = (t, c, cls) => `<span class="pill ${cls || ''}" style="--c:${c || '#9AA3B5'}">${esc(t)}</span>`;

  const INTENT = { feature: '#60A5FA', fix: '#F59E0B', refactor: '#A855F7', test: '#34D399', docs: '#9AA3B5', chore: '#22D3EE', merge: '#F87171' };
  const INTENT_WORD = { feature: 'Features', fix: 'Fixes', refactor: 'Refactoring', test: 'Tests', docs: 'Docs', chore: 'Chores', merge: 'Merges' };
  function intentTag(c) {
    if (c.is_merge) return pill('merge', INTENT.merge, 'intent');
    const it = c.intent;
    if (!it) return '';
    const title = it.sure ? `Likely ${it.intent}: the classifier's label from the commit message` : `Maybe ${it.intent}: the classifier isn't sure, so treat this as a guess`;
    return `<span class="pill intent${it.sure ? '' : ' unsure'}" style="--c:${INTENT[it.intent] || '#9AA3B5'}" title="${esc(title)}">${esc(it.intent)}${it.sure ? '' : '?'}</span>`;
  }
  /** Intent counts as pills, most common first. */
  const intentPills = (intents, limit = 4) => Object.entries(intents || {}).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([k, n]) => pill(`${INTENT_WORD[k] || k} · ${n}`, INTENT[k])).join('');

  /* ---------- dates ---------- */
  const utcNoon = (d) => new Date(`${d}T12:00:00Z`);
  const shift = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const dayLong = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', ...(CD.ctx && d.slice(0, 4) !== CD.today().slice(0, 4) ? { year: 'numeric' } : {}) });
  const dayMed = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const dayShort = (d) => utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' });
  const stamp = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: CD.ctx ? CD.ctx.overview.timezone : undefined, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
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

  /* ---------- API ---------- */
  const fail = (r) => { const e = new Error(r.message || r.error || 'Request failed'); e.status = r.status; e.data = r.data; e.kind = r.kind; return e; };
  /** Read: no auth flow. Throws on failure. */
  async function get(path) {
    const r = await A.request(path);
    if (!r.ok) throw fail(r);
    return r.data;
  }
  /** Write: asks for the admin token when needed. Throws on failure ("cancelled" if the user closes the token box). */
  async function send(path, method = 'POST', body) {
    const r = await A.api(path, { method, body });
    if (!r.ok) throw fail(r);
    return r.data ?? true; // 204 No Content still counts as success
  }
  /** Run a write and toast its error (network, server and wrong-token errors are already toasted by api.js). */
  async function act(fn) {
    try { return await fn(); } catch (err) {
      if (!['cancelled', 'network', 'server', 'wrong_token'].includes(err.kind)) toast(err.message);
      return undefined;
    }
  }

  /* ---------- toast, copy, flash ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy is not available in this browser.'); }
  }
  // A message that survives the reload after switching or connecting a repository.
  const flash = (msg) => { try { window.sessionStorage.setItem('comdoc.flash', msg); } catch { /* ignore */ } };
  const takeFlash = () => { try { const m = window.sessionStorage.getItem('comdoc.flash'); window.sessionStorage.removeItem('comdoc.flash'); return m; } catch { return null; } };

  /* ---------- charts (inline SVG) ---------- */
  function spark(vals, color) {
    if (!vals.length) return '';
    const max = Math.max(1, ...vals);
    const st = 60 / Math.max(1, vals.length - 1);
    const d = vals.map((v, i) => `${i ? 'L' : 'M'}${(2 + i * st).toFixed(1)} ${(24 - (v / max) * 20).toFixed(1)}`).join('');
    return `<svg width="64" height="28" viewBox="0 0 64 28" fill="none" aria-hidden="true"><path d="${d}" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  function area(vals, label, color = '#6366F1') {
    const w = 396; const h = 110; const m = Math.max(1, ...vals); const st = w / Math.max(1, vals.length - 1);
    const line = vals.map((v, i) => `${i ? 'L' : 'M'}${(i * st).toFixed(1)} ${(h - 8 - (v / m) * (h - 24)).toFixed(1)}`).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><path d="${line}L${w} ${h}L0 ${h}Z" fill="${color}" fill-opacity=".2"/><path d="${line}" stroke="${color}" stroke-width="2" fill="none"/></svg>`;
  }
  function bars(vals, label, color = '#6366F1') {
    const w = 396; const h = 64; const m = Math.max(1, ...vals); const slot = w / Math.max(1, vals.length);
    const bw = Math.min(22, slot * 0.6);
    const rects = vals.map((v, i) => { const a = (v / m) * (h - 4); return `<rect x="${(i * slot + slot / 2 - bw / 2).toFixed(1)}" y="${(h - a).toFixed(1)}" width="${bw.toFixed(1)}" height="${a.toFixed(1)}" rx="3" fill="${color}" fill-opacity=".75"/>`; }).join('');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}">${rects}</svg>`;
  }
  /** Commits per day as buttons: click one to read that day. */
  function dayBars(trend, selected) {
    const max = Math.max(1, ...trend.map((d) => d.commits));
    const every = trend.length > 16 ? Math.ceil(trend.length / 10) : 1;
    const barsHtml = trend.map((d) => {
      const label = `${dayLong(d.date)}: ${plural(d.commits, 'commit')}${d.saved ? ', summary saved' : ''}`;
      return `<button type="button" class="daybar" data-date="${d.date}" aria-pressed="${d.date === selected}" aria-label="${esc(label)}" title="${esc(label)}">
        ${d.commits ? `<b>${d.commits}</b>` : ''}<i style="--h:${(d.commits / max) * 100}%"></i></button>`;
    }).join('');
    // Month name on the first label and wherever the month changes ("Nov 9 … 30 Dec 1 …").
    const newMonth = (i) => i === 0 || trend[i].date.slice(5, 7) !== trend[i - 1].date.slice(5, 7);
    const forced = trend.map((d, i) => newMonth(i));
    const near = (i) => forced.some((f, j) => f && j !== i && Math.abs(j - i) < Math.max(2, every));
    const label = (d, i) => {
      if (d.is_today) return 'Today';
      const show = forced[i] || i === 0 || (i % every === 0 && !near(i));
      if (!show) return '';
      return newMonth(i) ? dayMed(d.date) : String(Number(d.date.slice(8)));
    };
    const scale = trend.map((d, i) => `<span class="${d.saved ? 'saved' : ''}">${esc(label(d, i))}</span>`).join('');
    return `<div class="daybars" style="--n:${trend.length}">${barsHtml}</div><div class="daybar-scale" style="--n:${trend.length}" aria-hidden="true">${scale}</div>`;
  }

  /* ---------- shared fragments ---------- */
  /** "+12 −3" when line counts are known, otherwise ''. */
  const churnText = (ch) => (ch && ch.lines_added != null && ch.lines_deleted != null
    ? `<span class="add">+${Number(ch.lines_added)}</span> <span class="del">−${Number(ch.lines_deleted)}</span>` : '');
  /** Files touched, or null when GitHub didn't send a file list (commits found by a scan). */
  const fileCount = (ch) => (ch && (ch.files_added != null || ch.files_modified != null || ch.files_removed != null)
    ? (ch.files_added || 0) + (ch.files_modified || 0) + (ch.files_removed || 0) : null);
  const NO_FILES = 'GitHub only sends file lists with webhook pushes and token checks; this commit was found by a scan.';
  const filesText = (ch) => {
    const n = fileCount(ch);
    return n == null ? `<span title="${esc(NO_FILES)}">files not recorded</span>` : plural(n, 'file');
  };
  function feedItem(c) {
    const first = String(c.message || '').split('\n')[0] || '(no message)';
    const color = c.is_merge ? INTENT.merge : INTENT[c.intent && c.intent.intent] || '#9AA3B5';
    return `<a class="feed-item" href="commit.html?sha=${encodeURIComponent(c.sha)}"><span class="node" style="--c:${color}"></span>${avatar(c.contributor)}
      <div class="fi-body"><strong>${esc(first)}</strong><div class="meta">${intentTag(c)}${pill(c.short_sha || String(c.sha).slice(0, 7), '#9AA3B5', 'mono')}
      <span>${esc(c.contributor)}${c.branch ? ` on ${esc(c.branch)}` : ''}</span><span>${filesText(c.churn)}</span>${churnText(c.churn) ? `<span>${churnText(c.churn)}</span>` : ''}<span>${esc(c.time || '')}</span></div></div>
      <span class="fi-go">${ic('right', 16)}</span></a>`;
  }
  const FLAG = {
    activity_above_baseline: ['Activity above baseline', 'up', '#60A5FA', 'activity'],
    activity_below_baseline: ['Activity below baseline', 'alert', '#F59E0B', 'activity'],
    contributor_inactive: ['Contributor inactive', 'users', '#22D3EE', 'inactivity'],
    deadline_at_risk: ['Deadline at risk', 'alert', '#F59E0B', 'deadline'],
    deadline_behind: ['Behind deadline pace', 'crit', '#F87171', 'deadline'],
  };
  const flagMeta = (type) => FLAG[type] || [type, 'info', '#9AA3B5', 'other'];
  const PRED = {
    'on-pace': ['On pace', '#34D399'], 'at-risk': ['At risk', '#F59E0B'], behind: ['Behind pace', '#F87171'],
    'deadline-passed': ['Deadline passed', '#9AA3B5'], 'insufficient-data': ['Not enough history yet', '#9AA3B5'], 'no-deadline': ['No deadline set', '#9AA3B5'],
  };
  /** One sentence about the deadline prediction. */
  function predictionText(p) {
    if (!p || p.status === 'no-deadline') return 'No deadline set for this repository.';
    const when = dayMed(p.deadline_date);
    const left = plural(Math.abs(p.days_remaining), 'day');
    if (p.status === 'insufficient-data') return `Deadline ${when} (${left} left). Not enough history yet to judge the pace.`;
    if (p.status === 'deadline-passed') return `The ${when} deadline passed ${left} ago.`;
    const pace = p.recent_commit_rate >= p.earlier_commit_rate
      ? `averaging ${p.recent_commit_rate} commits a day over the last ${plural(p.window_days, 'day')}, matching or beating the earlier ${p.earlier_commit_rate}`
      : `averaging ${p.recent_commit_rate} commits a day over the last ${plural(p.window_days, 'day')}, down from ${p.earlier_commit_rate} before that`;
    const churn = p.churn_ratio != null && p.churn_ratio > 0.6 ? ` Recent changes are ${Math.round(p.churn_ratio * 100)}% removals or rework.` : '';
    return `${PRED[p.status][0]} for the ${when} deadline (${left} left): ${pace}.${churn}`;
  }

  /* ---------- comparing a day with its baseline (same rules as src/summary.js) ---------- */
  /** "40% above the 7-day average", "well above the usual 0.3 a day", "about 6× the usual 1.2 a day"… */
  function comparePhrase(c, total) {
    const avg = c.average;
    if (c.trend === 'above') {
      if (!avg) return `after a quiet ${c.baseline_days}-day stretch`;
      if (avg < 1) return `well above the usual ${avg} a day`;
      if (total / avg >= 3) return `about ${Math.round(total / avg)}× the usual ${avg} a day`;
      return `${c.delta_pct}% above the ${c.baseline_days}-day average`;
    }
    if (c.trend === 'below') return `${Math.abs(c.delta_pct)}% below the ${c.baseline_days}-day average`;
    if (c.trend === 'steady') return `about the usual for the last ${c.baseline_days} days`;
    return '';
  }
  /** Short form for stat cards and tiles: [text, tone]. */
  function compareShort(c, total) {
    if (c.trend === 'no-baseline') return ['No baseline yet', ''];
    const usual = c.average != null ? `${c.average}/day` : '';
    if (c.trend === 'steady') return [`About usual (${usual})`, ''];
    if (c.trend === 'below') return [`${c.delta_pct}% vs usual ${usual}`, 'trend-down'];
    if (!c.average) return ['Up after a quiet stretch', 'trend-up'];
    if (c.average < 1) return [`Well above usual (${usual})`, 'trend-up'];
    if (total / c.average >= 3) return [`About ${Math.round(total / c.average)}× usual (${usual})`, 'trend-up'];
    return [`+${c.delta_pct}% vs usual ${usual}`, 'trend-up'];
  }

  /* ---------- plain-language explanations ("?" next to a term) ---------- */
  function glossary(key) {
    const n = CD.ctx ? CD.ctx.overview.rules.comparison_days : 7;
    return {
      baseline: `The usual amount of activity: the average commits per day over the previous ${n} days (or since the first commit, if that's more recent). Each day is compared with it, and only differences of a few commits or more count.`,
      flag: `A note Commit Doctor raises when a saved day stands out: activity well above or below the baseline, someone with no commits for ${n} days or more, or the deadline pace slipping. Subscribers get them by email.`,
      churn: 'How much code changed. Lines added and removed are known for repositories checked with a token; otherwise it shows files changed. Context only, not a measure of output.',
      rework: 'The share of recent changes that were removals (lines, or files when lines are unknown). A high share suggests rework rather than new progress.',
      pace: 'Commits per day over the last week compared with the project\'s earlier rate. 75% or more is on pace, 40–75% at risk, under 40% behind. Heavy rework lowers "on pace" to "at risk". A simple rule, not a forecast.',
      intent: 'What kind of work a commit is (feature, fix, docs, …), guessed from its message by a small classifier. A "?" means it isn\'t sure. Labels without "?" were right about 8 times in 10 in testing.',
      summary: 'Written by fixed rules from the day\'s commits, not by AI: the same commits always give the same summary. Today stays live; each day is saved after midnight.',
      inactive: `No commits for ${n} days or more. Shown to help coordination, not to judge anyone.`,
    }[key] || '';
  }
  /** A small "?" that explains a term on hover, focus or tap. */
  const help = (key) => `<button type="button" class="help" data-help="${esc(glossary(key))}" aria-label="${esc(`What does this mean? ${glossary(key)}`)}">?</button>`;
  function wireHelp() {
    const tip = document.createElement('div');
    tip.className = 'help-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);
    let owner = null;
    const show = (el) => {
      owner = el;
      tip.textContent = el.dataset.help;
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
      const below = r.bottom + 8 + tip.offsetHeight < window.innerHeight;
      tip.style.left = `${x}px`;
      tip.style.top = `${below ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`;
    };
    const hide = () => { owner = null; tip.hidden = true; };
    document.addEventListener('pointerover', (e) => { const h = e.target.closest('.help'); if (h) show(h); else if (owner && e.pointerType === 'mouse') hide(); });
    document.addEventListener('focusin', (e) => { const h = e.target.closest('.help'); if (h) show(h); else hide(); });
    document.addEventListener('click', (e) => { const h = e.target.closest('.help'); if (h) { e.preventDefault(); if (owner === h && !tip.hidden) hide(); else show(h); } else hide(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', hide, { passive: true });
  }

  /* ---------- connection status of the shown repository ---------- */
  function repoStatus(r, o) {
    if (!r || !r.repo) return { tone: 'idle', text: 'No repository connected' };
    if (r.method === 'poll') {
      if (r.poll.last_error) return { tone: 'bad', text: `The last check failed: ${r.poll.last_error}` };
      if (r.poll.last_polled_at) return { tone: 'ok', text: `Checked GitHub ${ago(r.poll.last_polled_at)} · every ${plural(r.poll.interval_minutes, 'minute')} with a read-only token` };
      return { tone: 'warn', text: 'Waiting for the first check' };
    }
    const w = r.webhook;
    if (w.state === 'failing') return { tone: 'bad', text: `GitHub reached this server but the delivery was rejected: ${w.detail || 'unknown error'}` };
    if (w.state === 'other_repo') return { tone: 'bad', text: `GitHub is sending pushes from ${w.repo_seen}, which isn't followed here` };
    if (w.state === 'connected') {
      if (o && o.last_push_at) return { tone: 'ok', text: `Updates instantly by webhook · last push ${ago(o.last_push_at)}` };
      // Only GitHub's test ping so far: say where commits actually come from.
      const scan = r.sync && r.sync.last_sync_at
        ? ` New commits are picked up by scanning GitHub${r.sync.interval_minutes ? ` every ${plural(r.sync.interval_minutes, 'minute')}` : ''} (last scan ${ago(r.sync.last_sync_at)}).` : '';
      return { tone: scan ? 'ok' : 'warn', text: `Webhook set up${w.last_ok_at ? ` (GitHub's test ping arrived ${ago(w.last_ok_at)})` : ''}, but no pushes have arrived yet.${scan}` };
    }
    if (r.sync && r.sync.last_error) return { tone: 'bad', text: `The last scan failed: ${r.sync.last_error}` };
    if (r.sync && r.sync.last_sync_at) return { tone: 'ok', text: `Scanned GitHub ${ago(r.sync.last_sync_at)}${r.sync.interval_minutes ? ` · every ${plural(r.sync.interval_minutes, 'minute')}, no token needed` : ''}` };
    return { tone: 'warn', text: 'Waiting for the first scan' };
  }

  /* ---------- unread flags (per browser) and file panels ---------- */
  const seenKey = () => `comdoc.seenFlag.${CD.ctx.overview.repo || 'all'}`;
  const seenId = () => Number(store.get(seenKey()) || 0);
  /** First visit in this browser: only the last 7 days count as unread, not the whole history. */
  function initSeen(flags) {
    if (store.get(seenKey()) != null || !flags.length) return;
    const cutoff = shift(today(), -7);
    const recent = flags.filter((f) => f.date >= cutoff).map((f) => f.id);
    store.set(seenKey(), String(recent.length ? Math.min(...recent) - 1 : Math.max(...flags.map((f) => f.id))));
  }
  const markSeen = (id) => { if (id > seenId()) store.set(seenKey(), String(id)); };
  const filesShown = () => store.get('comdoc.showFiles') === '1';
  const setFilesShown = (on) => store.set('comdoc.showFiles', on ? '1' : '0');
  /** A card whose body can be hidden; the choice is remembered in this browser. */
  function hideable(title, bodyHtml, note) {
    const on = filesShown();
    return `<section class="card solid" data-hideable><div class="card-head"><h2>${esc(title)}</h2>
      <button type="button" class="btn" data-toggle-files aria-expanded="${on}">${on ? 'Hide' : 'Show'} file details</button></div>
      <div data-hideable-body ${on ? '' : 'hidden'}>${bodyHtml}${note ? `<p class="note" style="margin-top:12px">${note}</p>` : ''}</div>
      ${on ? '' : '<p class="note" data-hideable-off>Hidden. File counts per commit come from GitHub; individual file names are not recorded.</p>'}</section>`;
  }

  /* ---------- shell ---------- */
  const NAV = [
    ['dashboard', 'Dashboard', 'index.html', 'dash'], ['repository', 'Repositories', 'repository.html', 'repo'],
    ['commits', 'Commits', 'commit.html', 'commit'], ['notifications', 'Notifications', 'notifications.html', 'bell'],
    ['analytics', 'Analytics', 'analytics.html', 'chart'], ['settings', 'Settings', 'settings.html', 'gear'], ['study', 'Study', 'study.html', 'flask'],
  ];

  function repoSelect(o) {
    const repos = o.repositories || [];
    // Single mode shows only the followed repo (others are hidden; switch back in Settings).
    // Multi mode lists every followed repo, and the dashboard hops between them.
    const list = o.repo_mode === 'multi' ? repos.filter((r) => r.active || r.shown) : repos.filter((r) => r.shown);
    if (!o.repo) return `<button type="button" class="btn btn-primary" data-open="connect">${ic('plus', 14)} Connect repository</button>`;
    return `<div class="select-wrap">${ic('branch', 16)}<label class="visually-hidden" for="repo-select">Repository</label>
      <select id="repo-select"${list.length < 2 ? ' title="Only one repository is followed. Add more in Settings › Multiple repositories."' : ''}>
      ${list.map((r) => `<option value="${esc(r.repo)}"${r.shown ? ' selected' : ''}>${esc(r.repo)}</option>`).join('')}</select></div>`;
  }

  function shell(page, unread) {
    const o = CD.ctx.overview;
    const st = repoStatus(CD.ctx.repository, o);
    const nav = NAV.map(([key, label, href, icon]) => {
      if (!href) return `<span class="nav-item is-disabled" aria-disabled="true" title="Coming soon">${ic(icon, 20)}<span class="label">${label}</span><span class="soon">Soon</span></span>`;
      const badge = key === 'notifications' && unread ? `<span class="pill badge" style="--c:#6366F1" aria-label="${unread} unread">${unread}</span>` : '';
      return `<a class="nav-item" href="${href}"${key === page ? ' aria-current="page"' : ''} title="${label}">${ic(icon, 20)}<span class="label">${label}</span>${badge}</a>`;
    }).join('');
    return `<div class="app"><aside class="sidebar"><div class="logo"><span class="logo-tile">${ic('act', 18)}</span><span class="name">ComDoc</span></div>
      <nav aria-label="Primary" style="display:contents">${nav}</nav>
      <div class="sidebar-foot"><button class="btn btn-primary" data-open="connect" style="justify-content:center;padding:10px 12px">${ic('plus', 16)}<span class="btn-label">Connect repository</span></button>
        <div class="account" title="${esc(st.text)}"><span class="visually-hidden">${esc(st.text)}</span><span class="status-dot ${st.tone === 'ok' ? '' : st.tone === 'bad' ? 'bad' : st.tone === 'idle' ? 'idle' : 'warn'}" aria-hidden="true"></span>
        <span class="text"><b style="font-weight:500;overflow-wrap:anywhere">${esc(o.repo || 'No repository')}</b><small>${esc(o.repo_mode === 'multi' ? 'Multiple repositories' : 'Single repository')}</small></span></div></div></aside>
      <div class="main"><header class="topbar">${repoSelect(o)}<span class="spacer"></span>
        <span class="pill" id="auth-pill" role="status" hidden></span><button class="btn" id="auth-forget" type="button" hidden>Forget token</button>
        <a class="icon-btn" href="notifications.html" aria-label="Notifications${unread ? `, ${unread} unread` : ''}">${ic('bell', 20)}${unread ? '<span class="dot-unread"></span>' : ''}</a></header>
        <main class="content" id="main"></main></div></div>
      <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>`;
  }

  function pageHead(title, sub, actions = '') {
    return `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${actions ? `<div class="head-actions">${actions}</div>` : ''}</div>`;
  }

  /* ---------- the selected day (shared through ?date=) ---------- */
  const today = () => CD.ctx.overview.today;
  /** "Today", "Yesterday" or "Sat, Nov 21" (with the year when it isn't this year). */
  const dayName = (d) => (d === today() ? 'Today' : d === shift(today(), -1) ? 'Yesterday'
    : utcNoon(d).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', ...(d.slice(0, 4) !== today().slice(0, 4) ? { year: 'numeric' } : {}) }));
  function initialDate() {
    const d = new URLSearchParams(window.location.search).get('date');
    return /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d <= today() ? d : today();
  }
  function setDateParam(d) {
    const u = new URL(window.location.href);
    if (d === today()) u.searchParams.delete('date'); else u.searchParams.set('date', d);
    window.history.replaceState(null, '', u);
  }
  const dayNav = (d) => `<div class="daynav" role="group" aria-label="Choose a day">
    <button type="button" data-day="-1" aria-label="Previous day">${ic('left', 16)}</button>
    <span class="daypick"><button type="button" id="day-btn" aria-label="Choose a day (showing ${esc(dayLong(d))})">${ic('calendar', 14)} ${esc(dayName(d))}</button>
      <input type="date" id="day-input" tabindex="-1" aria-hidden="true" value="${d}" max="${today()}"></span>
    <button type="button" data-day="1" aria-label="Next day"${d >= today() ? ' disabled' : ''}>${ic('right', 16)}</button>
    ${d === today() ? '' : '<button type="button" class="today" data-day="today">Back to today</button>'}</div>`;
  /** Wire a dayNav inside root; onPick(date) is called with the new day. */
  function wireDayNav(root, current, onPick) {
    root.addEventListener('click', (e) => {
      if (e.target.closest('#day-btn')) {
        const input = $('#day-input', root);
        try { input.showPicker(); } catch { input.classList.add('show'); input.tabIndex = 0; input.removeAttribute('aria-hidden'); input.focus(); }
        return;
      }
      const b = e.target.closest('[data-day]');
      if (!b || b.disabled) return;
      const v = b.dataset.day;
      const d = v === 'today' ? today() : shift(current(), Number(v));
      if (d <= today()) onPick(d);
    });
    root.addEventListener('change', (e) => { if (e.target.id === 'day-input' && e.target.value && e.target.value <= today()) onPick(e.target.value); });
  }

  /* ---------- switching repositories ---------- */
  async function switchRepo(repo) {
    const r = await act(() => send('/repository/active', 'POST', { repo }));
    if (!r) return;
    const paused = CD.ctx.overview.repo_mode === 'single' && CD.ctx.overview.repo && CD.ctx.overview.repo !== repo;
    flash(`Now showing ${repo}.${paused ? ` ${CD.ctx.overview.repo} is paused and hidden; switch back to it in Settings.` : ''}`);
    const u = new URL(window.location.href);
    u.searchParams.delete('sha');
    window.location.href = u.pathname.endsWith('commit.html') ? 'commit.html' : u.toString();
  }

  /* ---------- connect dialog (two short steps, as before) ---------- */
  const parseRepo = (v) => {
    const m = String(v).trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
    return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
  };
  const PAYLOAD_KEY = 'commitdoctor.payloadUrl';
  const payloadDefault = () => (isLocal() ? '' : `${window.location.origin}/webhook/github`);
  const recommended = (priv) => (priv || isLocal() ? 'poll' : 'webhook');
  let form = { step: 1, repo: '', private: false, method: null };

  function buildConnect() {
    const d = document.createElement('dialog');
    d.id = 'connect';
    d.className = 'wide';
    d.setAttribute('aria-labelledby', 'connect-title');
    d.innerHTML = `<form id="connect-form" novalidate>
      <h2 id="connect-title">Connect repository</h2>
      <div id="c-step1">
        <p class="hint" id="c-mode-hint"></p>
        <div class="field"><label for="c-repo">Repository</label><input id="c-repo" placeholder="owner/name or a GitHub link" autocomplete="off" spellcheck="false"></div>
        <fieldset class="choice"><legend>Is it private?</legend>
          <label><input type="radio" name="c-private" value="no" checked> No, it's public. Commit Doctor reads it from GitHub without a token.</label>
          <label><input type="radio" name="c-private" value="yes"> Yes, it's private. You'll paste a read-only token next.</label></fieldset>
      </div>
      <div id="c-step2" hidden>
        <p class="hint">Connecting <strong id="c-step2-repo"></strong> · <button type="button" class="text-btn" id="c-back">Back</button></p>
        <p class="hint" id="c-explain"></p>
        <ol class="steps" id="c-steps"></ol>
        <div class="field"><label for="c-token">GitHub token</label><input id="c-token" type="password" placeholder="Paste the token here" autocomplete="off" spellcheck="false"></div>
        <details class="disclosure" id="c-advanced"><summary>Advanced</summary>
          <fieldset class="choice"><legend>How should Commit Doctor get updates?</legend>
            <label><input type="radio" name="c-method" value="webhook"> Instantly: GitHub notifies this server on every push (webhook)</label>
            <label><input type="radio" name="c-method" value="poll"> Every few minutes: this server checks GitHub with a read-only token</label></fieldset>
          <div id="c-adv-webhook"><div class="field"><label for="c-payload">Address GitHub should send pushes to</label><input id="c-payload" type="url" placeholder="https://your-server.example/webhook/github"></div>
            <p class="hint" id="c-payload-hint" hidden>This server runs on <code>localhost</code>, which GitHub can't reach. Use a public address (for example from <code>npx smee-client</code> or <code>ngrok</code>), or choose "Every few minutes".</p>
            <p class="hint">No token? <button type="button" class="text-btn" id="c-manual">Set up the webhook on GitHub myself</button></p></div>
        </details>
      </div>
      <p class="form-error" id="c-error" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" class="btn" id="c-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="c-submit">Scan repository</button></div>
    </form>`;
    document.body.append(d);
    const f = $('#connect-form', d);
    f.addEventListener('submit', (e) => { e.preventDefault(); if (form.step === 1) step1Next(); else connect(); });
    $('#c-cancel', d).addEventListener('click', () => d.close());
    $('#c-back', d).addEventListener('click', () => { form.step = 1; renderConnect(); });
    $('#c-manual', d).addEventListener('click', () => connect({ manual: true }));
    $('#c-payload', d).addEventListener('input', (e) => store.set(PAYLOAD_KEY, e.target.value.trim()));
    f.addEventListener('change', (e) => {
      if (e.target.name === 'c-private') renderConnect();
      if (e.target.name === 'c-method') { form.method = e.target.value; renderConnect(); }
    });
    return d;
  }
  const cErr = (msg) => { const el = $('#c-error'); el.hidden = !msg; el.textContent = msg || ''; };

  function renderConnect() {
    const o = CD.ctx.overview;
    $('#c-mode-hint').textContent = o.repo_mode === 'multi'
      ? 'The new repository is added next to the ones already followed, and the dashboard switches to it.'
      : o.repo
        ? `Commit Doctor follows one repository at a time. Connecting another one pauses and hides ${o.repo}; its history is kept, and you can switch back in Settings.`
        : 'Commit Doctor follows a GitHub repository and summarizes its commits every day.';
    $('#c-step1').hidden = form.step !== 1;
    $('#c-step2').hidden = form.step !== 2;
    const pub = ($('input[name="c-private"]:checked') || {}).value !== 'yes';
    $('#c-submit').textContent = form.step === 1 ? (pub ? 'Scan repository' : 'Continue') : 'Connect';
    if (form.step === 1) return;
    const method = form.method || recommended(form.private);
    $('#c-step2-repo').textContent = form.repo;
    for (const el of $$('input[name="c-method"]')) el.checked = el.value === method;
    $('#c-adv-webhook').hidden = method !== 'webhook';
    if (method === 'poll') {
      $('#c-explain').innerHTML = `Commit Doctor will check <strong>${esc(form.repo)}</strong> every few minutes using a <strong>read-only</strong> token. The token is stored encrypted on this server and deleted if you stop following the repository.`;
      $('#c-steps').innerHTML = `<li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Create a fine-grained token on GitHub</a>.</li>
        <li>Under <em>Repository access</em>, choose <em>Only select repositories</em> and pick <code>${esc(form.repo)}</code>.</li>
        <li>Under <em>Permissions</em>, set <em>Contents</em> to <em>Read-only</em>. Nothing else is needed.</li><li>Generate the token and paste it below.</li>`;
    } else {
      $('#c-explain').innerHTML = `GitHub will tell Commit Doctor the moment someone pushes to <strong>${esc(form.repo)}</strong>. Paste a token once so Commit Doctor can set this up; it is used once and <strong>not saved</strong>.`;
      $('#c-steps').innerHTML = `<li><a href="https://github.com/settings/tokens/new?scopes=admin:repo_hook&amp;description=Commit%20Doctor%20webhook" target="_blank" rel="noopener">Create a token on GitHub</a> (the <code>admin:repo_hook</code> box is already ticked).</li><li>Generate it and paste it below.</li>`;
      const u = $('#c-payload');
      if (!u.value) u.value = store.get(PAYLOAD_KEY) || payloadDefault();
      $('#c-payload-hint').hidden = !isLocal();
    }
  }

  function openConnect(prefill = {}) {
    const d = $('#connect') || buildConnect();
    form = { step: prefill.step || 1, repo: prefill.repo || '', private: Boolean(prefill.private), method: prefill.method || null };
    $('#c-repo').value = form.repo;
    $('#c-token').value = '';
    for (const el of $$('input[name="c-private"]')) el.checked = el.value === (form.private ? 'yes' : 'no');
    cErr('');
    renderConnect();
    d.showModal();
    (form.step === 1 ? $('#c-repo') : $('#c-token')).focus();
  }

  function step1Next() {
    const repo = parseRepo($('#c-repo').value);
    if (!repo) { cErr('Enter the repository as owner/name, or paste its GitHub link.'); $('#c-repo').focus(); return; }
    const priv = $('input[name="c-private"]:checked').value === 'yes';
    cErr('');
    form = { ...form, repo, private: priv, method: null };
    if (!priv) { connect({ scan: true }); return; }
    form.step = 2;
    $('#c-advanced').open = false;
    renderConnect();
    $('#c-token').focus();
  }

  function confirmBox(title, html, okLabel, danger = false) {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p class="hint" style="margin:8px 0 16px">${html}</p>
      <div class="dialog-actions"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(okLabel)}</button></div></form>`;
    document.body.append(d);
    return new Promise((resolve) => {
      d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); }, { once: true });
      d.showModal();
    });
  }

  async function connect({ manual = false, scan = false } = {}) {
    const method = scan ? 'public' : manual ? 'webhook' : (form.method || recommended(form.private));
    const token = manual || scan ? '' : $('#c-token').value.trim();
    const payloadUrl = $('#c-payload').value.trim();
    if (!manual && !scan && !token) { cErr('Paste the GitHub token first.'); $('#c-token').focus(); return; }
    if (method === 'webhook' && token) {
      if (!payloadUrl) { $('#c-advanced').open = true; cErr('Enter the address GitHub should send pushes to (under Advanced).'); return; }
      store.set(PAYLOAD_KEY, payloadUrl);
    }
    cErr('');
    const btn = $('#c-submit');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = scan ? 'Scanning…' : 'Connecting…';
    const body = (replace) => ({ repo: form.repo, method, token: token || undefined, payload_url: method === 'webhook' && token ? payloadUrl : undefined, replace });
    try {
      let r = await A.api('/repository', { method: 'POST', body: body(false) });
      if (!r.ok && r.status === 409 && r.data && r.data.needs_replace) {
        const ok = await confirmBox('Follow a different repository?',
          `Commit Doctor is set to follow one repository. Connecting <strong>${esc(form.repo)}</strong> pauses and hides <strong>${esc(r.data.current)}</strong> (${plural(r.data.commits, 'commit')}). Its history is <strong>kept</strong>, and you can switch back in Settings. To follow both, choose <em>Multiple repositories</em> in Settings.`,
          `Connect and hide ${r.data.current}`);
        if (!ok) return;
        r = await A.api('/repository', { method: 'POST', body: body(true) });
      }
      if (!r.ok) { if (r.kind !== 'cancelled') cErr(r.message); return; }
      $('#c-token').value = '';
      $('#connect').close();
      flash(`Connected ${form.repo}.${r.data.paused ? ` ${r.data.paused} is paused and hidden.` : ''}${manual ? ' Finish the webhook setup in Settings.' : ''}`);
      window.location.href = manual ? 'settings.html' : 'index.html';
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /* ---------- auth pill (from api.js) ---------- */
  function initAuth() {
    const p = $('#auth-pill');
    const btn = $('#auth-forget');
    if (!A || !p) return;
    const MAP = { open: ['Open mode', '#34D399'], locked: ['Locked', '#F87171'], unlocked: ['Unlocked', '#22D3EE'] };
    const render = () => {
      const m = MAP[A.getAuthState()];
      p.hidden = !m;
      if (m) { p.textContent = m[0]; p.style.setProperty('--c', m[1]); p.title = m[0] === 'Open mode' ? 'Changes are allowed without a token from this machine' : 'Changes need the admin token'; }
      btn.hidden = !A.token.get();
    };
    btn.addEventListener('click', () => { A.token.clear(); toast('Token forgotten.'); });
    A.onError = (r) => toast(r.message);
    window.addEventListener('comdoc:auth', render);
    render();
    A.probeLock();
  }

  /* ---------- start a page ---------- */
  async function unreadCount() {
    try {
      const flags = await get('/flags?limit=100');
      initSeen(flags);
      return flags.filter((f) => f.id > seenId()).length;
    } catch { return 0; }
  }

  async function start(page, render, { title = 'Commit Doctor' } = {}) {
    const root = $('#root');
    try {
      const [overview, repository] = await Promise.all([get('/overview'), get('/repository')]);
      CD.ctx = { overview, repository };
    } catch (err) {
      root.innerHTML = `<main class="content"><section class="card"><h2>Cannot reach the Commit Doctor server</h2><p class="hint">${esc(err.message)}</p><p style="margin-top:12px"><button class="btn" onclick="location.reload()">Try again</button></p></section></main>`;
      return;
    }
    root.innerHTML = shell(page, await unreadCount());
    document.title = `${title} · Commit Doctor`;
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.dataset.open === 'connect') { e.preventDefault(); openConnect(); }
      if (t.dataset.copy) copyText(($(t.dataset.copy) || {}).textContent || '');
      if (t.hasAttribute('data-toggle-files')) {
        const on = !filesShown();
        setFilesShown(on);
        for (const card of $$('[data-hideable]')) {
          $('[data-hideable-body]', card).hidden = !on;
          const off = $('[data-hideable-off]', card);
          if (off) off.hidden = on;
          const b = $('[data-toggle-files]', card);
          b.textContent = `${on ? 'Hide' : 'Show'} file details`;
          b.setAttribute('aria-expanded', String(on));
        }
      }
    });
    const sel = $('#repo-select');
    if (sel) sel.addEventListener('change', () => switchRepo(sel.value));
    initAuth();
    wireHelp();
    const msg = takeFlash();
    if (msg) toast(msg);
    try {
      await render($('#main'));
    } catch (err) {
      console.error(err);
      $('#main').insertAdjacentHTML('beforeend', `<section class="card"><h2>Something went wrong</h2><p class="hint">${esc(err.message)}</p></section>`);
    }
  }

  const CD = {
    ctx: null, $, $$, esc, plural, safeUrl, repoPath, store, ic, avatar, pill, colorFor, intentTag, intentPills, INTENT, INTENT_WORD,
    shift, dayLong, dayMed, dayShort, stamp, ago, hh, isLocal, get, send, act, toast, copyText, flash,
    spark, area, bars, dayBars, churnText, fileCount, filesText, NO_FILES, feedItem, comparePhrase, compareShort, help, dayName, flagMeta, PRED, predictionText, repoStatus,
    seenId, markSeen, hideable, pageHead, today, initialDate, setDateParam, dayNav, wireDayNav,
    switchRepo, openConnect, confirmBox, start,
  };
  window.CD = CD;
})();
