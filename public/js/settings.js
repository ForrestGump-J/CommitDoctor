/* Settings: repositories (single or multiple), deadline, email alerts, admin access, system log. */
(function () {
  'use strict';
  const { $, esc, plural, ic, pill, get, send, act, toast } = CD;
  const PAYLOAD_KEY = 'commitdoctor.payloadUrl';

  CD.start('settings', async (main) => {
    const { overview: o, repository: r } = CD.ctx;
    const [prediction, subscribers] = await Promise.all([get('/prediction'), get('/subscribers')]);
    const multi = o.repo_mode === 'multi';
    const st = CD.repoStatus(r, o);
    const followed = o.repositories.filter((x) => x.active || x.shown);
    const hidden = o.repositories.filter((x) => !x.active && !x.shown);

    const repoRow = (x) => {
      const state = x.shown ? pill('Showing', '#6366F1') : x.active ? pill('Following', '#34D399') : pill(multi ? 'Paused' : 'Hidden', '#9AA3B5');
      const show = x.shown ? '' : `<button class="btn" data-switch="${esc(x.repo)}">${x.active ? 'Show' : 'Switch back'}</button>`;
      return `<div class="repo-row"><div class="grow"><strong>${esc(x.repo)}</strong><span class="note">${plural(x.commits, 'commit')}${x.last_commit_at ? ` · last ${esc(CD.ago(x.last_commit_at))}` : ''} · ${x.method === 'poll' ? 'token' : 'webhook / public scan'}${x.deadline_date ? ` · deadline ${esc(CD.dayMed(x.deadline_date))}` : ''}</span></div>
        ${state}${show}<button class="btn btn-danger" data-remove="${esc(x.repo)}" data-commits="${x.commits}">Remove</button></div>`;
    };
    const payload = CD.store.get(PAYLOAD_KEY) || (CD.isLocal() ? '' : `${window.location.origin}/webhook/github`);
    const manual = o.repo && r.method === 'webhook' && r.webhook.state !== 'connected' ? `<details class="disclosure" id="manual" style="margin-top:12px"><summary>Want instant updates? Add a webhook on GitHub</summary>
      <p class="hint">Scans already work without a token. A webhook makes new pushes show up the moment they happen. <button type="button" class="text-btn" id="hook-token">Have a token? Let Commit Doctor add it for you</button></p>
      <p class="hint">Open <a href="https://github.com/${CD.repoPath(o.repo)}/settings/hooks/new" target="_blank" rel="noopener">GitHub › Settings › Webhooks › Add webhook</a> and enter:</p>
      <dl class="kv"><dt>Payload URL</dt><dd><code id="m-url">${esc(payload || "(your server's public address)/webhook/github")}</code><button type="button" class="text-btn" data-copy="#m-url">Copy</button></dd>
        <dt>Content type</dt><dd><code>application/json</code></dd>
        <dt>Secret</dt><dd><code id="m-secret">…</code><button type="button" class="text-btn" id="m-secret-btn">Show</button><button type="button" class="text-btn" data-copy="#m-secret">Copy</button></dd>
        <dt>Events</dt><dd>Just the push event</dd></dl>
      ${CD.isLocal() ? `<p class="hint">GitHub can't reach <code>localhost</code>. Run <code>npx smee-client --target ${esc(window.location.origin)}/webhook/github</code> and use the address it prints, or reconnect with a token instead.</p>` : ''}</details>` : '';

    main.innerHTML = `${CD.pageHead('Settings', o.repo ? `Settings for ${o.repo} and how repositories are followed` : 'Connect a repository to get started')}
      <section class="card solid"><div class="card-head"><h2>Repositories</h2><button class="btn btn-primary" data-open="connect">${ic('plus', 14)} Connect repository</button></div>
        <div class="field-row" style="margin-bottom:8px"><span class="sub">Follow</span><div class="seg" role="group" aria-label="How many repositories to follow">
          <button type="button" data-mode="single" aria-pressed="${!multi}">One repository</button><button type="button" data-mode="multi" aria-pressed="${multi}">Multiple repositories</button></div></div>
        <p class="hint">${multi
          ? 'Every connected repository keeps receiving commits, summaries, flags and email alerts. Use the selector at the top to hop between them.'
          : 'Commit Doctor follows one repository. Connecting another pauses and hides the current one; its history is kept, and you can switch back below.'}</p>
        ${o.repo ? `<div class="status-line" style="margin-top:16px"><span class="status-dot ${st.tone === 'ok' ? '' : st.tone}" aria-hidden="true"></span><div style="flex:1;min-width:0"><strong>${esc(o.repo)}</strong><span class="hint" style="display:block">${esc(st.text)}</span></div>
          <div class="field-row"><button class="btn" id="scan">${ic('refresh', 14)} Check now</button>${r.method === 'poll' && r.poll.last_error ? '<button class="btn" id="retoken">Use a new token</button>' : ''}<button class="btn" id="stop">Stop following</button></div></div>${manual}` : ''}
        <h3 class="stat-label" style="margin:20px 0 4px">${multi ? 'Followed' : 'Current'}</h3>${followed.length ? followed.map(repoRow).join('') : '<p class="note">None.</p>'}
        ${hidden.length ? `<h3 class="stat-label" style="margin:20px 0 4px">${multi ? 'Paused' : 'Hidden'}</h3><p class="note">Not followed right now. Their history is kept; switching back pulls in the last 14 days of commits.</p>${hidden.map(repoRow).join('')}` : ''}</section>

      <div class="cols cols-2">
        <section class="card"><div class="card-head"><h2>Deadline${CD.help('pace')}</h2></div>
          ${o.repo ? `<p class="hint">Each repository has its own deadline. It's used to judge whether the current pace will make it, and for reminder emails.</p>
          <div class="field-row" style="margin:12px 0"><label class="visually-hidden" for="deadline">Deadline for ${esc(o.repo)}</label><input type="date" id="deadline" class="input" value="${esc(prediction.deadline_date || '')}" style="color-scheme:dark">
            <button class="btn btn-primary" id="deadline-set">Set</button>${prediction.deadline_date ? '<button class="btn" id="deadline-clear">Clear</button>' : ''}</div>
          <p class="hint">${prediction.deadline_date ? pill((CD.PRED[prediction.status] || [prediction.status])[0], (CD.PRED[prediction.status] || [0, '#9AA3B5'])[1]) : ''} ${esc(CD.predictionText(prediction))}</p>
          <p class="note" style="margin-top:8px">Rule-based: the last ${plural(o.rules.comparison_days, 'day')} vs. the earlier pace (75% or more is on pace, 40–75% at risk, below 40% behind); heavy rework (over 60% removals in 21 days) lowers "on pace" to "at risk".</p>`
          : '<p class="hint">Connect a repository first.</p>'}</section>

        <section class="card"><div class="card-head"><h2>Email alerts</h2></div>
          ${o.repo ? `<p class="hint">People who get deadline reminders and flag alerts for <strong>${esc(o.repo)}</strong>. Each repository has its own list.</p>
          <div id="subs" style="margin:8px 0">${subscribers.length ? subscribers.map((s) => `<div class="repo-row"><div class="grow"><strong>${esc(s.name)}</strong><span class="note">${esc(s.email)}</span></div><button class="btn" data-unsub="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button></div>`).join('') : '<p class="note">Nobody yet.</p>'}</div>
          <form id="sub-form" class="field-row" novalidate><input class="input" id="sub-name" placeholder="Name" aria-label="Name" autocomplete="off"><input class="input" id="sub-email" type="email" placeholder="Email" aria-label="Email" autocomplete="off"><button class="btn btn-primary" type="submit">Add</button></form>`
          : '<p class="hint">Connect a repository first.</p>'}</section>
      </div>

      <section class="card"><div class="card-head"><h2>Admin access</h2><span class="pill" id="auth-pill-2"></span></div>
        <p class="hint">Changes (connecting repositories, deadlines, subscribers, saving summaries) need the server's <code>ADMIN_TOKEN</code>. If none is set, changes are only accepted from the server machine itself. The token you enter is kept for this browser tab only.</p>
        <p style="margin-top:12px" class="field-row"><button class="btn" id="enter-token">Enter admin token</button><button class="btn" id="forget-token">Forget token</button></p></section>

      <section class="card"><details class="disclosure" id="log"><summary>System log: webhook deliveries, summary runs and view usage</summary><div id="log-body" class="section-gap" style="margin-top:12px"><p class="note">Loading…</p></div></details></section>`;

    const authPill = () => {
      const s = window.ComDocApi.getAuthState();
      const m = { open: ['Open mode', '#34D399'], locked: ['Locked', '#F87171'], unlocked: ['Unlocked', '#22D3EE'] }[s] || ['Checking…', '#9AA3B5'];
      const el = $('#auth-pill-2');
      el.textContent = m[0];
      el.style.setProperty('--c', m[1]);
    };
    authPill();
    window.addEventListener('comdoc:auth', authPill);

    const reload = (msg) => { if (msg) CD.flash(msg); window.location.reload(); };

    main.addEventListener('click', async (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.switch) CD.switchRepo(t.dataset.switch);
      if (t.dataset.mode && t.getAttribute('aria-pressed') !== 'true') {
        const toSingle = t.dataset.mode === 'single';
        const others = followed.filter((x) => !x.shown);
        if (toSingle && others.length && !(await CD.confirmBox('Follow one repository?', `Only <strong>${esc(o.repo)}</strong> will stay followed. ${others.map((x) => `<strong>${esc(x.repo)}</strong>`).join(', ')} will be paused and hidden. Nothing is deleted.`, 'Follow one repository'))) return;
        if (await act(() => send('/settings', 'POST', { repo_mode: t.dataset.mode }))) reload(toSingle ? 'Now following one repository.' : 'Multiple repositories: connect more and hop between them.');
      }
      if (t.dataset.remove) {
        const repo = t.dataset.remove;
        if (!(await CD.confirmBox(`Remove ${repo}?`, `This permanently deletes everything recorded for <strong>${esc(repo)}</strong>: ${plural(Number(t.dataset.commits), 'commit')}, saved summaries, flags, its deadline, subscribers and any stored token. The system log is kept. This can't be undone.`, 'Remove and delete data', true))) return;
        if (await act(() => send(`/repositories/${CD.repoPath(repo)}`, 'DELETE'))) reload(`Removed ${repo}.`);
      }
      if (t.id === 'scan') { t.disabled = true; if (await act(() => send('/repository/scan', 'POST'))) reload('Checked GitHub.'); else t.disabled = false; }
      if (t.id === 'retoken') CD.openConnect({ repo: o.repo, step: 2, private: true, method: 'poll' });
      if (t.id === 'hook-token') CD.openConnect({ repo: o.repo, step: 2, private: false, method: 'webhook' });
      if (t.id === 'stop') {
        if (!(await CD.confirmBox(`Stop following ${o.repo}?`, `New commits won't be recorded. Its history stays, listed under ${multi ? 'Paused' : 'Hidden'}, and you can switch back later.${r.method === 'poll' ? ' The saved token is deleted.' : ' Also remove the webhook on GitHub (Settings › Webhooks) if you added one.'}`, 'Stop following'))) return;
        if (await act(() => send('/repository', 'DELETE'))) reload(`Stopped following ${o.repo}.`);
      }
      if (t.id === 'm-secret-btn') {
        const s = await act(() => send('/webhook-setup', 'GET'));
        if (s) { $('#m-secret').textContent = s.secret; t.remove(); }
      }
      if (t.id === 'deadline-set') {
        const v = $('#deadline').value;
        if (!v) { toast('Pick a date first.'); return; }
        if (await act(() => send('/settings', 'POST', { deadline_date: v }))) reload(`Deadline set to ${CD.dayMed(v)}.`);
      }
      if (t.id === 'deadline-clear' && await act(() => send('/settings', 'POST', { deadline_date: null }))) reload('Deadline cleared.');
      if (t.dataset.unsub && await act(() => send(`/subscribers/${t.dataset.unsub}`, 'DELETE'))) reload('Removed.');
      if (t.id === 'enter-token') window.ComDocApi.promptToken().then((v) => { if (v) { toast('Token saved for this tab.'); window.ComDocApi.probeLock(true); } });
      if (t.id === 'forget-token') { window.ComDocApi.token.clear(); toast('Token forgotten.'); }
    });

    const subForm = $('#sub-form');
    if (subForm) {
      subForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = $('#sub-name').value.trim();
        const email = $('#sub-email').value.trim();
        if (!name || !email) { toast('Enter a name and an email.'); return; }
        if (await act(() => send('/subscribers', 'POST', { name, email }))) reload(`${name} will get alerts for ${o.repo}.`);
      });
    }

    $('#log').addEventListener('toggle', async (e) => {
      if (!e.target.open) return;
      const [a, views] = await Promise.all([get('/activity?limit=25'), get('/views/stats')]);
      const res = (s) => pill(s, s === 'accepted' || s === 'saved' ? '#34D399' : s === 'rejected' ? '#F87171' : '#9AA3B5');
      const table = (head, rows, empty) => (rows.length ? `<div class="table-wrap"><table class="log-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : `<p class="note">${empty}</p>`);
      $('#log-body').innerHTML = `
        <div><h3 class="stat-label">Summary view usage</h3><p class="note" style="margin:4px 0 8px">Anonymous. Compares the Digest, Team and Timeline views (research question 5). The feasibility study is on the <a href="study.html">study page</a>.</p>
          ${table(['View', 'Opened', 'Browsers', 'Avg. seconds open', '👍', '👎', 'Helpful'], views.map((v) => `<tr><td>${esc(v.view)}</td><td>${v.opens}</td><td>${v.sessions}</td><td>${v.avg_seconds_per_open ?? '—'}</td><td>${v.helpful}</td><td>${v.not_helpful}</td><td>${v.helpful_pct == null ? '—' : `${v.helpful_pct}%`}</td></tr>`), 'No usage yet.')}</div>
        <div><h3 class="stat-label" style="margin-bottom:8px">Webhook deliveries</h3>${table(['Received', 'Repository', 'Event', 'Result', 'Stored', 'Note'], a.webhook_events.map((x) => `<tr><td>${esc(CD.stamp(x.received_at))}</td><td>${esc(x.repo || '')}</td><td>${esc(x.event || '')}</td><td>${res(x.status)}</td><td>${x.commits_new} of ${x.commits_received}</td><td class="wrap">${esc(x.detail || '')}</td></tr>`), 'No deliveries yet.')}</div>
        <div><h3 class="stat-label" style="margin-bottom:8px">Summary runs</h3>${table(['Run', 'Repository', 'Day', 'Trigger', 'Result', 'Commits'], a.summary_runs.map((x) => `<tr><td>${esc(CD.stamp(x.run_at))}</td><td>${esc(x.repo || '')}</td><td>${esc(x.date)}</td><td>${esc(x.trigger)}</td><td>${res(x.outcome)}</td><td>${x.total_commits}</td></tr>`), 'No summaries generated yet.')}</div>`;
    });
  }, { title: 'Settings' });
})();
