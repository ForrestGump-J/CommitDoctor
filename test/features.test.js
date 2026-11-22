'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx } = require('./helpers');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const { openDb } = require('../src/db');
const { localDate, addDays } = require('../src/time');
const { susScore } = require('../src/study');
const { rateLimiter } = require('../src/views');

const KEY = 'a'.repeat(64);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function listen(ctx) {
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  return { server, call };
}

/** Stub GitHub's REST API: repo lookups succeed, commit lists are empty. */
function stubGitHub() {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com')) return realFetch(url, opts);
    const json = /\/commits/.test(u) ? [] : { default_branch: 'main', private: true };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function addCommits(ctx, repo, list) {
  const store = createStore(ctx.db, ctx.config);
  return store.addMany(list.map((c, i) => ({
    sha: `${repo.replace('/', '')}${c.day}${c.who}${i}`.padEnd(40, '0').slice(0, 40),
    repo, branch: 'main', authorName: c.who, authorUsername: c.who, message: 'work',
    url: 'https://example.com', timestamp: `${c.day}T${c.time || '02:00:00'}Z`,
  })));
}

// --- single repository --------------------------------------------------------------

test('connecting by webhook without a token just starts tracking the repo', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    const r = await call('POST', '/api/repository', { repo: 'Team/One', method: 'webhook' });
    assert.equal(r.status, 200);
    assert.equal(r.body.repo, 'team/one');
    assert.equal(r.body.method, 'webhook');
    assert.equal(r.body.webhook.state, 'waiting');
  } finally { server.close(); }
});

test('a public repo can be scanned without any token', async () => {
  const ctx = makeCtx();
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com')) return realFetch(url, opts);
    calls.push({ u, auth: (opts.headers || {}).Authorization });
    const json = /\/commits/.test(u)
      ? [{ sha: 'b'.repeat(40), html_url: 'https://github.com/team/open/commit/b', parents: [{}],
          commit: { message: 'Fix login bug', author: { name: 'Ann', date: '2026-09-20T02:00:00Z' } },
          author: { login: 'ann' } }]
      : { default_branch: 'main', private: false };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const { server, call } = await listen(ctx);
  try {
    const r = await call('POST', '/api/repository', { repo: 'team/open', method: 'public' });
    assert.equal(r.status, 200);
    assert.equal(r.body.repo, 'team/open');
    assert.equal(r.body.sync.last_added, 1);
    assert.equal(r.body.sync.last_error, null);
    assert.ok(calls.length > 0 && calls.every((c) => !c.auth), 'no token is sent to GitHub');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM commits').get().c, 1);
    // Nothing is stored that could hold a token.
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM tracked_repos').get().c, 0);

    const again = await call('POST', '/api/repository/scan');
    assert.equal(again.status, 200);
    assert.equal(again.body.sync.last_added, 0);
  } finally { server.close(); }
});

test('scanning a private or missing repo without a token explains what to do', async () => {
  const ctx = makeCtx();
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api.github.com')) return realFetch(url, opts);
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  const { server, call } = await listen(ctx);
  try {
    const r = await call('POST', '/api/repository', { repo: 'team/secret', method: 'public' });
    assert.equal(r.status, 422);
    assert.match(r.body.error, /private/);
    const state = await call('GET', '/api/repository');
    assert.equal(state.body.repo, null, 'nothing is connected after a failed scan');
  } finally { server.close(); }
});

test('in single mode, connecting another repo needs confirmation, then pauses and hides the old one', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    await call('POST', '/api/repository', { repo: 'team/one', method: 'webhook' });
    addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }, { day: '2026-09-21', who: 'bob' }]);
    ctx.db.prepare("INSERT INTO summaries (repo, date, total_commits, data, trigger, generated_at) VALUES ('team/one', '2026-09-20', 1, '{}', 'manual', 'x')").run();

    const ask = await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.needs_replace, true);
    assert.equal(ask.body.commits, 2);

    const ok = await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook', replace: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.paused, 'team/one');
    assert.equal(ok.body.repo, 'team/two');
    assert.equal(ok.body.commits, 0, 'the dashboard now shows only team/two');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM commits').get().c, 2, 'team/one history is kept');
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM summaries').get().c, 1);
    const one = ok.body.repositories.find((r) => r.repo === 'team/one');
    assert.equal(one.active, false, 'the old repo is paused');
    // A paused repo's pushes are no longer stored.
    assert.equal(addCommits(ctx, 'team/one', [{ day: '2026-09-22', who: 'carla' }]), 0);

    // Reconnecting the same repo (e.g. changing method) never needs confirmation.
    assert.equal((await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' })).status, 200);

    // Switching back brings the old data back and pauses team/two.
    const back = await call('POST', '/api/repository/active', { repo: 'team/one' });
    assert.equal(back.status, 200);
    assert.equal(back.body.repo, 'team/one');
    assert.equal(back.body.commits, 2);
    assert.equal(back.body.repositories.find((r) => r.repo === 'team/two').active, false);
    assert.equal((await call('POST', '/api/repository/active', { repo: 'nobody/here' })).status, 404);
  } finally { server.close(); }
});

test('in multi mode every connected repo is followed and the dashboard hops between them', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    assert.equal((await call('POST', '/api/settings', { repo_mode: 'multi' })).body.repo_mode, 'multi');
    await call('POST', '/api/repository', { repo: 'team/one', method: 'webhook' });
    const two = await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' });
    assert.equal(two.status, 200, 'no confirmation needed in multi mode');
    assert.deepEqual(two.body.repositories.map((r) => [r.repo, r.active, r.shown]).sort(), [['team/one', true, false], ['team/two', true, true]]);

    // Both repos keep receiving commits.
    assert.equal(addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }, { day: '2026-09-20', who: 'bob' }]), 2);
    assert.equal(addCommits(ctx, 'team/two', [{ day: '2026-09-20', who: 'zoe' }]), 1);
    assert.equal(addCommits(ctx, 'someone/else', [{ day: '2026-09-20', who: 'eve' }]), 0);

    // Each repo has its own deadline and subscribers.
    await call('POST', '/api/settings', { deadline_date: '2026-12-01' });
    await call('POST', '/api/subscribers', { name: 'Zoe', email: 'zoe@example.com' });
    assert.equal((await call('GET', '/api/commits?date=2026-09-20')).body.length, 1);
    assert.equal((await call('GET', '/api/summaries/2026-09-20')).body.total_commits, 1);

    await call('POST', '/api/repository/active', { repo: 'team/one' });
    const settings = (await call('GET', '/api/settings')).body;
    assert.equal(settings.tracked_repo, 'team/one');
    assert.equal(settings.deadline_date, null, 'team/two deadline does not leak');
    assert.equal((await call('GET', '/api/subscribers')).body.length, 0);
    assert.equal((await call('GET', '/api/commits?date=2026-09-20')).body.length, 2);
    assert.equal((await call('GET', '/api/overview')).body.totals.commits, 2);
    assert.equal((await call('GET', '/api/repository')).body.repositories.every((r) => r.active), true, 'hopping pauses nothing in multi mode');
    // The same email may subscribe to two repos.
    assert.equal((await call('POST', '/api/subscribers', { name: 'Zoe', email: 'zoe@example.com' })).status, 201);

    // Back to single mode: only the shown repo stays followed.
    await call('POST', '/api/settings', { repo_mode: 'single' });
    const state = (await call('GET', '/api/repository')).body;
    assert.deepEqual(state.repositories.filter((r) => r.active).map((r) => r.repo), ['team/one']);
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS c FROM commits WHERE repo = 'team/two'").get().c, 1, 'nothing deleted');
  } finally { server.close(); }
});

test('summaries and flags are saved per repository', () => {
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET repo_mode = 'multi'").run();
  ctx.db.prepare("INSERT INTO repositories (repo) VALUES ('team/one'), ('team/two')").run();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }, { day: '2026-09-20', who: 'bob' }]);
  addCommits(ctx, 'team/two', [{ day: '2026-09-20', who: 'zoe' }]);
  const { generateSummary, getSummary } = require('../src/summary');
  assert.equal(generateSummary(ctx.db, ctx.config, '2026-09-20', 'manual', { repo: 'team/one' }).summary.total_commits, 2);
  assert.equal(generateSummary(ctx.db, ctx.config, '2026-09-20', 'manual', { repo: 'team/two' }).summary.total_commits, 1);
  const rows = ctx.db.prepare('SELECT repo, total_commits FROM summaries ORDER BY repo').all();
  assert.deepEqual(rows.map((r) => [r.repo, r.total_commits]), [['team/one', 2], ['team/two', 1]]);
  assert.equal(getSummary(ctx.db, ctx.config, '2026-09-20', Date.parse('2026-10-01'), 'team/two').total_commits, 1);
});

test('removing a repository deletes only its own data', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    await call('POST', '/api/settings', { repo_mode: 'multi' });
    await call('POST', '/api/repository', { repo: 'team/one', method: 'webhook' });
    await call('POST', '/api/subscribers', { name: 'A', email: 'a@example.com' });
    await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' });
    addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }]);
    addCommits(ctx, 'team/two', [{ day: '2026-09-20', who: 'zoe' }]);

    const r = await call('DELETE', '/api/repositories/team/two');
    assert.equal(r.status, 200);
    assert.equal(r.body.repo, 'team/one', 'the next followed repo is shown');
    assert.deepEqual(r.body.repositories.map((x) => x.repo), ['team/one']);
    assert.deepEqual(ctx.db.prepare('SELECT DISTINCT repo FROM commits').all().map((x) => x.repo), ['team/one']);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM subscribers').get().c, 1);
    assert.equal((await call('DELETE', '/api/repositories/team/two')).status, 404);
  } finally { server.close(); }
});

test('a commit can be looked up by its short SHA within the shown repository', async () => {
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  createStore(ctx.db, ctx.config).addMany(['abc1', 'def2'].map((p, i) => ({
    sha: p.padEnd(40, '0'), repo: 'team/one', authorName: 'alice', authorUsername: 'alice', message: 'work',
    timestamp: `2026-09-2${i}T02:00:00Z`,
  })));
  const first = { sha: 'abc1'.padEnd(40, '0') };
  const { server, call } = await listen(ctx);
  try {
    const r = await call('GET', `/api/commits/${first.sha.slice(0, 12)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.sha, first.sha);
    assert.equal(r.body.date, '2026-09-20');
    assert.equal(r.body.related.length, 1);
    assert.equal((await call('GET', '/api/commits/zzzz')).status, 400);
    assert.equal((await call('GET', '/api/commits/ffffffff')).status, 404);
  } finally { server.close(); }
});

test('/api/admin/ping tells whether changes need the admin token', async () => {
  const { server, call } = await listen(makeCtx({ adminToken: 'adm' }));
  try {
    assert.equal((await call('POST', '/api/admin/ping', {})).status, 401);
  } finally { server.close(); }
  const open = await listen(makeCtx());
  try {
    assert.equal((await open.call('POST', '/api/admin/ping', {})).status, 200, 'no token: open from the server machine');
  } finally { open.server.close(); }
});

test('commits from any other repository are never stored', () => {
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  assert.equal(addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }]), 1);
  assert.equal(addCommits(ctx, 'someone/else', [{ day: '2026-09-20', who: 'eve' }]), 0);
});

test('polling keeps exactly one encrypted token and replaces it on reconnect', async () => {
  stubGitHub();
  const ctx = makeCtx({ tokenEncryptionKey: KEY });
  const { server, call } = await listen(ctx);
  try {
    const r = await call('POST', '/api/repository', { repo: 'team/private', method: 'poll', token: 'ghp_secret1' });
    assert.equal(r.status, 200);
    assert.equal(r.body.method, 'poll');
    assert.ok(r.body.poll.last_polled_at);
    await call('POST', '/api/repository', { repo: 'team/private', method: 'poll', token: 'ghp_secret2' });
    const rows = ctx.db.prepare('SELECT * FROM tracked_repos').all();
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].token_enc.includes('ghp_secret'), 'token is encrypted at rest');
    assert.ok(!JSON.stringify((await call('GET', '/api/repository')).body).includes('token_enc'));

    const off = await call('DELETE', '/api/repository');
    assert.equal(off.body.repo, null);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM tracked_repos').get().c, 0, 'disconnect deletes the token');
  } finally { server.close(); }
});

test('polling without an encryption key or token is refused before anything changes', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    assert.equal((await call('POST', '/api/repository', { repo: 'a/b', method: 'poll', token: 't' })).status, 503);
    ctx.config.tokenEncryptionKey = KEY;
    assert.equal((await call('POST', '/api/repository', { repo: 'a/b', method: 'poll' })).status, 400);
    assert.equal((await call('POST', '/api/repository', { repo: 'nope', method: 'webhook' })).status, 400);
    assert.equal(ctx.db.prepare('SELECT tracked_repo FROM project_settings').get().tracked_repo, null);
  } finally { server.close(); }
});

test('the repository cannot be changed through /api/settings anymore', async () => {
  const { server, call } = await listen(makeCtx());
  try {
    assert.equal((await call('POST', '/api/settings', { tracked_repo: 'a/b' })).status, 400);
    assert.equal((await call('POST', '/api/settings', { deadline_date: '2026-12-01' })).body.deadline_date, '2026-12-01');
  } finally { server.close(); }
});

test('an older single-repository database is upgraded without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comdoc-'));
  const file = path.join(dir, 'old.db');
  try {
    // The tables as the single-repository version created them.
    const { DatabaseSync } = require('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE commits (id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL UNIQUE, repo TEXT NOT NULL, branch TEXT,
        author_name TEXT NOT NULL, author_username TEXT, author_email TEXT, contributor TEXT NOT NULL, message TEXT NOT NULL,
        url TEXT, is_merge INTEGER NOT NULL DEFAULT 0, committed_at TEXT NOT NULL, committed_date TEXT NOT NULL,
        committed_hour INTEGER NOT NULL, delivery_id TEXT, received_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE summaries (date TEXT PRIMARY KEY, total_commits INTEGER NOT NULL, data TEXT NOT NULL, trigger TEXT NOT NULL, generated_at TEXT NOT NULL);
      CREATE TABLE summary_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, trigger TEXT NOT NULL, outcome TEXT NOT NULL,
        total_commits INTEGER NOT NULL DEFAULT 0, run_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE project_settings (id INTEGER PRIMARY KEY CHECK (id = 1), deadline_date TEXT, tracked_repo TEXT, webhook_secret TEXT,
        updated_at TEXT NOT NULL DEFAULT 'x', last_sync_at TEXT, last_sync_error TEXT, last_sync_added INTEGER);
      CREATE TABLE flags (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE notifications_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE tracked_repos (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL UNIQUE, token_enc TEXT NOT NULL, default_branch TEXT,
        last_since TEXT, last_polled_at TEXT, last_error TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT 'x');
      INSERT INTO project_settings (id, deadline_date, tracked_repo, last_sync_at) VALUES (1, '2026-12-01', 'team/b', '2026-09-20T00:00:00Z');
      INSERT INTO commits (sha, repo, author_name, contributor, message, committed_at, committed_date, committed_hour)
        VALUES ('${'a'.repeat(40)}', 'Team/B', 'al', 'al', 'm', '2026-09-20T02:00:00Z', '2026-09-20', 10);
      INSERT INTO summaries VALUES ('2026-09-20', 1, '{}', 'scheduled', 'x');
      INSERT INTO summary_runs (date, trigger, outcome) VALUES ('2026-09-20', 'scheduled', 'saved');
      INSERT INTO flags (date, type, detail) VALUES ('2026-09-20', 'activity_above_baseline', 'd');
      INSERT INTO subscribers (name, email) VALUES ('A', 'a@example.com');
      INSERT INTO notifications_sent (key) VALUES ('2026-09-20: final');
      INSERT INTO tracked_repos (repo, token_enc) VALUES ('team/a', 'x'), ('team/b', 'x');`);
    old.close();

    const db = openDb(file);
    const one = (sql) => db.prepare(sql).get();
    assert.equal(one('SELECT repo FROM commits').repo, 'team/b', 'repo names are lowercased');
    assert.equal(one('SELECT repo FROM summaries').repo, 'team/b');
    assert.equal(one('SELECT repo FROM summary_runs').repo, 'team/b');
    assert.equal(one('SELECT repo FROM flags').repo, 'team/b');
    assert.equal(one('SELECT repo FROM subscribers').repo, 'team/b');
    assert.equal(one('SELECT key FROM notifications_sent').key, 'team/b|2026-09-20: final');
    const repos = db.prepare('SELECT repo, active, deadline_date, last_sync_at FROM repositories ORDER BY repo').all();
    assert.deepEqual(repos.map((r) => [r.repo, r.active, r.deadline_date]), [['team/a', 0, null], ['team/b', 1, '2026-12-01']]);
    assert.equal(repos[1].last_sync_at, '2026-09-20T00:00:00Z');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tracked_repos').get().c, 2, 'tokens are kept; team/a is paused');
    db.close();
    // Running the upgrade again changes nothing.
    const again = openDb(file);
    assert.equal(again.prepare('SELECT key FROM notifications_sent').get().key, 'team/b|2026-09-20: final');
    assert.equal(again.prepare('SELECT COUNT(*) AS c FROM repositories').get().c, 2);
    again.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- RQ5: summary views -------------------------------------------------------------

test('view events and feedback are validated and summarized per view', async () => {
  const { server, call } = await listen(makeCtx());
  const session = 'ab'.repeat(16);
  try {
    assert.equal((await call('POST', '/api/views/events', { session, view: 'digest', kind: 'open', day: '2026-09-20' })).status, 204);
    await call('POST', '/api/views/events', { session, view: 'digest', kind: 'dwell', value: 4000, day: '2026-09-20' });
    await call('POST', '/api/views/events', { session, view: 'digest', kind: 'feedback', value: 0, day: '2026-09-20' });
    await call('POST', '/api/views/events', { session, view: 'digest', kind: 'feedback', value: 1, day: '2026-09-20' }); // changed mind
    await call('POST', '/api/views/events', { session, view: 'team', kind: 'open', day: '2026-09-20' });

    assert.equal((await call('POST', '/api/views/events', { session, view: 'bogus', kind: 'open' })).status, 400);
    assert.equal((await call('POST', '/api/views/events', { session: 'not-hex', view: 'team', kind: 'open' })).status, 400);
    assert.equal((await call('POST', '/api/views/events', { session, view: 'team', kind: 'dwell', value: -5 })).status, 400);

    const stats = (await call('GET', '/api/views/stats')).body;
    const digest = stats.find((s) => s.view === 'digest');
    assert.deepEqual([digest.opens, digest.sessions, digest.avg_seconds_per_open, digest.helpful, digest.not_helpful, digest.helpful_pct], [1, 1, 4, 1, 0, 100]);
    assert.equal(stats.find((s) => s.view === 'team').opens, 1);
    assert.equal(stats.find((s) => s.view === 'timeline').helpful_pct, null);
  } finally { server.close(); }
});

test('the view-event rate limiter caps each session', () => {
  const allow = rateLimiter({ perKey: 3, global: 100 });
  assert.deepEqual([1, 2, 3, 4].map(() => allow('s1')), [true, true, true, false]);
  assert.equal(allow('s2'), true);
});

test('the Team view lists everyone with history and how long they have been idle', async () => {
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  addCommits(ctx, 'team/one', [{ day: '2026-09-10', who: 'carla' }, { day: '2026-09-19', who: 'alice' }, { day: '2026-09-20', who: 'alice' }]);
  const { server, call } = await listen(ctx);
  try {
    const list = (await call('GET', '/api/contributors?date=2026-09-20')).body;
    assert.deepEqual(list.map((c) => [c.name, c.idle_days, c.commits_7d]), [['alice', 0, 2], ['carla', 10, 0]]);
  } finally { server.close(); }
});

// --- RQ6: feasibility study ---------------------------------------------------------

test('SUS scoring follows the standard formula', () => {
  assert.equal(susScore([3, 3, 3, 3, 3, 3, 3, 3, 3, 3]), 50);
  assert.equal(susScore([5, 1, 5, 1, 5, 1, 5, 1, 5, 1]), 100);
  assert.equal(susScore([1, 5, 1, 5, 1, 5, 1, 5, 1, 5]), 0);
});

function studyCtx() {
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  const today = localDate(Date.now(), ctx.config.timezone);
  const d1 = addDays(today, -1);
  const d2 = addDays(today, -2);
  addCommits(ctx, 'team/one', [
    { day: d1, who: 'alice', time: '01:00:00' }, { day: d1, who: 'alice', time: '02:00:00' }, { day: d1, who: 'bob', time: '03:00:00' },
    { day: d2, who: 'bob', time: '01:00:00' },
  ]);
  return ctx;
}

test('a study session needs consent and enough data, and never reveals answer keys', async () => {
  const empty = makeCtx();
  empty.db.prepare("UPDATE project_settings SET tracked_repo = 'team/one'").run();
  let { server, call } = await listen(empty);
  try {
    assert.equal((await call('POST', '/api/study/sessions', { code: 'P01', consent: true })).status, 409);
  } finally { server.close(); }

  ({ server, call } = await listen(studyCtx()));
  try {
    assert.equal((await call('POST', '/api/study/sessions', { code: 'P01' })).status, 400, 'consent required');
    assert.equal((await call('POST', '/api/study/sessions', { code: 'bad code!', consent: true })).status, 400);
    const r = await call('POST', '/api/study/sessions', { code: 'P01', consent: true });
    assert.equal(r.status, 201);
    assert.equal(r.body.blocks.length, 2);
    assert.deepEqual(r.body.blocks.map((b) => b.condition).sort(), ['comdoc', 'github']);
    assert.ok(r.body.blocks.every((b) => b.tasks.length === 5));
    assert.ok(!/answer_key|"key"/.test(r.text), 'no answer keys sent to the browser');
    assert.equal((await call('POST', '/api/study/sessions', { code: 'P01', consent: true })).status, 409, 'codes are unique');
  } finally { server.close(); }
});

test('conditions are counterbalanced across participants', async () => {
  const { server, call } = await listen(studyCtx());
  try {
    const firsts = [];
    for (const code of ['P1', 'P2', 'P3', 'P4']) {
      // eslint-disable-next-line no-await-in-loop
      const r = await call('POST', '/api/study/sessions', { code, consent: true });
      firsts.push(`${r.body.blocks[0].condition}`);
    }
    assert.deepEqual(firsts, ['comdoc', 'github', 'comdoc', 'github']);
  } finally { server.close(); }
});

test('answers are scored on the server, and results and CSV summarize them', async () => {
  const ctx = studyCtx();
  const { server, call } = await listen(ctx);
  try {
    const s = (await call('POST', '/api/study/sessions', { code: 'P01', consent: true })).body;
    const keys = ctx.db.prepare('SELECT id, answer_key, kind FROM study_tasks WHERE session_id = ?').all(s.id);
    const keyOf = (id) => {
      const k = keys.find((x) => x.id === id);
      const v = JSON.parse(k.answer_key);
      return Array.isArray(v) ? v[0] : String(v);
    };
    const tasks = s.blocks.flatMap((b) => b.tasks);
    // Answer everything right except one GitHub question.
    for (const t of tasks) {
      const wrong = s.blocks.find((b) => b.condition === 'github').tasks[0].id === t.id;
      // eslint-disable-next-line no-await-in-loop
      const r = await call('POST', `/api/study/sessions/${s.id}/answers`, { token: s.token, task_id: t.id, response: wrong ? '=HYPERLINK("x")' : keyOf(t.id), ms: 5000 });
      assert.equal(r.status, 204);
    }
    assert.equal((await call('POST', `/api/study/sessions/${s.id}/answers`, { token: 'wrong', task_id: tasks[0].id, response: 'x', ms: 1 })).status, 403);
    assert.equal((await call('POST', `/api/study/sessions/${s.id}/answers`, { token: s.token, task_id: tasks[0].id, response: 'x', ms: 1 })).status, 409, 'no re-answering');

    assert.equal((await call('POST', `/api/study/sessions/${s.id}/finish`, { token: s.token, sus: [5, 1, 5] })).status, 400);
    assert.equal((await call('POST', `/api/study/sessions/${s.id}/finish`, { token: s.token, sus: [4, 2, 4, 2, 4, 2, 4, 2, 4, 2], comments: { helped: 'the digest' } })).status, 204);

    const res = (await call('GET', '/api/study/results')).body;
    assert.deepEqual(res.participants, { started: 1, completed: 1 });
    assert.equal(res.by_condition.comdoc.accuracy_pct, 100);
    assert.equal(res.by_condition.github.accuracy_pct, 80);
    assert.equal(res.sus_mean, 75);
    assert.equal(res.criteria.as_accurate, true);
    assert.equal(res.criteria.sus_at_least_68, true);

    const csv = (await call('GET', '/api/study/export.csv')).text;
    assert.match(csv, /^participant,repository,completed_at,sus_score/);
    assert.equal(csv.trim().split('\r\n').length, 11);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula injection is neutralized');

    assert.equal((await call('DELETE', `/api/study/sessions/${s.id}`)).status, 204);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM study_tasks').get().c, 0);
  } finally { server.close(); }
});

// --- analytics -------------------------------------------------------------------------

test('analytics: baseline, weekly work mix, churn, contributors and pace per day', async () => {
  const { buildAnalytics, weekStart } = require('../src/analytics');
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    await call('POST', '/api/repository', { repo: 'team/one', method: 'webhook' });
    const store = createStore(ctx.db, ctx.config);
    const add = (day, who, message, lines) => store.addCommit({
      sha: require('crypto').randomBytes(20).toString('hex'), repo: 'team/one', authorName: who, authorUsername: who,
      message, timestamp: `${day}T02:00:00Z`, ...(lines ? { linesAdded: lines[0], linesDeleted: lines[1] } : {}),
    });
    // 2026-09-01 is a Tuesday. Two commits a day for a week, then a quiet day with a flag.
    for (let i = 0; i < 7; i++) { add(addDays('2026-09-01', i), 'alice', 'fix: crash on save'); add(addDays('2026-09-01', i), 'bob', 'add export button'); }
    ctx.db.prepare("INSERT INTO flags (repo, date, type, detail) VALUES ('team/one', '2026-09-08', 'activity_below_baseline', 'x')").run();
    const now = Date.parse('2026-09-08T06:00:00Z');

    const a = buildAnalytics(ctx.db, ctx.config, { days: 30, now });
    assert.equal(a.daily.length, 30);
    assert.equal(a.end, '2026-09-08');
    const last = a.daily.at(-1);
    assert.deepEqual([last.commits, last.baseline, last.flags], [0, 2, ['activity_below_baseline']]);
    assert.equal(a.daily.find((d) => d.date === '2026-09-01').baseline, null, 'no history before the first commit');
    assert.equal(weekStart('2026-09-03'), '2026-08-31');
    const wk = a.weeks.find((w) => w.start === '2026-08-31');
    assert.equal(wk.commits, 12);
    assert.equal(wk.intents.fix, 6);
    assert.equal(a.weeks[0].start, a.start, 'the first week starts with the range');
    assert.deepEqual([a.weeks.at(-1).start, a.weeks.at(-1).end, a.weeks.at(-1).partial], ['2026-09-07', '2026-09-08', true], 'the current week is cut at today');
    assert.equal(a.churn_basis, 'files');
    assert.deepEqual(a.contributors.map((c) => [c.name, c.commits, c.idle_days]), [['alice', 7, 1], ['bob', 7, 1]]);
    assert.equal(a.pace, null, 'no deadline, no pace chart');

    await call('POST', '/api/settings', { deadline_date: '2026-10-01' });
    const b = buildAnalytics(ctx.db, ctx.config, { days: 30, now });
    assert.equal(b.pace.length, 30);
    assert.equal(b.pace.at(-1).status, 'insufficient-data');
    assert.equal(b.deadline_date, '2026-10-01');

    assert.equal((await call('GET', '/api/analytics?days=60')).status, 200);
    assert.equal((await call('GET', '/api/analytics?days=7')).status, 400);
  } finally { server.close(); }
});
