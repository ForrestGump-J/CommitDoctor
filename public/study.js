(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SCREENS = ['start', 'block', 'task', 'sus', 'done'];
  const SAVE_KEY = 'commitdoctor.study';
  const SCALE = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

  // s: { id, token, code, blocks, blockIdx, taskIdx }; admin token stays in memory only.
  let s = null;
  let adminToken = null;
  let shownAt = 0;

  const save = () => { try { window.sessionStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
  const load = () => { try { return JSON.parse(window.sessionStorage.getItem(SAVE_KEY)); } catch { return null; } };
  const clear = () => { try { window.sessionStorage.removeItem(SAVE_KEY); } catch { /* ignore */ } };

  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (opts.admin && adminToken) headers.Authorization = `Bearer ${adminToken}`;
    let body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await fetch(path, { method: opts.method || 'GET', headers, body });
    if (opts.raw && res.ok) return res;
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; throw e; }
    return data;
  }
  async function asAdmin(fn) {
    try { return await fn(); } catch (err) {
      if (err.status !== 401) throw err;
      const t = window.prompt('Enter the admin token:');
      if (!t) throw err;
      adminToken = t;
      return fn();
    }
  }
  const showError = (id, msg) => { const el = $(id); el.hidden = !msg; el.textContent = msg || ''; };

  function show(name) {
    for (const n of SCREENS) $(`#screen-${n}`).hidden = n !== name;
    const total = s ? s.blocks.reduce((n, b) => n + b.tasks.length, 0) : 0;
    const done = s ? s.blocks.slice(0, s.blockIdx).reduce((n, b) => n + b.tasks.length, 0) + (name === 'task' ? s.taskIdx : 0) : 0;
    $('#progress').textContent = s && name !== 'done' ? `${s.code} · ${name === 'sus' ? 'questionnaire' : `${done} of ${total} answered`}` : '';
    const focusable = $(`#screen-${name} h1`);
    if (focusable) { focusable.tabIndex = -1; focusable.focus(); }
  }

  // --- start ---------------------------------------------------------------------
  async function start(e) {
    e.preventDefault();
    const code = $('#code-input').value.trim();
    if (!$('#consent-input').checked) { showError('#start-error', 'Consent is needed before starting.'); return; }
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(code)) { showError('#start-error', 'Use a short code like P01 (letters, digits, - or _).'); return; }
    showError('#start-error', '');
    try {
      const r = await asAdmin(() => api('/api/study/sessions', { method: 'POST', admin: true, body: { code, consent: true } }));
      s = { id: r.id, token: r.token, code: r.code, blocks: r.blocks, blockIdx: 0, taskIdx: 0 };
      save();
      showBlock();
    } catch (err) {
      if (err.status !== 401) showError('#start-error', err.message);
    }
  }

  // --- one part (condition) -------------------------------------------------------------
  function showBlock() {
    const b = s.blocks[s.blockIdx];
    $('#block-eyebrow').textContent = `Part ${s.blockIdx + 1} of ${s.blocks.length}`;
    $('#block-title').textContent = b.title;
    $('#block-text').textContent = b.text;
    const link = $('#block-link');
    link.href = b.link;
    link.textContent = `${b.link_label} ↗`;
    show('block');
  }

  // --- questions --------------------------------------------------------------------
  function showTask() {
    const b = s.blocks[s.blockIdx];
    const t = b.tasks[s.taskIdx];
    $('#task-eyebrow').textContent = `Part ${s.blockIdx + 1} · ${b.title} · question ${s.taskIdx + 1} of ${b.tasks.length}`;
    $('#task-prompt').textContent = t.prompt;
    $('#task-reminder').textContent = b.condition === 'github' ? 'Use GitHub only.' : 'Use Commit Doctor only.';
    const host = $('#task-input');
    if (t.kind === 'number') {
      host.innerHTML = '<input type="number" id="answer-number" class="field narrow" min="0" step="1" inputmode="numeric" aria-label="Your answer">';
    } else {
      const opts = t.kind === 'yesno' ? [['yes', 'Yes'], ['no', 'No']] : t.options.map((o) => [o, o]);
      host.innerHTML = `<fieldset class="choice answers"><legend class="sr-only">${esc(t.prompt)}</legend>${opts
        .map(([v, label]) => `<label><input type="radio" name="answer" value="${esc(v)}"> ${esc(label)}</label>`).join('')}</fieldset>`;
    }
    $('#task-next').disabled = true;
    showError('#task-error', '');
    show('task');
    shownAt = performance.now();
  }

  function currentAnswer() {
    const t = s.blocks[s.blockIdx].tasks[s.taskIdx];
    if (t.kind === 'number') return $('#answer-number').value.trim();
    const picked = document.querySelector('input[name="answer"]:checked');
    return picked ? picked.value : '';
  }

  async function submitTask(e) {
    e.preventDefault();
    const response = currentAnswer();
    if (response === '') return;
    const ms = Math.round(performance.now() - shownAt);
    const t = s.blocks[s.blockIdx].tasks[s.taskIdx];
    $('#task-next').disabled = true;
    try {
      await api(`/api/study/sessions/${s.id}/answers`, { method: 'POST', body: { token: s.token, task_id: t.id, response, ms } });
    } catch (err) {
      // 409 = already answered (e.g. a double click or a reload); just move on.
      if (err.status !== 409) { showError('#task-error', err.message); $('#task-next').disabled = false; return; }
    }
    s.taskIdx += 1;
    if (s.taskIdx >= s.blocks[s.blockIdx].tasks.length) {
      s.blockIdx += 1;
      s.taskIdx = 0;
      save();
      if (s.blockIdx >= s.blocks.length) showSus(); else showBlock();
      return;
    }
    save();
    showTask();
  }

  // --- SUS ----------------------------------------------------------------------------
  async function showSus() {
    const items = await api('/api/study/sus-items');
    $('#sus-items').innerHTML = items.map((text, i) => `<li>
      <fieldset class="sus-item"><legend>${esc(text)}</legend>
        <div class="scale">${SCALE.map((label, v) => `<label><input type="radio" name="sus${i}" value="${v + 1}"><span>${v + 1}</span><small>${label}</small></label>`).join('')}</div>
      </fieldset></li>`).join('');
    show('sus');
  }

  async function submitSus(e) {
    e.preventDefault();
    const sus = [];
    for (let i = 0; i < 10; i += 1) {
      const picked = document.querySelector(`input[name="sus${i}"]:checked`);
      if (!picked) { showError('#sus-error', `Please answer statement ${i + 1}.`); return; }
      sus.push(Number(picked.value));
    }
    showError('#sus-error', '');
    try {
      await api(`/api/study/sessions/${s.id}/finish`, {
        method: 'POST',
        body: { token: s.token, sus, comments: { helped: $('#c-helped').value, confusing: $('#c-confusing').value, other: $('#c-other').value } },
      });
      clear();
      show('done');
    } catch (err) {
      showError('#sus-error', err.message);
    }
  }

  function reset() {
    s = null;
    clear();
    $('#start-form').reset();
    $('#sus-form').reset();
    show('start');
  }

  // --- facilitator results ----------------------------------------------------------------
  async function loadResults() {
    const body = $('#results-body');
    try {
      const r = await asAdmin(() => api('/api/study/results', { admin: true }));
      const g = r.by_condition.github;
      const c = r.by_condition.comdoc;
      const val = (v, unit = '') => (v == null ? '—' : `${v}${unit}`);
      const yes = (v) => (v == null ? '—' : v ? '<span class="pill-ok">yes</span>' : '<span class="pill-bad">no</span>');
      body.innerHTML = `
        <p>${r.participants.completed} of ${r.participants.started} participant(s) finished. Only finished sessions are counted.</p>
        <div class="tbl-wrap"><table>
          <thead><tr><th></th><th>GitHub only</th><th>Commit Doctor</th></tr></thead>
          <tbody>
            <tr><td>Answers</td><td>${g.answers}</td><td>${c.answers}</td></tr>
            <tr><td>Accuracy</td><td>${val(g.accuracy_pct, '%')}</td><td>${val(c.accuracy_pct, '%')}</td></tr>
            <tr><td>Mean seconds per question</td><td>${val(g.mean_seconds)}</td><td>${val(c.mean_seconds)}</td></tr>
            <tr><td>Median seconds per question</td><td>${val(g.median_seconds)}</td><td>${val(c.median_seconds)}</td></tr>
          </tbody></table></div>
        <p>Mean SUS score for Commit Doctor: <strong>${val(r.sus_mean)}</strong> (68 is the usual "above average" benchmark).</p>
        <p>Success criteria: as accurate ${yes(r.criteria && r.criteria.as_accurate)} · faster ${yes(r.criteria && r.criteria.faster)} · SUS ≥ 68 ${yes(r.criteria && r.criteria.sus_at_least_68)}</p>
        <p><button type="button" class="btn" id="csv-btn">Download all answers (CSV)</button></p>
        <h3>Sessions</h3>
        <div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Started</th><th>Finished</th><th>SUS</th><th></th></tr></thead><tbody>
          ${r.sessions.map((x) => `<tr><td>${esc(x.code)}</td><td>${esc(new Date(x.created_at).toLocaleString())}</td><td>${x.completed_at ? 'yes' : 'no'}</td><td>${val(x.sus_score)}</td>
            <td><button type="button" class="text-btn del-session" data-id="${x.id}" data-code="${esc(x.code)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5">None yet.</td></tr>'}
        </tbody></table></div>`;
    } catch (err) {
      body.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }

  async function downloadCsv() {
    const res = await asAdmin(() => api('/api/study/export.csv', { admin: true, raw: true }));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = 'commit-doctor-study.csv';
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteSession(id, code) {
    if (!window.confirm(`Delete all answers from ${code}? Use this for pilot runs or if the participant withdraws.`)) return;
    try {
      await asAdmin(() => api(`/api/study/sessions/${id}`, { method: 'DELETE', admin: true }));
      loadResults();
    } catch (err) {
      window.alert(err.message);
    }
  }

  // --- wiring ------------------------------------------------------------------------------
  $('#start-form').addEventListener('submit', start);
  $('#block-start').addEventListener('click', showTask);
  $('#task-form').addEventListener('submit', submitTask);
  $('#task-form').addEventListener('input', () => { $('#task-next').disabled = currentAnswer() === ''; });
  $('#sus-form').addEventListener('submit', submitSus);
  $('#next-participant').addEventListener('click', reset);
  $('#results').addEventListener('toggle', (e) => { if (e.target.open) loadResults(); });
  $('#results-body').addEventListener('click', (e) => {
    if (e.target.id === 'csv-btn') downloadCsv().catch((err) => window.alert(err.message));
    const del = e.target.closest('.del-session');
    if (del) deleteSession(del.dataset.id, del.dataset.code);
  });

  // Resume after an accidental reload.
  s = load();
  if (s && s.blocks) {
    if (s.blockIdx >= s.blocks.length) showSus(); else if (s.taskIdx > 0) showTask(); else showBlock();
  } else {
    s = null;
    show('start');
  }
})();
