/* Commits: the day's commits of the shown repository, or one commit in detail (?sha=). */
(function () {
  'use strict';
  const { $, esc, plural, ic, avatar, pill, get } = CD;

  async function list(main) {
    let date = CD.initialDate();
    let commits = [];
    const draw = () => {
      const q = ($('#filter') || {}).value || '';
      const needle = q.trim().toLowerCase();
      const shown = needle ? commits.filter((c) => `${c.message} ${c.contributor} ${c.sha} ${c.branch || ''} ${c.intent ? c.intent.intent : ''}`.toLowerCase().includes(needle)) : commits;
      $('#commit-list').innerHTML = shown.length ? shown.map(CD.feedItem).join('')
        : `<p class="empty">${commits.length ? 'No commits match that filter.' : 'No commits on this day.'}</p>`;
      $('#commit-count').textContent = needle ? `${shown.length} of ${plural(commits.length, 'commit')}` : plural(commits.length, 'commit');
    };
    const load = async () => {
      commits = await get(`/commits?date=${date}`);
      main.querySelector('.page-head').outerHTML = CD.pageHead('Commits', `${CD.dayLong(date)}${CD.ctx.overview.repo ? ` · ${CD.ctx.overview.repo}` : ''}`, CD.dayNav(date));
      draw();
    };
    main.innerHTML = `${CD.pageHead('Commits', '')}
      <section class="card solid"><div class="card-head"><h2 id="commit-count"></h2>
        <label class="field-row" style="flex:0 1 320px"><span class="visually-hidden">Filter commits</span><input id="filter" class="input" type="search" placeholder="Filter by message, author, SHA or intent" autocomplete="off"></label></div>
        <div id="commit-list"></div></section>`;
    $('#filter').addEventListener('input', draw);
    CD.wireDayNav(main, () => date, (d) => { date = d; CD.setDateParam(d); load(); });
    await load();
  }

  async function detail(main, sha) {
    let c;
    try {
      c = await get(`/commits/${encodeURIComponent(sha)}`);
    } catch (err) {
      main.innerHTML = `${CD.pageHead('Commit not found', '')}<section class="card"><p class="hint">${esc(err.message)}</p><p style="margin-top:12px"><a class="btn" href="commit.html">${ic('left', 14)} All commits</a></p></section>`;
      return;
    }
    document.title = `Commit ${c.short_sha} · Commit Doctor`;
    const [first, ...rest] = String(c.message).split('\n');
    const url = CD.safeUrl(c.url);
    const ch = c.churn;
    const known = ch.lines_added != null && ch.lines_deleted != null;
    const it = c.intent;
    const intentLine = c.is_merge
      ? 'This is a merge commit, so it was not classified.'
      : it ? (it.sure
        ? `From the commit message, this is most likely <strong>${esc(it.intent)}</strong> work. Labels this clear were right about 8 times in 10 in testing.`
        : `The classifier's best guess is <strong>${esc(it.intent)}</strong>, but it isn't sure (the message doesn't say much it recognises), so treat it as a guess.`) : '';
    const nFiles = CD.fileCount(ch);
    const max = Math.max(1, ch.files_added || 0, ch.files_modified || 0, ch.files_removed || 0);
    const row = (label, n, cls) => `<div class="file-row"><span class="${cls}">${label}</span><div class="track"><i style="--w:${Math.round(((n || 0) / max) * 100)}%"></i></div><span class="count">${n ?? '—'}</span></div>`;
    main.innerHTML = `<nav class="crumbs" aria-label="Breadcrumb"><a href="commit.html?date=${esc(c.date)}">Commits</a>${ic('right', 14)}<span>${esc(c.short_sha)}</span><span class="spacer"></span>
        ${url ? `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">View on GitHub ${ic('ext', 12)}</a>` : ''}</nav>
      ${CD.pageHead(`Commit ${c.short_sha}`, first || '(no message)')}
      <div class="meta">${avatar(c.contributor, 28)}<span style="color:var(--snow);font-weight:500">${esc(c.contributor)}</span>${c.author_name && c.author_name !== c.contributor ? `<span>${esc(c.author_name)}</span>` : ''}
        ${c.branch ? pill(c.branch, '#9AA3B5') : ''}<a class="link" href="index.html?date=${esc(c.date)}">${esc(CD.dayLong(c.date))}</a><span>${esc(c.time)}</span><span>${CD.filesText(ch)}</span></div>
      <section class="ai" aria-labelledby="ci-h"><div class="ai-title"><span class="ai-icon">${ic('note', 18)}</span><h2 id="ci-h">Commit intent</h2>${CD.help('intent')}<span class="spacer"></span>${CD.intentTag(c)}</div>
        <p class="lead">${esc(first || '(no message)')}</p><p class="hint">${intentLine}</p></section>
      <div class="cols cols-commit cols-stretch">
        <section class="card solid"><div class="card-head"><h2>Raw commit message</h2><button class="btn" data-copy="#raw-msg">${ic('copy', 14)} Copy</button></div><div class="codeblock" id="raw-msg">${esc(c.message)}</div>
          ${rest.join('').trim() ? '' : '<p class="note" style="margin-top:8px">Single-line message.</p>'}</section>
        <section class="card"><div class="card-head"><h2>Code churn${CD.help('churn')}</h2></div>
          ${known
            ? `<div class="big"><span class="add">+${Number(ch.lines_added)}</span>&nbsp;&nbsp;<span class="del">−${Number(ch.lines_deleted)}</span></div>
               <div class="split" style="margin:12px 0" role="img" aria-label="Added versus removed lines"><i style="--p:${Math.max(ch.lines_added, 0.01)};--c:#60A5FA"></i><i style="--p:${Math.max(ch.lines_deleted, 0.01)};--c:#A855F7"></i></div>`
            : nFiles != null
              ? `<p class="big">${plural(nFiles, 'file')}</p><p class="sub" style="margin:8px 0">Line counts are only recorded for repositories checked with a token; this commit has file counts.</p>`
              : `<p class="big">Not recorded</p><p class="sub" style="margin:8px 0">${esc(CD.NO_FILES)}</p>`}
          <p class="note">Context only, not a measure of output</p></section></div>
      ${nFiles == null ? '' : CD.hideable('Files changed', `${row('Added', ch.files_added, 'add')}${row('Modified', ch.files_modified, '')}${row('Removed', ch.files_removed, 'del')}`, 'Counts from GitHub. Individual file names and contents are not recorded.')}
      <section class="card solid"><div class="card-head"><h2>Related commits</h2><span class="sub">Same contributor, nearest in time</span></div>
        ${c.related.length ? c.related.map(CD.feedItem).join('') : '<p class="note">No other commits by this contributor.</p>'}</section>`;
  }

  CD.start('commits', async (main) => {
    const sha = new URLSearchParams(window.location.search).get('sha');
    if (sha) await detail(main, sha); else await list(main);
  }, { title: 'Commits' });
})();
