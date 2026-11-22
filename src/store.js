'use strict';
const { localDate, localHour } = require('./time');
const { transaction } = require('./db');
const { maskEmail } = require('./privacy');
const { acceptsRepo, norm } = require('./repository');

const MERGE_RE = /^Merge (pull request|branch|remote-tracking branch)\b/i;

/**
 * Write side of the commits table.
 * A "raw" commit is what the webhook parser (or the seed script) produces:
 * { sha, repo, branch, authorName, authorUsername, authorEmail, message, url, timestamp, deliveryId }
 */
function createStore(db, config) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO commits
      (sha, repo, branch, author_name, author_username, author_email, contributor,
       message, url, is_merge, committed_at, committed_date, committed_hour, delivery_id,
       files_added, files_removed, files_modified, lines_added, lines_deleted)
    VALUES
      (@sha, @repo, @branch, @author_name, @author_username, @author_email, @contributor,
       @message, @url, @is_merge, @committed_at, @committed_date, @committed_hour, @delivery_id,
       @files_added, @files_removed, @files_modified, @lines_added, @lines_deleted)
  `);

  /**
   * Returns 1 if the commit was new, 0 if this SHA was already stored.
   * filesAdded/filesRemoved/filesModified: file counts, available from both the
   * push payload and the poller's per-commit detail call.
   * linesAdded/linesDeleted: line-level churn, only known when the caller has
   * fetched per-commit stats (currently: the poller, for polled repos). Leave
   * undefined when not known — stored as NULL, not 0.
   */
  function addCommit(c) {
    // Only repositories that are being followed; never a stranger's pushes.
    if (!acceptsRepo(db, config, c.repo)) return 0;
    const when = new Date(c.timestamp);
    if (Number.isNaN(when.getTime())) return 0;
    // The committer's email is never stored (data minimization: nothing reads it).
    // It's used only as a last-resort label, masked, when a commit has no name.
    const contributor = c.authorUsername || c.authorName || (c.authorEmail ? maskEmail(c.authorEmail) : 'unknown');
    const message = String(c.message || '').trim();
    const numOrNull = (v) => (Number.isFinite(v) ? v : null);
    return insert.run({
      sha: c.sha,
      repo: norm(c.repo),
      branch: c.branch || null,
      author_name: c.authorName || contributor,
      author_username: c.authorUsername || null,
      author_email: null,
      contributor,
      message,
      url: c.url || null,
      is_merge: MERGE_RE.test(message) ? 1 : 0,
      committed_at: when.toISOString(),
      committed_date: localDate(when, config.timezone),
      committed_hour: localHour(when, config.timezone),
      delivery_id: c.deliveryId || null,
      files_added: numOrNull(c.filesAdded),
      files_removed: numOrNull(c.filesRemoved),
      files_modified: numOrNull(c.filesModified),
      lines_added: numOrNull(c.linesAdded),
      lines_deleted: numOrNull(c.linesDeleted),
    }).changes;
  }

  const addMany = transaction(db, (list) => list.reduce((n, c) => n + addCommit(c), 0));

  return { addCommit, addMany };
}

module.exports = { createStore };