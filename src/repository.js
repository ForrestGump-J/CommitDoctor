'use strict';

/**
 * Which repositories Commit Doctor follows, and which one the dashboard shows.
 *
 *  - repositories        every repo connected so far (lowercase owner/name), its own
 *                        deadline and sync status. active = 1 means it is followed:
 *                        webhook pushes are accepted and background sync/polling run.
 *  - project_settings    tracked_repo = the repo the dashboard is showing ("active"
 *                        repo); repo_mode = 'single' or 'multi'.
 *  - tracked_repos       the encrypted token of each repo that is polled instead of
 *                        receiving webhooks (at most one row per repo).
 *
 * Every per-project table (commits, summaries, flags, summary_runs, subscribers,
 * notifications_sent keys) is keyed by repo, so switching never mixes two projects
 * and never deletes data. In single mode the other repos are paused and hidden;
 * in multi mode they all stay followed and the dashboard hops between them.
 */

// SQL fragment limiting a table with a `repo` column to one repo. Pass { repo } as
// the statement's first argument (named parameters), then any positional ones.
// '' (no repository set yet) means "everything", the original single-repo default.
const IN_REPO = "(@repo = '' OR repo = @repo)";

const norm = (repo) => String(repo || '').trim().toLowerCase();

const getSetting = (db) => db.prepare('SELECT tracked_repo, repo_mode FROM project_settings WHERE id = 1').get() || {};

/** The repo the dashboard is showing, or '' if none is set yet. */
function trackedRepo(db, config) {
  return norm(getSetting(db).tracked_repo || config.repo || '');
}

function repoMode(db) {
  return getSetting(db).repo_mode === 'multi' ? 'multi' : 'single';
}

/** Repos being followed: every active repository plus the shown one. */
function followedRepos(db, config) {
  const set = new Set(db.prepare('SELECT repo FROM repositories WHERE active = 1').all().map((r) => r.repo));
  const shown = trackedRepo(db, config);
  if (shown) set.add(shown);
  return [...set].sort();
}

/**
 * May commits from `repo` be stored? Only followed repos are accepted; with nothing
 * set up at all, any repo is (the original "accept anything until told otherwise").
 */
function acceptsRepo(db, config, repo) {
  const followed = followedRepos(db, config);
  return followed.length === 0 || followed.includes(norm(repo));
}

/** The repos the scheduler should summarize: followed ones, or '' when none are set. */
function reposToProcess(db, config) {
  const followed = followedRepos(db, config);
  return followed.length ? followed : [''];
}

function ensureRepo(db, repo) {
  db.prepare('INSERT OR IGNORE INTO repositories (repo) VALUES (?)').run(norm(repo));
}

/** Pause or resume a repo; its polling token row follows along. */
function setActive(db, repo, active) {
  db.prepare('UPDATE repositories SET active = ? WHERE repo = ?').run(active ? 1 : 0, repo);
  db.prepare('UPDATE tracked_repos SET active = ? WHERE repo = ?').run(active ? 1 : 0, repo);
}

/**
 * Show `repo` on the dashboard and follow it. In single mode every other repo is
 * paused (kept, hidden). Callers wrap this in a transaction.
 */
function showRepo(db, repo) {
  const r = norm(repo);
  ensureRepo(db, r);
  if (repoMode(db) === 'single') {
    for (const { repo: other } of db.prepare('SELECT repo FROM repositories WHERE repo <> ? AND active = 1').all(r)) setActive(db, other, false);
  }
  setActive(db, r, true);
  db.prepare(`UPDATE project_settings SET tracked_repo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(r);
}

/** Every repository with its stored commit count, newest first. */
function listRepos(db, config) {
  const shown = trackedRepo(db, config);
  return db.prepare(
    `SELECT r.repo, r.active, r.deadline_date, r.created_at,
            (SELECT COUNT(*) FROM commits c WHERE c.repo = r.repo) AS commits,
            (SELECT MAX(committed_at) FROM commits c WHERE c.repo = r.repo) AS last_commit_at,
            EXISTS (SELECT 1 FROM tracked_repos t WHERE t.repo = r.repo) AS polled
     FROM repositories r ORDER BY r.created_at DESC, r.repo`
  ).all().map((r) => ({
    repo: r.repo,
    active: Boolean(r.active),
    shown: r.repo === shown,
    method: r.polled ? 'poll' : 'webhook',
    deadline_date: r.deadline_date,
    commits: r.commits,
    last_commit_at: r.last_commit_at,
    created_at: r.created_at,
  }));
}

/** Delete one repository and everything recorded for it. Audit logs stay. */
function deleteRepoData(db, repo) {
  for (const table of ['commits', 'summaries', 'summary_runs', 'flags', 'subscribers', 'tracked_repos', 'repositories']) {
    db.prepare(`DELETE FROM ${table} WHERE repo = ?`).run(repo);
  }
  db.prepare('DELETE FROM notifications_sent WHERE key LIKE ?').run(`${repo}|%`);
}

/** The deadline that applies to `repo` ('' = the global fallback). */
function getDeadline(db, repo) {
  if (!repo) {
    const row = db.prepare('SELECT deadline_date FROM project_settings WHERE id = 1').get();
    return row ? row.deadline_date : null;
  }
  const row = db.prepare('SELECT deadline_date FROM repositories WHERE repo = ?').get(repo);
  return row ? row.deadline_date : null;
}

function setDeadline(db, repo, date) {
  if (!repo) {
    db.prepare(`UPDATE project_settings SET deadline_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(date);
    return;
  }
  ensureRepo(db, repo);
  db.prepare('UPDATE repositories SET deadline_date = ? WHERE repo = ?').run(date, repo);
}

/**
 * Upgrade a database from the single-repository version. Runs every start and only
 * does work that is still missing:
 *  - every repo seen in commits, tracked_repos or tracked_repo gets a repositories row
 *    (only the tracked one stays active; the rest are kept but paused)
 *  - rows written before repos were recorded (repo = '') are given the tracked repo
 *  - the global deadline and sync status move onto the tracked repo
 */
function migrateMultiRepo(db) {
  const setting = db.prepare('SELECT tracked_repo, deadline_date, last_sync_at, last_sync_error, last_sync_added FROM project_settings WHERE id = 1').get();
  if (!setting) return;
  const current = norm(setting.tracked_repo);
  if (current && current !== setting.tracked_repo) db.prepare('UPDATE project_settings SET tracked_repo = ? WHERE id = 1').run(current);
  db.exec('UPDATE tracked_repos SET repo = lower(repo) WHERE repo <> lower(repo)');

  const known = new Set([
    ...db.prepare('SELECT DISTINCT repo FROM commits').all().map((r) => r.repo),
    ...db.prepare('SELECT repo FROM tracked_repos').all().map((r) => r.repo),
  ]);
  if (current) known.add(current);
  const insert = db.prepare('INSERT OR IGNORE INTO repositories (repo, active) VALUES (?, ?)');
  const isNew = db.prepare('SELECT 1 FROM repositories WHERE repo = ?');
  for (const repo of known) {
    if (!repo || isNew.get(repo)) continue;
    insert.run(repo, repo === current || !current ? 1 : 0);
    db.prepare('UPDATE tracked_repos SET active = ? WHERE repo = ?').run(repo === current || !current ? 1 : 0, repo);
  }

  if (!current) return;
  for (const table of ['summaries', 'summary_runs', 'flags', 'subscribers', 'study_sessions']) {
    db.prepare(`UPDATE OR IGNORE ${table} SET repo = ? WHERE repo = ''`).run(current);
  }
  // notifications_sent keys used to be "<date>: <tier>"; they are now "<repo>|<date>: <tier>".
  db.prepare("UPDATE OR IGNORE notifications_sent SET key = ? || '|' || key WHERE instr(key, '|') = 0").run(current);
  if (setting.deadline_date) {
    db.prepare('UPDATE repositories SET deadline_date = COALESCE(deadline_date, ?) WHERE repo = ?').run(setting.deadline_date, current);
    db.prepare('UPDATE project_settings SET deadline_date = NULL WHERE id = 1').run();
  }
  if (setting.last_sync_at) {
    db.prepare('UPDATE repositories SET last_sync_at = ?, last_sync_error = ?, last_sync_added = ? WHERE repo = ? AND last_sync_at IS NULL')
      .run(setting.last_sync_at, setting.last_sync_error, setting.last_sync_added, current);
    db.prepare('UPDATE project_settings SET last_sync_at = NULL, last_sync_error = NULL, last_sync_added = NULL WHERE id = 1').run();
  }
}

module.exports = {
  IN_REPO, norm, trackedRepo, repoMode, followedRepos, acceptsRepo, reposToProcess,
  ensureRepo, setActive, showRepo, listRepos, deleteRepoData, getDeadline, setDeadline, migrateMultiRepo,
};
