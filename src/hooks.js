'use strict';
const crypto = require('crypto');
const { ghFetch, API, LOOKBACK_MS, testRepoAccess, fetchNewCommits, parseApiCommit } = require('./poller');
const { createStore } = require('./store');
const { followedRepos, ensureRepo } = require('./repository');

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
 * Create the push webhook on GitHub (or update ours if one with the same URL
 * already exists). The token is used for these calls only and never stored.
 * Needs a classic token with admin:repo_hook, or a fine-grained token with
 * "Webhooks: read and write" on the repo.
 */
async function connectWebhook({ repo, token, payloadUrl, secret }) {
  const hookConfig = { url: payloadUrl, content_type: 'json', secret, insecure_ssl: '0' };
  const hooks = await (await ghFetch(`${API}/repos/${repo}/hooks?per_page=100`, token)).json();
  const existing = Array.isArray(hooks) ? hooks.find((h) => h.config && h.config.url === payloadUrl) : null;
  if (existing) {
    const res = await ghFetch(`${API}/repos/${repo}/hooks/${existing.id}`, token, {
      method: 'PATCH',
      body: { config: hookConfig, events: ['push'], active: true },
    });
    return { id: (await res.json()).id, created: false };
  }
  const res = await ghFetch(`${API}/repos/${repo}/hooks`, token, {
    method: 'POST',
    body: { name: 'web', config: hookConfig, events: ['push'], active: true },
  });
  return { id: (await res.json()).id, created: true };
}

/**
 * Pull the tracked repo's recent commits straight from GitHub's API, so the
 * dashboard has data the moment a repo is tracked instead of after the next
 * push. Public repos need no token. Only list calls are made (no per-commit
 * detail), which keeps an unauthenticated sync to two or three requests.
 * The outcome is saved on the repo's row in repositories for the dashboard's indicator.
 */
async function syncTrackedRepo({ db, config, repo, token = '' }) {
  ensureRepo(db, repo);
  const update = db.prepare(
    `UPDATE repositories SET last_sync_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       last_sync_error = ?, last_sync_added = ? WHERE repo = ?`
  );
  const save = { run: (error, added) => update.run(error, added, repo.toLowerCase()) };
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
      ? 'Repository not found. If it is private, reconnect it as a private repository with a token.'
      : err.message;
    save.run(message, null);
    return { ok: false, error: message };
  }
}

/** Re-sync every followed repo on a timer. Skips quietly while nothing is followed. */
function startRepoSync({ db, config, log = console, intervalMs = config.syncIntervalMs }) {
  if (!intervalMs) return () => {};
  let running = false;
  const isPolled = db.prepare('SELECT 1 FROM tracked_repos WHERE repo = ?');
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const repo of followedRepos(db, config)) {
        // Polled repos (private, with a token) are kept current by the poller instead.
        if (isPolled.get(repo)) continue;
        // eslint-disable-next-line no-await-in-loop
        const result = await syncTrackedRepo({ db, config, repo });
        if (!result.ok) log.info(`[sync] ${repo}: ${result.error}`);
        else if (result.added) log.info(`[sync] ${repo}: stored ${result.added} new commit(s)`);
      }
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { ensureWebhookSecret, connectWebhook, syncTrackedRepo, startRepoSync };
