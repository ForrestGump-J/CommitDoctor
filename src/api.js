'use strict';
const { buildAnalytics } = require('./analytics');
const crypto = require('crypto');
const express = require('express');
const { localDate, localTime, addDays, daysBetween, isDateStr } = require('./time');
const { getSummary, generateSummary, getTrend } = require('./summary');
const { predictDeadline } = require('./predict');
const { checkDeadlineUrgency } = require('./notify');
const { encryptToken } = require('./crypto');
const { testRepoAccess, pollOneRepo } = require('./poller');
const { classify, CONFIDENT } = require('./intent');
const { connectWebhook, syncTrackedRepo } = require('./hooks');
const { maskEmail } = require('./privacy');
const {
  IN_REPO, norm, trackedRepo, repoMode, followedRepos, setActive, showRepo, listRepos,
  deleteRepoData, getDeadline, setDeadline,
} = require('./repository');
const { createViewsRouter } = require('./views');
const { createStudyRouter } = require('./study');
const { transaction } = require('./db');

const clamp = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function createApiRouter({ db, config, mailer = null }) {
  const router = express.Router();
  const tz = config.timezone;

  // With no ADMIN_TOKEN, writes are allowed only from a browser or script on the
  // server machine itself. Each check closes a way around a plain IP test:
  //   - loopback socket: the request really arrived on 127.0.0.1 / ::1
  //   - no proxy headers: ngrok, cloudflared, Render etc. also connect from
  //     loopback, so a forwarded request would otherwise look local
  //   - local Host header: blocks DNS rebinding (evil.com resolving to 127.0.0.1)
  //   - local or absent Origin: blocks cross-site form posts (CSRF) from a page
  //     opened in a browser on the server machine
  const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
  const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];
  const hostnameOf = (hostHeader) => String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  const isLocalOrigin = (origin) => {
    if (!origin) return true;
    try { return LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase().replace(/^::1$/, '[::1]')); } catch { return false; }
  };
  const isTrustedLocal = (req) =>
    LOOPBACK_IPS.has(req.socket.remoteAddress) &&
    PROXY_HEADERS.every((h) => req.headers[h] === undefined) &&
    LOCAL_HOSTS.has(hostnameOf(req.headers.host)) &&
    isLocalOrigin(req.headers.origin);

  const requireAdmin = (req, res, next) => {
    if (!config.adminToken) {
      // No token configured: only the machine running the server may change things.
      if (isTrustedLocal(req)) return next();
      return res.status(401).json({ error: 'No ADMIN_TOKEN is set on this server, so changes are only allowed from the server itself. Set ADMIN_TOKEN in .env and restart.' });
    }
    const header = req.get('authorization') || '';
    if (safeEqual(header, `Bearer ${config.adminToken}`)) return next();
    return res.status(401).json({ error: 'Admin token required.' });
  };

  const validDate = (req, res, next) => {
    if (!isDateStr(req.params.date)) return res.status(400).json({ error: 'Date must look like 2026-09-20.' });
    return next();
  };

  // Settings of the repository the dashboard is showing (each repo has its own deadline).
  const readSettings = () => {
    const row = db.prepare('SELECT updated_at FROM project_settings WHERE id = 1').get();
    const repo = trackedRepo(db, config);
    const deadline = getDeadline(db, repo);
    const today = localDate(Date.now(), tz);
    return {
      deadline_date: deadline,
      days_remaining: deadline ? daysBetween(today, deadline) : null,
      tracked_repo: repo || null,
      repo_mode: repoMode(db),
      updated_at: row ? row.updated_at : null,
    };
  };

  // Is GitHub actually delivering for the shown repo? Judged from the newest
  // delivery that concerns it, so a later failure (e.g. a changed secret) shows up
  // right away. Deliveries for the other followed repos don't count either way.
  //   waiting    nothing received yet
  //   failing    the newest delivery was rejected (bad secret, wrong content type)
  //   other_repo deliveries are arriving, but from a repository that isn't followed
  //   connected  the newest delivery came from the shown repo (ping or push)
  const lastEventFor = (repo) => {
    const others = followedRepos(db, config).filter((r) => r !== repo);
    const skip = others.length ? `WHERE repo IS NULL OR lower(repo) NOT IN (${others.map(() => '?').join(',')})` : '';
    return db.prepare(`SELECT event, repo, status, detail, received_at FROM webhook_events ${skip} ORDER BY id DESC LIMIT 1`).get(...others);
  };
  const lastOkFor = db.prepare(
    `SELECT event, received_at FROM webhook_events
     WHERE status = 'accepted' AND event IN ('ping', 'push') AND lower(repo) = ? ORDER BY id DESC LIMIT 1`
  );
  function webhookStatus(trackedRepo) {
    const last = lastEventFor(trackedRepo);
    const ok = trackedRepo ? lastOkFor.get(trackedRepo) : null;
    const base = { last_ok_event: ok ? ok.event : null, last_ok_at: ok ? ok.received_at : null };
    if (!last) return { state: 'waiting', ...base };
    if (last.status === 'rejected') return { state: 'failing', detail: last.detail, at: last.received_at, ...base };
    const lastRepo = (last.repo || '').toLowerCase();
    if (trackedRepo && lastRepo && lastRepo !== trackedRepo) {
      return { state: 'other_repo', repo_seen: last.repo, at: last.received_at, ...base };
    }
    return { state: ok ? 'connected' : 'waiting', ...base };
  }

  router.get('/health', (_req, res) => res.json({ ok: true }));

  // Everything the dashboard header needs in one call.
  router.get('/overview', (_req, res) => {
    const repo = trackedRepo(db, config);
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS commits, COUNT(DISTINCT contributor) AS contributors,
                COUNT(DISTINCT committed_date) AS days, MIN(committed_date) AS first_date
         FROM commits WHERE ${IN_REPO}`
      )
      .get({ repo });
    const lastAccepted = (event) => db
      .prepare(`SELECT received_at FROM webhook_events WHERE status = 'accepted' AND event = ? AND (@repo = '' OR lower(repo) = @repo) ORDER BY id DESC LIMIT 1`)
      .get({ repo }, event);
    const lastPush = lastAccepted('push');
    const lastPing = lastAccepted('ping');
    const settings = readSettings();
    const lastSaved = db.prepare('SELECT date FROM summaries WHERE repo = ? ORDER BY date DESC LIMIT 1').get(repo);
    const activityCounts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM webhook_events) AS webhook_events_count,
                (SELECT COUNT(*) FROM summary_runs) AS summary_runs_count`
      )
      .get();
    res.json({
      today: localDate(Date.now(), tz),
      timezone: tz,
      repo: settings.tracked_repo,
      repo_mode: settings.repo_mode,
      repositories: listRepos(db, config),
      rules: { min_commits: config.summary.minCommits, comparison_days: config.summary.comparisonDays },
      secret_configured: Boolean(config.webhookSecret),
      totals,
      last_push_at: lastPush ? lastPush.received_at : null,
      last_ping_at: lastPing ? lastPing.received_at : null,
      webhook: webhookStatus(settings.tracked_repo),
      last_saved_date: lastSaved ? lastSaved.date : null,
      activity_log: activityCounts,
      settings,
    });
  });

  // Analytics page: activity, work mix, pace, churn and contributors over 30/60/90 days.
  router.get('/analytics', (req, res) => {
    const days = Number(req.query.days || 30);
    if (![30, 60, 90].includes(days)) return res.status(400).json({ error: 'days must be 30, 60 or 90.' });
    return res.json(buildAnalytics(db, config, { days }));
  });

  router.get('/trend', (req, res) => {
    res.json(getTrend(db, config, clamp(req.query.days, 1, 60, 14)));
  });

  router.get('/summaries', (req, res) => {
    const rows = db
      .prepare('SELECT date, total_commits, trigger, generated_at, data FROM summaries WHERE repo = ? ORDER BY date DESC LIMIT ?')
      .all(trackedRepo(db, config), clamp(req.query.limit, 1, 100, 30));
    res.json(
      rows.map((r) => ({
        date: r.date,
        total_commits: r.total_commits,
        trigger: r.trigger,
        generated_at: r.generated_at,
        headline: JSON.parse(r.data).headline,
        intents: JSON.parse(r.data).intents || {},
      }))
    );
  });

  router.get('/summaries/:date', validDate, (req, res) => {
    res.json(getSummary(db, config, req.params.date));
  });

  // Manual "save the summary now" (also handy for demos and testing).
  router.post('/summaries/:date/generate', requireAdmin, validDate, (req, res) => {
    const result = generateSummary(db, config, req.params.date, 'manual', { force: true });
    res.status(result.saved ? 200 : 409).json(result);
  });

  const publicCommit = (r) => ({
        sha: r.sha,
        short_sha: r.sha.slice(0, 7),
        message: r.message,
        contributor: r.contributor,
        author_name: r.author_name,
        branch: r.branch,
        url: r.url,
        is_merge: Boolean(r.is_merge),
        // NLP label (src/intent.js); the dashboard marks low-confidence guesses.
        intent: r.is_merge ? null : (({ intent, confidence }) => ({ intent, confidence, sure: confidence >= CONFIDENT }))(classify(r.message)),
        committed_at: r.committed_at,
        time: localTime(r.committed_at, tz),
        // files_*: known for every commit. lines_*: null unless this commit came
        // from a polled (token-tracked) repo — see src/poller.js.
        churn: {
          files_added: r.files_added,
          files_removed: r.files_removed,
          files_modified: r.files_modified,
          lines_added: r.lines_added,
          lines_deleted: r.lines_deleted,
        },
  });

  router.get('/commits', (req, res) => {
    const date = req.query.date || localDate(Date.now(), tz);
    if (!isDateStr(date)) return res.status(400).json({ error: 'date must look like 2026-09-20.' });
    const rows = db
      .prepare(`SELECT * FROM commits WHERE committed_date = ? AND ${IN_REPO} ORDER BY committed_at DESC LIMIT ?`)
      .all({ repo: trackedRepo(db, config) }, date, clamp(req.query.limit, 1, 500, 200));
    return res.json(rows.map(publicCommit));
  });

  // One commit (full or abbreviated SHA) of the shown repo, plus its neighbours by
  // the same contributor, for the commit detail page.
  router.get('/commits/:sha', (req, res) => {
    const sha = String(req.params.sha || '').toLowerCase();
    if (!/^[0-9a-f]{4,40}$/.test(sha)) return res.status(400).json({ error: 'sha must be 4-40 hex characters.' });
    const repo = trackedRepo(db, config);
    const matches = db.prepare(`SELECT * FROM commits WHERE sha LIKE ? AND ${IN_REPO} LIMIT 2`).all({ repo }, `${sha}%`);
    if (!matches.length) return res.status(404).json({ error: 'Commit not found in this repository.' });
    if (matches.length > 1) return res.status(409).json({ error: 'That short SHA matches more than one commit; use more characters.' });
    const c = matches[0];
    const related = db.prepare(
      `SELECT * FROM commits WHERE sha <> ? AND contributor = ? AND ${IN_REPO}
       ORDER BY abs(julianday(committed_at) - julianday(?)) LIMIT 3`
    ).all({ repo }, c.sha, c.contributor, c.committed_at);
    return res.json({ ...publicCommit(c), date: c.committed_date, related: related.map(publicCommit) });
  });

  // --- Project settings (currently just the manually-entered deadline, and the
  // single push-webhook repo — see tracked_repos below for the multi-repo path) ---

  router.get('/settings', (_req, res) => res.json(readSettings()));

  // A basic linear projection of pace vs. the deadline — see src/predict.js for
  // the method and its deliberate limits. Live-computed, not stored, since it's
  // cheap and always wanted "as of now" rather than as of a saved day.
  router.get('/prediction', (req, res) => {
    const date = req.query.date && isDateStr(req.query.date) ? req.query.date : localDate(Date.now(), tz);
    res.json(predictDeadline(db, config, date));
  });

  // deadline_date applies to the shown repo (or `repo`, if given); repo_mode switches
  // the layout between following one repository and several.
  router.post('/settings', requireAdmin, (req, res) => {
    const body = req.body || {};
    if ('tracked_repo' in body) {
      return res.status(400).json({ error: 'Change the repository with POST /api/repository or /api/repository/active.' });
    }
    const hasDeadline = 'deadline_date' in body;
    const hasMode = 'repo_mode' in body;
    if (!hasDeadline && !hasMode) return res.status(400).json({ error: 'Send deadline_date (or null to clear it) and/or repo_mode.' });
    if (hasDeadline && body.deadline_date !== null && !isDateStr(body.deadline_date)) {
      return res.status(400).json({ error: 'deadline_date must look like 2026-09-20, or be null to clear it.' });
    }
    if (hasMode && body.repo_mode !== 'single' && body.repo_mode !== 'multi') {
      return res.status(400).json({ error: 'repo_mode must be "single" or "multi".' });
    }
    const repo = body.repo == null ? trackedRepo(db, config) : norm(body.repo);
    if (hasDeadline && body.repo != null && !db.prepare('SELECT 1 FROM repositories WHERE repo = ?').get(repo)) {
      return res.status(404).json({ error: `${repo} is not a connected repository.` });
    }
    transaction(db, () => {
      if (hasDeadline) setDeadline(db, repo, body.deadline_date);
      if (hasMode) {
        db.prepare(`UPDATE project_settings SET repo_mode = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(body.repo_mode);
        // Going back to one repository pauses (hides) the others; nothing is deleted.
        const shown = trackedRepo(db, config);
        if (body.repo_mode === 'single' && shown) showRepo(db, shown);
      }
    })();
    return res.status(200).json(readSettings());
  });

  // --- Webhook setup helpers for the dashboard: the values to paste into GitHub,
  // and a one-click "create it for me" that uses a token once and forgets it. ---

  const URL_RE = /^https?:\/\/[^\s/]+(\/\S*)?$/i;

  router.get('/webhook-setup', requireAdmin, (_req, res) => {
    res.json({
      tracked_repo: readSettings().tracked_repo,
      secret: config.webhookSecret,
      content_type: 'application/json',
      events: ['push'],
      path: '/webhook/github',
    });
  });

  // --- Repositories ---------------------------------------------------------------
  // Connect by webhook (instant; GitHub must be able to reach this server), by a
  // token-free public scan, or by polling with a read-only token (private repos,
  // localhost). Several repositories can be connected; the dashboard shows one at a
  // time (project_settings.tracked_repo). In single mode, showing another repo pauses
  // and hides the previous one; in multi mode all stay followed. Nothing is deleted
  // except through DELETE /api/repositories/:owner/:name.

  const pollRow = (repo = trackedRepo(db, config)) => (repo ? db.prepare('SELECT * FROM tracked_repos WHERE repo = ?').get(repo) : null) || null;

  function syncStatus(repo) {
    const row = db.prepare('SELECT last_sync_at, last_sync_error, last_sync_added FROM repositories WHERE repo = ?').get(repo) || {};
    return {
      last_sync_at: row.last_sync_at || null,
      last_error: row.last_sync_error || null,
      last_added: row.last_sync_added ?? null,
      interval_minutes: config.syncIntervalMs ? Math.round(config.syncIntervalMs / 60000) : null,
    };
  }

  function repositoryState() {
    const repo = trackedRepo(db, config) || null;
    const row = pollRow(repo);
    const method = !repo ? null : row ? 'poll' : 'webhook';
    return {
      repo,
      method,
      mode: repoMode(db),
      commits: db.prepare(`SELECT COUNT(*) AS c FROM commits WHERE ${IN_REPO}`).get({ repo: repo || '' }).c,
      poll: row ? {
        last_polled_at: row.last_polled_at,
        last_error: row.last_error,
        interval_minutes: Math.round(config.pollIntervalMs / 60000),
      } : null,
      webhook: method === 'webhook' ? webhookStatus(repo) : null,
      // Token-free scans of a public repo through GitHub's API (src/hooks.js).
      sync: method === 'webhook' ? syncStatus(repo) : null,
      repositories: listRepos(db, config),
    };
  }

  router.get('/repository', (_req, res) => res.json(repositoryState()));
  router.get('/repositories', (_req, res) => res.json(listRepos(db, config)));

  const connectRepo = transaction(db, ({ repo, method, tokenEnc, defaultBranch }) => {
    showRepo(db, repo);
    db.prepare('DELETE FROM tracked_repos WHERE repo = ?').run(repo);
    if (method === 'poll') {
      db.prepare('INSERT INTO tracked_repos (repo, token_enc, default_branch) VALUES (?, ?, ?)').run(repo, tokenEnc, defaultBranch);
    }
  });

  /** Fetch what was missed while a repo was paused (or just connected). */
  async function catchUpRepo(repo) {
    const row = pollRow(repo);
    if (row) return pollOneRepo({ db, config, row });
    return syncTrackedRepo({ db, config, repo });
  }

  router.post('/repository', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const repo = norm(body.repo);
    // 'public' = no token at all: scan the public repo through GitHub's API now and
    // every few minutes. It is stored like 'webhook' (no saved token), so a webhook
    // can be added later for instant updates without reconnecting.
    const requested = body.method;
    const method = requested === 'poll' ? 'poll' : requested === 'webhook' || requested === 'public' ? 'webhook' : null;
    const token = String(body.token || '').trim();
    const payloadUrl = String(body.payload_url || '').trim();
    if (!REPO_RE.test(repo)) return res.status(400).json({ error: 'Repository must look like owner/name.' });
    if (!method) return res.status(400).json({ error: 'method must be "public", "webhook" or "poll".' });

    // Single mode follows one repository: confirm before the current one is paused.
    const current = trackedRepo(db, config);
    const replacing = repoMode(db) === 'single' && current && current !== repo ? current : null;
    if (replacing && body.replace !== true) {
      return res.status(409).json({
        error: `Commit Doctor is set to follow one repository. Connecting ${repo} pauses and hides ${current}; its history is kept, and you can switch back to it later.`,
        needs_replace: true,
        current,
        commits: db.prepare('SELECT COUNT(*) AS c FROM commits WHERE repo = ?').get(current).c,
      });
    }

    // Everything that can fail runs before anything changes.
    let tokenEnc = null;
    let defaultBranch = null;
    let hook = null;
    if (requested === 'public') {
      try {
        await testRepoAccess(repo, '');
      } catch (err) {
        const msg = err.status === 404
          ? `GitHub has no public repository called ${repo}. If it is private, choose "Yes, it's private" and connect with a token.`
          : `Could not reach GitHub: ${err.message}`;
        return res.status(422).json({ error: msg });
      }
    } else if (method === 'poll') {
      if (!config.tokenEncryptionKey) {
        return res.status(503).json({ error: 'This server has no TOKEN_ENCRYPTION_KEY, so it cannot keep a token. Set it in .env and restart, or use the webhook method.' });
      }
      if (!token) return res.status(400).json({ error: 'Paste a GitHub token that can read this repository.' });
      try {
        ({ defaultBranch } = await testRepoAccess(repo, token));
      } catch (err) {
        return res.status(422).json({ error: `GitHub did not accept that token for ${repo}: ${err.message} The token needs read access to the repository's contents.` });
      }
      tokenEnc = encryptToken(token, config.tokenEncryptionKey);
    } else if (token) {
      if (!URL_RE.test(payloadUrl)) return res.status(400).json({ error: 'payload_url must be a full http(s) URL.' });
      if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(payloadUrl)) {
        return res.status(400).json({ error: 'GitHub cannot reach localhost. Use the token method instead, or a public URL (for example from ngrok or smee.io).' });
      }
      try {
        hook = await connectWebhook({ repo, token, payloadUrl, secret: config.webhookSecret });
      } catch (err) {
        const hint = err.status === 404 || err.status === 403
          ? ' The token needs admin access to the repo (classic: admin:repo_hook; fine-grained: Webhooks read and write).'
          : '';
        return res.status(422).json({ error: `GitHub refused: ${err.message}${hint}` });
      }
    }

    connectRepo({ repo, method, tokenEnc, defaultBranch });
    if (method === 'poll') await pollOneRepo({ db, config, row: pollRow(repo) });
    // First scan right away (no token needed), so the dashboard isn't empty until the next push.
    else if (requested === 'public' || config.syncIntervalMs) await syncTrackedRepo({ db, config, repo });

    return res.status(200).json({ ...repositoryState(), paused: replacing, hook_created: hook ? hook.created : null });
  });

  // Hop to another connected repository. Never deletes anything; in single mode the
  // repo shown before is paused and hidden until switched back to.
  router.post('/repository/active', requireAdmin, async (req, res) => {
    const repo = norm(req.body && req.body.repo);
    if (!db.prepare('SELECT 1 FROM repositories WHERE repo = ?').get(repo)) {
      return res.status(404).json({ error: `${repo || 'That repository'} is not connected. Connect it first.` });
    }
    const wasActive = Boolean(db.prepare('SELECT active FROM repositories WHERE repo = ?').get(repo).active);
    transaction(db, () => showRepo(db, repo))();
    // A repo that was paused missed pushes; pull them now (the lookback covers 14 days).
    if (!wasActive) await catchUpRepo(repo).catch(() => {});
    return res.json(repositoryState());
  });

  // Scan the shown repo now instead of waiting for the next timer.
  let scanning = false;
  router.post('/repository/scan', requireAdmin, async (_req, res) => {
    const repo = trackedRepo(db, config);
    if (!repo) return res.status(400).json({ error: 'No repository is connected.' });
    if (pollRow(repo)) {
      await pollOneRepo({ db, config, row: pollRow(repo) });
    } else if (!scanning) {
      scanning = true;
      try { await syncTrackedRepo({ db, config, repo }); } finally { scanning = false; }
    }
    return res.json(repositoryState());
  });

  // After the shown repo is paused or removed, show another followed one (or none).
  const showNext = () => {
    const next = db.prepare('SELECT repo FROM repositories WHERE active = 1 ORDER BY created_at DESC, repo LIMIT 1').get();
    db.prepare(`UPDATE project_settings SET tracked_repo = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(next ? next.repo : null);
  };

  // Stop following the shown repository. Its data stays (it can be shown again
  // later); the stored token is deleted.
  router.delete('/repository', requireAdmin, (_req, res) => {
    const repo = trackedRepo(db, config);
    transaction(db, () => {
      if (repo) {
        db.prepare('DELETE FROM tracked_repos WHERE repo = ?').run(repo);
        setActive(db, repo, false);
      }
      showNext();
    })();
    return res.json(repositoryState());
  });

  // Remove a repository and everything recorded for it (commits, summaries, flags,
  // subscribers, deadline, token). Audit logs are kept.
  router.delete('/repositories/:owner/:name', requireAdmin, (req, res) => {
    const repo = norm(`${req.params.owner}/${req.params.name}`);
    if (!db.prepare('SELECT 1 FROM repositories WHERE repo = ?').get(repo)) {
      return res.status(404).json({ error: `${repo} is not connected.` });
    }
    transaction(db, () => {
      const shown = trackedRepo(db, config) === repo;
      deleteRepoData(db, repo);
      if (shown) showNext();
    })();
    return res.json(repositoryState());
  });

  // Lets the dashboard tell whether changes need the admin token, without changing anything.
  router.post('/admin/ping', requireAdmin, (_req, res) => res.json({ ok: true }));

  // Contributors with any history up to a day, for the Team view.
  router.get('/contributors', (req, res) => {
    const date = req.query.date || localDate(Date.now(), tz);
    if (!isDateStr(date)) return res.status(400).json({ error: 'date must look like 2026-09-20.' });
    const weekStart = addDays(date, -6);
    const rows = db.prepare(
      `SELECT contributor AS name, MAX(author_name) AS display_name, MAX(committed_date) AS last_date,
              SUM(CASE WHEN committed_date >= ? THEN 1 ELSE 0 END) AS commits_7d
       FROM commits WHERE committed_date <= ? AND ${IN_REPO} GROUP BY contributor ORDER BY last_date DESC, name`
    ).all({ repo: trackedRepo(db, config) }, weekStart, date);
    res.json(rows.map((r) => ({ ...r, idle_days: daysBetween(r.last_date, date) })));
  });

  // --- Subscribers: notification recipients of the shown repository (each repo has its own list) ---

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  router.get('/subscribers', (_req, res) => {
    res.json(db.prepare('SELECT id, name, email, created_at FROM subscribers WHERE repo = ? ORDER BY id').all(trackedRepo(db, config))
      .map((r) => ({ ...r, email: maskEmail(r.email) })));
  });

  router.post('/subscribers', requireAdmin, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'name is required.' });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    try {
      const info = db.prepare('INSERT INTO subscribers (repo, name, email) VALUES (?, ?, ?)').run(trackedRepo(db, config), name, email);
      const row = db.prepare('SELECT id, name, email, created_at FROM subscribers WHERE id = ?').get(info.lastInsertRowid);
      return res.status(201).json(row);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'That email is already subscribed to this repository.' });
      throw err;
    }
  });

  router.delete('/subscribers/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a whole number.' });
    const info = db.prepare('DELETE FROM subscribers WHERE id = ? AND repo = ?').run(id, trackedRepo(db, config));
    if (info.changes === 0) return res.status(404).json({ error: 'Subscriber not found.' });
    return res.status(204).end();
  });

  router.post('/notifications/test', requireAdmin, async (req, res) => {
    if (!mailer) return res.status(503).json({ error: 'Email is off. Set SMTP_HOST in .env and restart.' });
    const to = String((req.body && req.body.to) || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'A valid "to" email is required.' });
    try{
      await mailer.sendMail({ to, subject: 'Commit Doctor test email', html: '<p>If you can read this, email works. </p>'});
      return res.json({ sent: true, to });
    } catch(err){
      return res.status(502).json({ error: `SMTP send failed: ${err.message}` });
    }
  });

  router.post('/notifications/check', requireAdmin, async (_req, res) => {
    if (!mailer) return res.status(503).json({ error: 'Email is off. Set SMTP_HOST in .env and restart.' });
    return res.json(await checkDeadlineUrgency(db, config, mailer));
  });

  router.get('/flags', (req, res) => {
    const limit = clamp(req.query.limit, 1, 200, 30);
    const repo = trackedRepo(db, config);
    if (req.query.date) {
      if (!isDateStr(req.query.date)) return res.status(400).json({ error: 'date must look like 2026-09-20.' });
      return res.json(db.prepare('SELECT * FROM flags WHERE repo = ? AND date = ? ORDER BY id DESC').all(repo, req.query.date));
    }
    return res.json(db.prepare('SELECT * FROM flags WHERE repo = ? ORDER BY date DESC, id DESC LIMIT ?').all(repo, limit));
  });

  // The prototype's own activity record (deliveries received, summaries generated).
  router.get('/activity', (req, res) => {
    const limit = clamp(req.query.limit, 1, 200, 30);
    res.json({
      webhook_events: db.prepare('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?').all(limit),
      summary_runs: db.prepare('SELECT * FROM summary_runs ORDER BY id DESC LIMIT ?').all(limit),
    });
  });

  router.use('/views', createViewsRouter({ db }));
  router.use('/study', createStudyRouter({ db, config, requireAdmin }));

  return router;
}

module.exports = { createApiRouter };