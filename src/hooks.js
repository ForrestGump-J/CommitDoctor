'use strict';
const crypto = require('crypto');
const { LOOKBACK_MS, testRepoAccess, fetchNewCommits, parseApiCommit } = require('./poller');
const { createStore } = require('./store');
const { currentScope } = require('./scope');

/**
 * Make sure config.webhookSecret is set. GITHUB_WEBHOOK_SECRET from .env wins;
 * otherwise a random secret is generated once and kept in project_settings, so
 * the webhook works out of the box without editing .env.
 */
function ensureWebhookSecret(db, config) {
  if (config.webhookSecret) return 'env';
  const row = db.prepare('SELECT webhook_secret FROM project_settings WHERE id = 1').get();
  if (row && row.webhook_secret) {
    config.webhookSecret = row.webhook_secret;
  } else {
    config.webhookSecret = crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE project_settings SET webhook_secret = ? WHERE id = 1').run(config.webhookSecret);
  }
  return 'generated';
}

/**
 * Pull the tracked repo's recent commits straight from GitHub's API, so the
 * dashboard has data the moment a repo is tracked instead of after the next
 * push. Public repos need no token. Only list calls are made (no per-commit
 * detail), which keeps an unauthenticated sync to two or three requests.
 * The outcome is saved on project_settings for the dashboard's indicator.
 */
async function syncTrackedRepo({ db, config, repo, token = '' }) {
  const save = db.prepare(
    `UPDATE project_settings SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       last_sync_error = ?, last_sync_added = ? WHERE id = 1`
  );
  try {
    const { defaultBranch } = await testRepoAccess(repo, token);
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const raw = await fetchNewCommits(repo, token, since);
    const added = createStore(db, config).addMany(
      raw.filter((c) => c && c.sha).map((c) => parseApiCommit(c, repo, defaultBranch))
    );
    save.run(null, added);
    return { ok: true, added, fetched: raw.length };
  } catch (err) {
    const message = err.status === 404 && !token
      ? 'Repository not found. If it is private, add it under Private repos with a token instead.'
      : err.message;
    save.run(message, null);
    return { ok: false, error: message };
  }
}

/** Re-sync the tracked repo on a timer. Skips quietly while nothing is tracked. */
function startRepoSync({ db, config, log = console, intervalMs = config.syncIntervalMs }) {
  if (!intervalMs) return () => {};
  let running = false;
  const timer = setInterval(async () => {
    const repo = currentScope(db, config);
    if (!repo || running) return;
    running = true;
    try {
      const result = await syncTrackedRepo({ db, config, repo });
      if (!result.ok) log.info(`[sync] ${repo}: ${result.error}`);
      else if (result.added) log.info(`[sync] ${repo}: stored ${result.added} new commit(s)`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { ensureWebhookSecret, syncTrackedRepo, startRepoSync };
