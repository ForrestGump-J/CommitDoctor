'use strict';
const fs = require('fs');
const path = require('path');
// Node's built-in SQLite (Node 22.13+). No native compilation, nothing extra to install.
const { DatabaseSync } = require('node:sqlite');
const { maskEmail } = require('./privacy');
const { migrateSingleRepo } = require('./repository');

// Eight tables:
//   commits          the raw material (one row per unique commit SHA)
//   summaries        one saved summary per day (JSON snapshot)
//   webhook_events   every delivery GitHub sent us, accepted or not
//   summary_runs     every attempt to generate a summary, saved or skipped
//   subscribers      notification recipients (storage + CRUD only for now)
//   project_settings single row holding the user-entered project deadline and
//                    the single push-webhook repo (the original tracking path)
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
  date          TEXT PRIMARY KEY,
  total_commits INTEGER NOT NULL,
  data          TEXT    NOT NULL,
  trigger       TEXT    NOT NULL,
  generated_at  TEXT    NOT NULL
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
  date          TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  total_commits INTEGER NOT NULL DEFAULT 0,
  run_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Notification recipients. Storage + CRUD only for now; nothing sends email yet.
CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Single row (id is always 1). Deadline is global. tracked_repo here is only the
-- ORIGINAL push-webhook tracking path (one public/own repo, no token needed);
-- it overrides GITHUB_REPO from .env when set. Multi-repo, token-based tracking
-- lives in tracked_repos below instead.
CREATE TABLE IF NOT EXISTS project_settings (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  deadline_date TEXT,
  tracked_repo  TEXT,
  -- Auto-generated webhook secret, used only when GITHUB_WEBHOOK_SECRET is empty.
  webhook_secret TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Discrete rolling-baseline deviations (activity above/below baseline, contributor
-- inactivity, etc). Regenerated each time that day's summary is generated/saved.
CREATE TABLE IF NOT EXISTS flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- Repos tracked by polling the GitHub REST API with a per-repo personal access
-- token (encrypted at rest — see src/crypto.js), instead of a public webhook.
-- Works for private repos and repos behind NAT/firewalls.
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
  migrateSingleRepo(db);
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