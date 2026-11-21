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

test('switching repositories needs confirmation, then clears the old project', async () => {
  const ctx = makeCtx();
  const { server, call } = await listen(ctx);
  try {
    await call('POST', '/api/repository', { repo: 'team/one', method: 'webhook' });
    addCommits(ctx, 'team/one', [{ day: '2026-09-20', who: 'alice' }, { day: '2026-09-21', who: 'bob' }]);
    ctx.db.prepare("INSERT INTO summaries (date, total_commits, data, trigger, generated_at) VALUES ('2026-09-20', 1, '{}', 'manual', 'x')").run();
    ctx.db.prepare("INSERT INTO subscribers (name, email) VALUES ('A', 'a@example.com')").run();

    const ask = await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.needs_replace, true);
    assert.equal(ask.body.commits, 2);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM commits').get().c, 2, 'nothing cleared without confirmation');

    const ok = await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook', replace: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.cleared, true);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM commits').get().c, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM summaries').get().c, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM subscribers').get().c, 1, 'subscribers are kept');

    // Reconnecting the same repo (e.g. changing method) never needs confirmation.
    assert.equal((await call('POST', '/api/repository', { repo: 'team/two', method: 'webhook' })).status, 200);
  } finally { server.close(); }
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

test('an older database with several polled repos is reduced to the tracked one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comdoc-'));
  const file = path.join(dir, 'old.db');
  try {
    const db = openDb(file);
    db.prepare("UPDATE project_settings SET tracked_repo = 'team/b'").run();
    for (const r of ['team/a', 'team/b', 'team/c']) db.prepare("INSERT INTO tracked_repos (repo, token_enc) VALUES (?, 'x')").run(r);
    db.close();
    const again = openDb(file);
    assert.deepEqual(again.prepare('SELECT repo FROM tracked_repos').all().map((r) => r.repo), ['team/b']);
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
    assert.match(csv, /^participant,completed_at,sus_score/);
    assert.equal(csv.trim().split('\r\n').length, 11);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula injection is neutralized');

    assert.equal((await call('DELETE', `/api/study/sessions/${s.id}`)).status, 204);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS c FROM study_tasks').get().c, 0);
  } finally { server.close(); }
});
