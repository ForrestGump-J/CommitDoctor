'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { createApp } = require('../src/app');
const { ensureWebhookSecret } = require('../src/hooks');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

async function listen(ctx) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** Stub GitHub's API while letting requests to the local test server through. */
function stubGitHub(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith('https://api.github.com')) return realFetch(url, opts);
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const { status = 200, json = {} } = handler(String(url), opts.method || 'GET') || {};
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

test('a secret is generated once and kept when .env has none', () => {
  const ctx = makeCtx({ webhookSecret: '' });
  assert.equal(ensureWebhookSecret(ctx.db, ctx.config), 'generated');
  const first = ctx.config.webhookSecret;
  assert.match(first, /^[0-9a-f]{48}$/);

  const again = { ...ctx.config, webhookSecret: '' };
  ensureWebhookSecret(ctx.db, again);
  assert.equal(again.webhookSecret, first);
});

test('the .env secret wins over a stored one', () => {
  const ctx = makeCtx();
  assert.equal(ensureWebhookSecret(ctx.db, ctx.config), 'env');
  assert.equal(ctx.config.webhookSecret, 'test-secret');
});

test('GET /api/webhook-setup returns the values to paste into GitHub', async () => {
  const { server, base } = await listen(makeCtx());
  try {
    const body = await (await fetch(`${base}/api/webhook-setup`)).json();
    assert.equal(body.secret, 'test-secret');
    assert.equal(body.content_type, 'application/json');
    assert.deepEqual(body.events, ['push']);
  } finally { server.close(); }
});

test('webhook setup is admin-only when ADMIN_TOKEN is set', async () => {
  const { server, base } = await listen(makeCtx({ adminToken: 'adm' }));
  try {
    assert.equal((await fetch(`${base}/api/webhook-setup`)).status, 401);
    const ok = await fetch(`${base}/api/webhook-setup`, { headers: { Authorization: 'Bearer adm' } });
    assert.equal(ok.status, 200);
  } finally { server.close(); }
});

test('overview reports whether GitHub is delivering for the tracked repo', async () => {
  const ctx = makeCtx();
  const { server, base } = await listen(ctx);
  const status = async () => (await (await fetch(`${base}/api/overview`)).json()).webhook;
  const log = (event, repo, status, detail = null) => ctx.db
    .prepare('INSERT INTO webhook_events (event, repo, status, detail) VALUES (?, ?, ?, ?)').run(event, repo, status, detail);
  try {
    ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/repo'").run();
    assert.equal((await status()).state, 'waiting');

    log('ping', null, 'rejected', 'Invalid or missing signature');
    const failing = await status();
    assert.equal(failing.state, 'failing');
    assert.match(failing.detail, /signature/);

    log('ping', 'Someone/Else', 'accepted', 'ping');
    const other = await status();
    assert.equal(other.state, 'other_repo');
    assert.equal(other.repo_seen, 'Someone/Else');

    log('ping', 'Team/Repo', 'accepted', 'ping');
    const pinged = await status();
    assert.equal(pinged.state, 'connected');
    assert.equal(pinged.last_ok_event, 'ping');

    log('push', 'Team/Repo', 'accepted', 'refs/heads/main');
    assert.equal((await status()).last_ok_event, 'push');
  } finally { server.close(); }
});

test('sync pulls a public repo\'s recent commits right away, without a token', async () => {
  const headers = [];
  const realStub = stubGitHub((url) => (url.endsWith('/repos/team/repo')
    ? { json: { default_branch: 'main', private: false } }
    : { json: [
      { sha: 'a'.repeat(40), html_url: 'https://x', author: { login: 'alice' },
        commit: { message: 'Add thing', author: { name: 'Alice', email: 'a@x', date: new Date().toISOString() } } },
    ] }));
  const wrapped = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => { if (String(url).startsWith('https://api.github.com')) headers.push(opts.headers); return wrapped(url, opts); };

  const ctx = makeCtx();
  const { server, base } = await listen(ctx);
  try {
    await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracked_repo: 'team/repo' }) });
    const res = await fetch(`${base}/api/webhook-setup/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).added, 1);
    assert.equal(realStub.length, 2);
    assert.ok(headers.every((h) => !h.Authorization), 'no Authorization header without a token');
    assert.equal(ctx.db.prepare("SELECT COUNT(*) c FROM commits WHERE repo = 'team/repo'").get().c, 1);

    const { sync } = (await (await fetch(`${base}/api/overview`)).json()).webhook;
    assert.ok(sync.at);
    assert.equal(sync.added, 1);
    assert.equal(sync.error, null);

    // Tracking a different repo clears the old sync result.
    await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracked_repo: 'team/other' }) });
    assert.equal((await (await fetch(`${base}/api/overview`)).json()).webhook.sync.at, null);
  } finally { server.close(); }
});

test('sync explains a missing (or private) repo', async () => {
  stubGitHub(() => ({ status: 404, json: { message: 'Not Found' } }));
  const ctx = makeCtx();
  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/secret'").run();
  const { server, base } = await listen(ctx);
  try {
    const res = await fetch(`${base}/api/webhook-setup/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 422);
    assert.match((await res.json()).error, /private/);
    assert.match((await (await fetch(`${base}/api/overview`)).json()).webhook.sync.error, /private/);
  } finally { server.close(); }
});

test('untracking stops recording pushes, and tracking again turns it back on', async () => {
  const { sign, pushPayload } = require('./helpers');
  const ctx = makeCtx({ repo: 'demo-team/demo-repo' }); // GITHUB_REPO set: must not be used as a fallback once untracked
  const { server, base } = await listen(ctx);
  const settings = (body) => fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const push = (repo) => {
    const body = JSON.stringify(pushPayload([{ timestamp: new Date().toISOString() }], repo));
    return fetch(`${base}/webhook/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(body) },
      body,
    }).then((r) => r.json());
  };
  try {
    const off = await settings({ tracked_repo: null });
    assert.equal(off.tracked_repo, null);
    assert.equal(off.untracked, true);
    assert.equal((await push('demo-team/demo-repo')).ignored, 'tracking is off');

    const on = await settings({ tracked_repo: 'demo-team/demo-repo' });
    assert.equal(on.untracked, false);
    assert.equal((await push('demo-team/demo-repo')).stored, 1);

    // Switch to another repo: the old one's pushes are now ignored, and both show up as known repos.
    const switched = await settings({ tracked_repo: 'demo-team/other' });
    assert.equal(switched.tracked_repo, 'demo-team/other');
    assert.equal((await push('demo-team/demo-repo')).ignored, 'other repository');
    assert.ok(switched.known_repos.includes('demo-team/demo-repo'));
  } finally { server.close(); }
});

test('background sync re-pulls the tracked repo on a timer, and idles when nothing is tracked', async () => {
  const { startRepoSync } = require('../src/hooks');
  const calls = stubGitHub((url) => (url.endsWith('/repos/team/repo') ? { json: { default_branch: 'main' } } : { json: [] }));
  const ctx = makeCtx();
  const quiet = { info() {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let stop = startRepoSync({ db: ctx.db, config: ctx.config, log: quiet, intervalMs: 20 });
  await wait(70);
  stop();
  assert.equal(calls.length, 0, 'no calls while nothing is tracked');

  ctx.db.prepare("UPDATE project_settings SET tracked_repo = 'team/repo'").run();
  stop = startRepoSync({ db: ctx.db, config: ctx.config, log: quiet, intervalMs: 20 });
  await wait(70);
  stop();
  assert.ok(calls.some((c) => c.url.endsWith('/repos/team/repo')));
  assert.ok(ctx.db.prepare('SELECT last_sync_at FROM project_settings').get().last_sync_at);

  assert.equal(startRepoSync({ db: ctx.db, config: { ...ctx.config, syncIntervalMs: 0 } })(), undefined, 'interval 0 turns it off');
});
