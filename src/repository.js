'use strict';

/**
 * Commit Doctor follows exactly ONE repository (see the paper's scope).
 * project_settings.tracked_repo is the single source of truth; tracked_repos holds
 * at most one row, the encrypted token used when that repo is polled instead of
 * receiving webhooks.
 *
 * Summaries, flags and sent-notification records are keyed by date, not by repo,
 * so switching repositories starts fresh: the previous repo's project data is
 * cleared (audit logs are kept) to keep two projects from being mixed together.
 */

const getSetting = (db) => db.prepare('SELECT tracked_repo FROM project_settings WHERE id = 1').get();

/** The repo commits must belong to, or '' if none is set yet. */
function trackedRepo(db, config) {
  const row = getSetting(db);
  return ((row && row.tracked_repo) || config.repo || '').toLowerCase();
}

/** Repos (other than `repo`) that already have commits stored. */
function otherReposWithData(db, repo) {
  return db
    .prepare('SELECT lower(repo) AS repo, COUNT(*) AS commits FROM commits WHERE lower(repo) <> ? GROUP BY lower(repo)')
    .all(repo);
}

/** Remove the current project's data. Subscribers, the deadline and audit logs stay. */
function clearProjectData(db) {
  for (const table of ['commits', 'summaries', 'flags', 'notifications_sent', 'tracked_repos']) {
    db.exec(`DELETE FROM ${table}`);
  }
}

/**
 * Older versions allowed several polled repos. Keep the one that matches the
 * tracked repo (or else the newest), and make tracked_repo point at it.
 */
function migrateSingleRepo(db) {
  const rows = db.prepare('SELECT id, repo FROM tracked_repos ORDER BY created_at DESC, id DESC').all();
  if (!rows.length) return;
  const setting = getSetting(db);
  const current = setting && setting.tracked_repo ? setting.tracked_repo.toLowerCase() : null;
  const keep = rows.find((r) => r.repo.toLowerCase() === current) || rows[0];
  db.prepare('DELETE FROM tracked_repos WHERE id <> ?').run(keep.id);
  if (!current) db.prepare('UPDATE project_settings SET tracked_repo = ? WHERE id = 1').run(keep.repo.toLowerCase());
}

module.exports = { trackedRepo, otherReposWithData, clearProjectData, migrateSingleRepo };
