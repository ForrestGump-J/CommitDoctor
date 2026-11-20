'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx } = require('./helpers');
const { createApp } = require('../src/app');
const { createStore } = require('../src/store');
const { openDb } = require('../src/db');
const { localDate } = require('../src/time');

const commit = (repo, author, timestamp = new Date().toISOString()) => ({
  sha: crypto.randomBytes(20).toString('hex'), repo, branch: 'main',
  authorName: author, authorUsername: author, authorEmail: `${author}@x`, message: 'Work', url: null, timestamp,
});

async function listen(ctx) {
  const server = createApp(ctx).listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('the dashboard only shows the tracked repo, and switching changes it', async () => {
  const ctx = makeCtx();
  const store = createStore(ctx.db, ctx.config);
  // Webhooks keep GitHub's casing; the scope match must ignore it.
  store.addMany([commit('Notsyou/CommitDoctor', 'mirai'), commit('Notsyou/CommitDoctor', 'mirai'), commit('notsyou/gtkbingocard', 'jeremie')]);
  const { server, base } = await listen(ctx);
  const get = (p) => fetch(`${base}${p}`).then((r) => r.json());
  const track = (repo) => fetch(`${base}/api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracked_repo: repo }),
  });
  const today = localDate(Date.now(), ctx.config.timezone);
  try {
    // Nothing tracked: everything combined.
    assert.equal((await get('/api/overview')).totals.commits, 3);

    await track('notsyou/gtkbingocard');
    let o = await get('/api/overview');
    assert.equal(o.repo, 'notsyou/gtkbingocard');
    assert.equal(o.totals.commits, 1);
    assert.deepEqual((await get(`/api/commits?date=${today}`)).map((c) => c.contributor), ['jeremie']);
    assert.equal((await get(`/api/summaries/${today}`)).total_commits, 1);
    assert.equal((await get('/api/trend?days=1'))[0].commits, 1);

    await track('notsyou/commitdoctor');
    o = await get('/api/overview');
    assert.equal(o.totals.commits, 2);
    assert.equal((await get(`/api/summaries/${today}`)).contributors[0].name, 'mirai');

    // Untracking goes back to the combined view.
    await track(null);
    assert.equal((await get('/api/overview')).totals.commits, 3);
  } finally { server.close(); }
});

test('saved summaries and flags are kept per repo', async () => {
  const ctx = makeCtx();
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const day = localDate(yesterday, ctx.config.timezone);
  createStore(ctx.db, ctx.config).addMany([commit('a/one', 'x', yesterday), commit('b/two', 'y', yesterday), commit('b/two', 'y', yesterday)]);
  const { server, base } = await listen(ctx);
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  try {
    await post('/api/settings', { tracked_repo: 'a/one' });
    await post(`/api/summaries/${day}/generate`);
    await post('/api/settings', { tracked_repo: 'b/two' });
    await post(`/api/summaries/${day}/generate`);

    const rows = ctx.db.prepare('SELECT repo, total_commits FROM summaries WHERE date = ? ORDER BY repo').all(day);
    assert.deepEqual(rows.map((r) => [r.repo, r.total_commits]), [['a/one', 1], ['b/two', 2]]);
    const saved = await (await fetch(`${base}/api/summaries/${day}`)).json();
    assert.equal(saved.source, 'saved');
    assert.equal(saved.total_commits, 2);
  } finally { server.close(); }
});

test('an old database keeps its saved summaries as the combined view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comdoc-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE summaries (date TEXT PRIMARY KEY, total_commits INTEGER NOT NULL, data TEXT NOT NULL,
            trigger TEXT NOT NULL, generated_at TEXT NOT NULL);
            INSERT INTO summaries VALUES ('2026-09-20', 4, '{}', 'scheduled', '2026-09-21T00:00:00Z');`);
  old.close();

  const db = openDb(file);
  try {
    const row = db.prepare('SELECT repo, date, total_commits FROM summaries').get();
    assert.deepEqual({ ...row }, { repo: '', date: '2026-09-20', total_commits: 4 });
    // Same day can now hold one summary per repo.
    db.prepare("INSERT INTO summaries (repo, date, total_commits, data, trigger, generated_at) VALUES ('a/b', '2026-09-20', 1, '{}', 'manual', 'x')").run();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM summaries').get().c, 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
