/* Repositories: details and recent activity of the shown repository, and (multi mode) all followed ones. */
(function () {
  'use strict';
  const { $$, esc, plural, ic, pill, get } = CD;

  CD.start('repository', async (main) => {
    const { overview: o, repository: r } = CD.ctx;
    if (!o.repo) {
      main.innerHTML = `${CD.pageHead('Repositories', 'Nothing connected yet')}<section class="card"><p class="hint">Connect a GitHub repository to see its details and activity here.</p>
        <p style="margin-top:12px"><button class="btn btn-primary" data-open="connect">${ic('plus', 14)} Connect repository</button></p></section>`;
      return;
    }
    const today = CD.today();
    const [trend, summaries, contributors, prediction] = await Promise.all([get('/trend?days=14'), get('/summaries?limit=30'), get(`/contributors?date=${today}`), get('/prediction')]);
    // The timeline shows the most recent days that had commits (up to five).
    const activeDays = trend.filter((d) => d.commits > 0).slice(-5).reverse();
    const byDay = await Promise.all(activeDays.map((d) => get(`/commits?date=${d.date}`).then((list) => [d.date, list])));
    const st = CD.repoStatus(r, o);
    const pred = CD.PRED[prediction.status] || [prediction.status, '#9AA3B5'];
    const quietAfter = o.rules.comparison_days;

    const timeline = byDay.length ? byDay.map(([d, list]) => `<div class="day">${esc(d === today ? 'Today' : CD.dayLong(d))}</div>${list.slice(0, 8).map(CD.feedItem).join('')}
      ${list.length > 8 ? `<p style="padding:4px 8px"><a class="link" href="commit.html?date=${d}">All ${list.length} commits →</a></p>` : ''}`).join('')
      : '<p class="empty">No commits in the last 14 days.</p>';
    const sums = summaries.length ? summaries.map((s) => `<a class="feed-item" href="index.html?date=${esc(s.date)}"><span class="node" style="--c:#A855F7"></span>
      <div class="fi-body"><div class="day" style="margin:0">${esc(CD.dayLong(s.date))}</div><strong>${esc(s.headline)}</strong><div class="meta">${CD.intentPills(s.intents, 3)}<span>${plural(s.total_commits, 'commit')}</span></div></div><span class="fi-go">${ic('right', 16)}</span></a>`).join('')
      : '<p class="empty">No saved summaries yet. Each day is saved after midnight.</p>';
    const people = contributors.length ? contributors.map((p) => `<div class="person">${CD.avatar(p.name)}<span style="font-weight:500">${esc(p.name)}</span>
      <span class="areas">${p.idle_days >= quietAfter ? pill(`Inactive ${plural(p.idle_days, 'day')}`, '#F59E0B') : pill(`Last commit ${CD.dayMed(p.last_date)}`, '#9AA3B5')}${pill(`${plural(p.commits_7d, 'commit')} · 7 days`, '#6366F1')}</span></div>`).join('')
      : '<p class="empty">No contributors yet.</p>';
    const others = o.repo_mode === 'multi' ? o.repositories.filter((x) => x.active || x.shown) : [];

    main.innerHTML = `${CD.pageHead(o.repo, 'Repository details and activity', `<a class="btn" href="https://github.com/${CD.repoPath(o.repo)}" target="_blank" rel="noopener">Open in GitHub ${ic('ext', 12)}</a><a class="btn" href="settings.html">${ic('gear', 14)} Manage</a>`)}
      <section class="card"><div class="status-line"><span class="status-dot ${st.tone === 'ok' ? '' : st.tone}" aria-hidden="true"></span><span>${esc(st.text)}</span></div>
        <div class="info-row">${pill(r.method === 'poll' ? 'Checked with a read-only token' : 'Webhook / public scan', r.method === 'poll' ? '#A855F7' : '#22D3EE')}
          <span>${plural(o.totals.commits, 'commit')} recorded</span><span>·</span><span>${plural(o.totals.contributors, 'contributor')}</span>
          ${o.totals.first_date ? `<span>·</span><span>since ${esc(CD.dayMed(o.totals.first_date))}</span>` : ''}<span class="spacer"></span>
          ${prediction.deadline_date ? pill(`Deadline ${CD.dayMed(prediction.deadline_date)} · ${pred[0]}`, pred[1]) : '<a class="link" href="settings.html">Set a deadline →</a>'}</div>
        <p class="note">Times in ${esc(o.timezone)}. Days are compared with the previous ${plural(quietAfter, 'day')}.</p></section>
      <div class="cols cols-wide">
        <section class="card solid" data-tabs><div class="tabs pills" role="tablist" aria-label="Repository views">
          <button role="tab" id="t-tl" aria-selected="true" aria-controls="p-tl">Timeline</button><button role="tab" id="t-sm" aria-selected="false" aria-controls="p-sm">Summaries</button><button role="tab" id="t-pp" aria-selected="false" aria-controls="p-pp">Contributors</button></div>
          <div role="tabpanel" id="p-tl" aria-labelledby="t-tl">${timeline}</div>
          <div role="tabpanel" id="p-sm" aria-labelledby="t-sm" hidden>${sums}</div>
          <div role="tabpanel" id="p-pp" aria-labelledby="t-pp" hidden style="padding-top:12px">${people}<p class="note" style="margin-top:12px">Most recent activity first. Not a ranking.</p></div></section>
        <div class="stack-col">
          <section class="card"><div class="card-head"><h2>Commit statistics</h2></div><p class="sub">Commits per day (14 days)</p>${CD.area(trend.map((d) => d.commits), 'Commits per day over the last 14 days')}
            <p class="sub" style="margin-top:12px">Contributors per day</p>${CD.bars(trend.map((d) => d.contributors), 'Contributors per day over the last 14 days', '#22D3EE')}
            <p class="note" style="margin-top:8px">${esc(CD.dayMed(trend[0].date))} – today · context only, not a performance measure</p></section>
          ${others.length ? `<section class="card"><div class="card-head"><h2>Followed repositories</h2></div>${others.map((x) => `<div class="repo-row"><div class="grow"><strong>${esc(x.repo)}</strong><span class="note">${plural(x.commits, 'commit')}</span></div>
            ${x.shown ? pill('Showing', '#6366F1') : `<button class="btn" data-switch="${esc(x.repo)}">Show</button>`}</div>`).join('')}</section>` : ''}
        </div></div>`;

    main.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.switch) CD.switchRepo(t.dataset.switch);
      if (t.getAttribute('role') === 'tab') {
        for (const b of $$('[role=tab]', t.closest('[data-tabs]'))) {
          const on = b === t;
          b.setAttribute('aria-selected', String(on));
          document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
        }
      }
    });
  }, { title: 'Repository' });
})();
