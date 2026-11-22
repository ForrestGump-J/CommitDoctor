/* Notifications: flags of the shown repository, plus daily and weekly digests.
   "Unread" is remembered per browser (the server has no notion of read). */
(function () {
  'use strict';
  const { $, $$, esc, plural, ic, pill, get } = CD;
  const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['activity', 'Activity'], ['inactivity', 'Inactivity'], ['deadline', 'Deadline']];

  CD.start('notifications', async (main) => {
    const today = CD.today();
    const [flags, summaries, week, contributors] = await Promise.all([get('/flags?limit=100'), get('/summaries?limit=30'), get('/trend?days=7'), get(`/contributors?date=${today}`)]);
    const seen = CD.seenId();
    let filter = 'all';
    const unreadCount = () => flags.filter((f) => f.id > CD.seenId()).length;

    const flagRow = (f) => {
      const [label, icon, color, group] = CD.flagMeta(f.type);
      const unread = f.id > CD.seenId();
      return `<div class="notif" data-group="${group}" data-unread="${unread ? 1 : 0}"><span class="tile" style="--c:${color}">${ic(icon, 16)}</span>
        <div><b>${esc(label)}</b><small>${esc(f.detail)}</small></div><span class="time">${esc(CD.dayMed(f.date))}</span>
        ${unread ? '<span class="unread-dot" title="Unread"></span>' : ''}<a class="link" href="index.html?date=${esc(f.date)}">View day →</a></div>`;
    };
    const chips = () => FILTERS.map(([k, label]) => `<button class="chip" data-filter="${k}" aria-pressed="${k === filter}">${label}${k === 'unread' ? ` (${unreadCount()})` : ''}</button>`).join('');

    // Weekly digest, added up from the last seven days.
    const weekStart = week[0].date;
    const weekCommits = week.reduce((n, d) => n + d.commits, 0);
    const activeDays = week.filter((d) => d.commits > 0).length;
    const weekPeople = contributors.filter((c) => c.commits_7d > 0).length;
    const weekSums = summaries.filter((s) => s.date >= weekStart);
    const intents = {};
    for (const s of weekSums) for (const [k, n] of Object.entries(s.intents || {})) intents[k] = (intents[k] || 0) + n;
    const top = Object.entries(intents).sort((a, b) => b[1] - a[1])[0];
    const weekFlags = flags.filter((f) => f.date >= weekStart);
    const weekText = weekCommits
      ? `${plural(weekCommits, 'commit')} over the last seven days from ${plural(weekPeople, 'contributor')}, on ${plural(activeDays, 'day')} of seven.${top ? ` Most saved work was ${CD.INTENT_WORD[top[0]] ? CD.INTENT_WORD[top[0]].toLowerCase() : top[0]}.` : ''} ${weekFlags.length ? `${plural(weekFlags.length, 'flag')} raised.` : 'No flags raised.'}`
      : 'No commits in the last seven days.';

    main.innerHTML = `${CD.pageHead('Notifications', `Flags and digests for ${CD.ctx.overview.repo || 'all repositories'}`)}
      <div data-tabs><div class="tabs underline" role="tablist" aria-label="Notification views">
        <button role="tab" id="n-imp" aria-selected="true" aria-controls="np-imp">Important updates</button><button role="tab" id="n-day" aria-selected="false" aria-controls="np-day">Daily digest</button><button role="tab" id="n-wk" aria-selected="false" aria-controls="np-wk">Weekly digest</button></div>
        <div role="tabpanel" id="np-imp" aria-labelledby="n-imp" style="padding-top:16px"><section class="card solid"><div class="card-head"><h2>Flags${CD.help('flag')}</h2><div class="chips" role="group" aria-label="Filter flags" id="chips">${chips()}</div>
            <button class="btn" id="mark-read"${unreadCount() ? '' : ' disabled'}>Mark all as read</button></div>
          <div class="notif-list roomy" id="flag-list">${flags.map(flagRow).join('')}</div><p class="empty" id="flags-empty"${flags.length ? ' hidden' : ''}>${flags.length ? 'Nothing here. You’re all caught up.' : 'No flags yet. They are raised when a saved day stands out from the recent baseline, a contributor goes quiet, or the deadline pace slips.'}</p>
          <p class="note">Subscribers also get these by email. Manage them in <a class="link" href="settings.html">Settings</a>. Read markers are kept in this browser only.</p></section></div>
        <div role="tabpanel" id="np-day" aria-labelledby="n-day" hidden style="padding-top:16px"><div class="section-gap">${summaries.length ? summaries.slice(0, 14).map((s) => `<article class="card digest glass"><div class="card-head"><div class="meta">${pill('Daily', '#6366F1')}<b style="color:var(--snow);font-weight:500">${esc(CD.dayLong(s.date))}</b></div><a class="link" href="index.html?date=${esc(s.date)}">Open day →</a></div>
            <p>${esc(s.headline)}</p><div class="chips" style="margin-top:10px">${CD.intentPills(s.intents)}</div><p class="note" style="margin-top:8px">${plural(s.total_commits, 'commit')} · saved ${esc(CD.stamp(s.generated_at))}</p></article>`).join('')
            : '<section class="card"><p class="empty">No saved daily summaries yet. Each day is saved automatically after midnight.</p></section>'}</div></div>
        <div role="tabpanel" id="np-wk" aria-labelledby="n-wk" hidden style="padding-top:16px"><article class="card digest glass"><div class="card-head"><div class="meta">${pill('Weekly', '#A855F7')}<b style="color:var(--snow);font-weight:500">${esc(CD.dayMed(weekStart))} – ${esc(CD.dayMed(today))}</b></div></div>
          <div class="chips" style="margin-bottom:12px">${CD.intentPills(intents)}</div><p>${esc(weekText)}</p>
          ${weekFlags.length ? `<ul class="digest-list" style="margin-top:12px">${weekFlags.slice(0, 6).map((f) => `<li data-tone="bad">${esc(CD.flagMeta(f.type)[0])} (${esc(CD.dayMed(f.date))}): ${esc(f.detail)}</li>`).join('')}</ul>` : ''}
          <div style="margin-top:12px">${CD.bars(week.map((d) => d.commits), 'Commits per day this week')}</div><p class="note" style="margin-top:6px">${week.map((d) => CD.dayShort(d.date)).join(' · ')} · commits per day · context only</p></article></div></div>`;

    const applyFilter = () => {
      let shown = 0;
      for (const row of $$('#flag-list .notif')) {
        const ok = filter === 'all' || (filter === 'unread' ? row.dataset.unread === '1' : row.dataset.group === filter);
        row.hidden = !ok;
        if (ok) shown += 1;
      }
      if (flags.length) $('#flags-empty').hidden = shown > 0;
    };
    main.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.filter) { filter = t.dataset.filter; $('#chips').innerHTML = chips(); applyFilter(); }
      if (t.id === 'mark-read') {
        CD.markSeen(Math.max(seen, ...flags.map((f) => f.id)));
        $('#flag-list').innerHTML = flags.map(flagRow).join('');
        $('#chips').innerHTML = chips();
        t.disabled = true;
        applyFilter();
        for (const el of $$('.nav-item .badge, .dot-unread')) el.remove();
      }
      if (t.getAttribute('role') === 'tab') {
        for (const b of $$('[role=tab]', t.closest('[data-tabs]'))) {
          const on = b === t;
          b.setAttribute('aria-selected', String(on));
          document.getElementById(b.getAttribute('aria-controls')).hidden = !on;
        }
      }
    });
  }, { title: 'Notifications' });
})();
