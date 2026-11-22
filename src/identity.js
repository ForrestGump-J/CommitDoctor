'use strict';
/**
 * One person, one contributor.
 *
 * GitHub only attaches a username to a commit when the author's email is linked
 * to an account. Commits made before that (or from another machine) arrive with
 * just the git name, so the same person could show up twice: "Mirai" (name only)
 * and "notsyou" (username, git name "Mirai"). That split also raises false
 * "contributor inactive" flags for the name-only half.
 *
 * Rule: a name-only commit belongs to the username whose commits in the same
 * repository carry the same git name (ignoring case), but only when exactly one
 * username does. Two people sharing a git name are left apart.
 */
const { buildSummary } = require('./summary');

/** The one username whose commits in `repo` use this git name, or null. */
function usernameFor(db, repo, name) {
  if (!name) return null;
  const rows = db
    .prepare('SELECT DISTINCT author_username AS u FROM commits WHERE repo = ? AND lower(author_name) = lower(?) AND author_username IS NOT NULL LIMIT 2')
    .all(repo, name);
  return rows.length === 1 ? rows[0].u : null;
}

/**
 * Attribute earlier name-only commits with this git name to `username`, then tidy
 * what was derived from the old split: inactivity flags about the name-only label
 * and the contributor lists inside saved daily summaries (their text and flags are
 * otherwise kept as saved). Returns how many commits were re-attributed.
 */
function linkName(db, config, repo, name, username) {
  if (!name || !username || usernameFor(db, repo, name) !== username) return 0;
  const stale = db
    .prepare('SELECT DISTINCT contributor, committed_date AS d FROM commits WHERE repo = ? AND author_username IS NULL AND lower(author_name) = lower(?) AND contributor <> ?')
    .all(repo, name, username);
  if (!stale.length) return 0;
  const moved = db
    .prepare('UPDATE commits SET contributor = ? WHERE repo = ? AND author_username IS NULL AND lower(author_name) = lower(?) AND contributor <> ?')
    .run(username, repo, name, username).changes;
  const dropFlag = db.prepare("DELETE FROM flags WHERE repo = ? AND type = 'contributor_inactive' AND instr(detail, ?) = 1");
  for (const label of new Set(stale.map((s) => s.contributor))) dropFlag.run(repo, `${label} has had no commits since `);
  const saved = db.prepare('SELECT data FROM summaries WHERE repo = ? AND date = ?');
  const update = db.prepare('UPDATE summaries SET data = ? WHERE repo = ? AND date = ?');
  for (const date of new Set(stale.map((s) => s.d))) {
    const row = saved.get(repo, date);
    if (!row) continue;
    const old = JSON.parse(row.data);
    const fresh = buildSummary(db, config, date, repo);
    update.run(JSON.stringify({ ...old, contributors: fresh.contributors, contributor_count: fresh.contributor_count, headline: fresh.headline }), repo, date);
  }
  return moved;
}

/** Startup repair for data stored before this rule existed. Idempotent. */
function relinkAll(db, config) {
  const pairs = db
    .prepare(`SELECT DISTINCT c.repo, n.author_name AS name, c.author_username AS u
              FROM commits n JOIN commits c ON c.repo = n.repo AND lower(c.author_name) = lower(n.author_name) AND c.author_username IS NOT NULL
              WHERE n.author_username IS NULL AND n.contributor <> c.author_username`)
    .all();
  let moved = 0;
  for (const p of pairs) moved += linkName(db, config, p.repo, p.name, p.u);
  return moved;
}

module.exports = { usernameFor, linkName, relinkAll };
