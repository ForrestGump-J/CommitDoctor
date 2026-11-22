'use strict';
const fs = require('fs');
const path = require('path');
// Node's built-in SQLite (Node 22.13+). No native compilation, nothing extra to install.
const { DatabaseSync } = require('node:sqlite');
const { maskEmail } = require('./privacy');
const { migrateMultiRepo } = require('./repository');

// Main tables (every per-project table carries a lowercase `repo` column, so
// several repositories can be followed side by side; '' means "no repo set"):
//   repositories     every repository connected so far, its deadline and sync status
//   commits          the raw material (one row per unique commit SHA)
//   summaries        one saved summary per repo per day (JSON snapshot)
//   webhook_events   every delivery GitHub sent us, accepted or not
//   summary_runs     every attempt to generate a summary, saved or skipped
//   subscribers      notification recipients, per repo
//   project_settings single row: the repo the dashboard is showing (tracked_repo),
//                    the single/multiple layout mode and the webhook secret
//   flags            discrete rolling-baseline deviations, one row per flag per day
//   tracked_repos    repos tracked by polling GitHub's API with a per-repo token
//                    (the newer path; works for private repos, no public webhook needed)
// webhook_events and summary_runs are the prototype's own activity log (research question 4).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  sha             TEXT    NOT NULL UNIQUE,
  repo            TEXT    NOT NULL,
  branch          TEXT,
  author_name     TEXT    NOT NULL,
  author_username TEXT,
  author_email    TEXT,
  contributor     TEXT    NOT NULL,
  message         TEXT    NOT NULL,
  url             TEXT,
  is_merge        INTEGER NOT NULL DEFAULT 0,
  committed_at    TEXT    NOT NULL,
  committed_date  TEXT    NOT NULL,
  committed_hour  INTEGER NOT NULL,
  delivery_id     TEXT,
  -- Code churn. files_* are filled for every commit (webhook payloads list
  -- filenames for free; polled repos derive them from the per-commit detail
  -- call). lines_* are line-level insertions/deletions and are only known for
  -- polled repos (an authenticated per-commit call); NULL means "not known",
  -- not zero, so aggregate churn queries should treat NULL as excluded, not 0.
  files_added     INTEGER,
  files_removed   INTEGER,
  files_modified  INTEGER,
  lines_added     INTEGER,
  lines_deleted   INTEGER,
  received_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_commits_date ON commits(committed_date);

CREATE TABLE IF NOT EXISTS summaries (
  repo          TEXT NOT NULL DEFAULT '',
  date          TEXT NOT NULL,
  total_commits INTEGER NOT NULL,
  data          TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  generated_at  TEXT    NOT NULL,
  PRIMARY KEY (repo, date)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id      TEXT,
  event            TEXT,
  repo             TEXT,
  status           TEXT NOT NULL,
  detail           TEXT,
  commits_received INTEGER NOT NULL DEFAULT 0,
  commits_new      INTEGER NOT NULL DEFAULT 0,
  received_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS summary_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  repo          TEXT NOT NULL DEFAULT '',
  date          TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  total_commits INTEGER NOT NULL DEFAULT 0,
  run_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Notification recipients. Each repository has its own list.
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo       TEXT NOT NULL DEFAULT '',
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (repo, email)
);

-- Single row (id is always 1). tracked_repo is the repository the dashboard is
-- showing right now (overrides GITHUB_REPO from .env when set). deadline_date is
-- only used while no repository is set; each repository keeps its own deadline
-- in the repositories table.
CREATE TABLE IF NOT EXISTS project_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  deadline_date TEXT,
  tracked_repo  TEXT,
  -- 'single': one repository is followed, others are kept but hidden and paused.
  -- 'multi': every connected repository is followed; the dashboard hops between them.
  repo_mode     TEXT NOT NULL DEFAULT 'single',
  -- Auto-generated webhook secret, used only when GITHUB_WEBHOOK_SECRET is empty.
  webhook_secret TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Discrete rolling-baseline deviations (activity above/below baseline, contributor
-- inactivity, etc). Regenerated each time that day's summary is generated/saved.
CREATE TABLE IF NOT EXISTS flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  repo       TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_flags_date ON flags(date);

-- Remembers which deadline notices were already emailed, so a restart or an
-- SMTP hiccup can't cause duplicates.
CREATE TABLE IF NOT EXISTS notifications_sent (
  key     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Research question 5: which summary view people use, for how long, and whether
-- they found it helpful. Anonymous: session_id is a random per-browser id.
CREATE TABLE IF NOT EXISTS view_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT    NOT NULL,
  view       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,          -- 'open' or 'dwell'
  value      INTEGER,                   -- dwell: milliseconds the view was on screen
  day        TEXT,                      -- the summary day being looked at
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_view_events_view ON view_events(view);
CREATE TABLE IF NOT EXISTS view_feedback (
  session_id TEXT    NOT NULL,
  view       TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  helpful    INTEGER NOT NULL,          -- 1 = thumbs up, 0 = thumbs down
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (session_id, view, day)
);

-- Research question 6: the feasibility study (GitHub history vs Commit Doctor).
-- Participants are identified only by a facilitator-assigned code such as P01.
CREATE TABLE IF NOT EXISTS study_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT    NOT NULL DEFAULT '', -- the repository the questions were drawn from
  code         TEXT    NOT NULL UNIQUE,
  token_hash   TEXT    NOT NULL,        -- sha256 of the per-session token given to the browser
  plan         TEXT    NOT NULL,        -- JSON: block order, sets, days
  consent_at   TEXT    NOT NULL,
  completed_at TEXT,
  sus_items    TEXT,                    -- JSON array of 10 answers (1-5)
  sus_score    REAL,
  comments     TEXT,                    -- JSON of the open-ended answers
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS study_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
  block       INTEGER NOT NULL,         -- 1 = first condition shown, 2 = second
  condition   TEXT    NOT NULL,         -- 'github' or 'comdoc'
  task_set    TEXT    NOT NULL,         -- 'A' or 'B'
  position    INTEGER NOT NULL,
  prompt      TEXT    NOT NULL,
  kind        TEXT    NOT NULL,         -- 'choice', 'number' or 'yesno'
  options     TEXT,                     -- JSON array for 'choice'
  answer_key  TEXT    NOT NULL,         -- JSON; never sent to the browser
  response    TEXT,
  correct     INTEGER,
  ms          INTEGER,
  answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_study_tasks_session ON study_tasks(session_id);

-- Every repository connected so far. active = 1 means it is being followed
-- (webhook pushes accepted, background sync/polling on). In single mode only the
-- shown repository is active; the others keep their data, hidden, until switched back to.
CREATE TABLE IF NOT EXISTS repositories (
  repo            TEXT PRIMARY KEY,         -- lowercase owner/name
  active          INTEGER NOT NULL DEFAULT 1,
  deadline_date   TEXT,
  last_sync_at    TEXT,                     -- token-free scans of a public repo (src/hooks.js)
  last_sync_error TEXT,
  last_sync_added INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Repositories followed by polling the GitHub REST API with a personal access
-- token (encrypted at rest — see src/crypto.js), instead of a public webhook.
-- Works for private repos and repos behind NAT/firewalls. One row per repo.
CREATE TABLE IF NOT EXISTS tracked_repos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  repo           TEXT    NOT NULL UNIQUE,
  token_enc      TEXT    NOT NULL,
  default_branch TEXT,
  last_since     TEXT,
  last_polled_at TEXT,
  last_error     TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`;

// CREATE TABLE IF NOT EXISTS never adds columns to a table that already exists
// on disk, so new columns on existing tables need an explicit, idempotent
// migration. Safe to call every startup: it only adds what's missing.
function migrate(db) {
  const columnExists = (table, column) =>
    db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
  const addColumn = (table, column, def) => {
    if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  addColumn('commits', 'files_added', 'INTEGER');
  addColumn('commits', 'files_removed', 'INTEGER');
  addColumn('commits', 'files_modified', 'INTEGER');
  addColumn('commits', 'lines_added', 'INTEGER');
  addColumn('commits', 'lines_deleted', 'INTEGER');
  addColumn('project_settings', 'webhook_secret', 'TEXT');
  // Result of the background re-pull of a webhook-tracked repo (src/hooks.js).
  addColumn('project_settings', 'last_sync_at', 'TEXT');
  addColumn('project_settings', 'last_sync_error', 'TEXT');
  addColumn('project_settings', 'last_sync_added', 'INTEGER');

  // Multi-repository support: per-project tables gain a repo column. Existing rows
  // get '' here and are assigned to the tracked repo by migrateMultiRepo().
  addColumn('project_settings', 'repo_mode', "TEXT NOT NULL DEFAULT 'single'");
  addColumn('summary_runs', 'repo', "TEXT NOT NULL DEFAULT ''");
  addColumn('flags', 'repo', "TEXT NOT NULL DEFAULT ''");
  addColumn('study_sessions', 'repo', "TEXT NOT NULL DEFAULT ''");
  // summaries and subscribers change their key/unique constraint, which SQLite can
  // only do by rebuilding the table.
  if (!columnExists('summaries', 'repo')) {
    db.exec(`
      ALTER TABLE summaries RENAME TO summaries_old;
      CREATE TABLE summaries (
        repo TEXT NOT NULL DEFAULT '', date TEXT NOT NULL, total_commits INTEGER NOT NULL,
        data TEXT NOT NULL, trigger TEXT NOT NULL, generated_at TEXT NOT NULL, PRIMARY KEY (repo, date));
      INSERT INTO summaries (repo, date, total_commits, data, trigger, generated_at)
        SELECT '', date, total_commits, data, trigger, generated_at FROM summaries_old;
      DROP TABLE summaries_old;`);
  }
  if (!columnExists('subscribers', 'repo')) {
    db.exec(`
      ALTER TABLE subscribers RENAME TO subscribers_old;
      CREATE TABLE subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE (repo, email));
      INSERT INTO subscribers (id, repo, name, email, created_at) SELECT id, '', name, email, created_at FROM subscribers_old;
      DROP TABLE subscribers_old;`);
  }
  // Repo names are compared lowercase everywhere; webhooks deliver GitHub's casing.
  db.exec('UPDATE commits SET repo = lower(repo) WHERE repo <> lower(repo)');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON commits(repo, committed_date);
    CREATE INDEX IF NOT EXISTS idx_flags_repo_date ON flags(repo, date);`);

  // Older versions stored committer emails and could use one as the contributor
  // label. Drop the stored emails and mask any email-shaped labels. Idempotent.
  db.exec('UPDATE commits SET author_email = NULL WHERE author_email IS NOT NULL');
  const relabel = db.prepare('UPDATE commits SET contributor = ?, author_name = CASE WHEN author_name = contributor THEN ? ELSE author_name END WHERE contributor = ?');
  for (const { contributor } of db.prepare("SELECT DISTINCT contributor FROM commits WHERE contributor LIKE '%_@_%' AND contributor NOT LIKE '_***@%'").all()) {
    const masked = maskEmail(contributor);
    relabel.run(masked, masked, contributor);
  }
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec("INSERT OR IGNORE INTO project_settings (id, deadline_date) VALUES (1, NULL);");
  migrateMultiRepo(db);
  return db;
}

/** Wrap fn so all its writes succeed together or not at all. */
function transaction(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

module.exports = { openDb, transaction };