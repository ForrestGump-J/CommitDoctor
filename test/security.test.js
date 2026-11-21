'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx, sign, pushPayload } = require('./helpers');
const { createApp } = require('../src/app');
const { openDb } = require('../src/db');

async function listen(ctx) {
  const server = createApp(ctx).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, port: server.address().port };
}

// node:http rather than fetch, so the Host header can be set freely.
function request(port, { method = 'POST', path: p = '/api/notifications/check', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// /api/notifications/check answers 503 (no mailer) once past requireAdmin, 401 if blocked.
const PASSED = 503;

test('no ADMIN_TOKEN: a plain local request may write', async () => {
  const { server, port } = await listen(makeCtx());
  try {
    assert.equal((await request(port, { headers: { Host: `localhost:${port}` } })).status, PASSED);
    assert.equal((await request(port, { headers: { Host: `127.0.0.1:${port}`, Origin: `http://localhost:${port}` } })).status, PASSED);
  } finally { server.close(); }
});

test('no ADMIN_TOKEN: requests forwarded by a tunnel or proxy are refused', async () => {
  const { server, port } = await listen(makeCtx());
  try {
    for (const h of ['X-Forwarded-For', 'Forwarded', 'X-Real-IP', 'CF-Connecting-IP', 'X-Forwarded-Host']) {
      const res = await request(port, { headers: { Host: `localhost:${port}`, [h]: '203.0.113.7' } });
      assert.equal(res.status, 401, `${h} should block the loopback exception`);
    }
  } finally { server.close(); }
});

test('no ADMIN_TOKEN: DNS rebinding (foreign Host) is refused', async () => {
  const { server, port } = await listen(makeCtx());
  try {
    assert.equal((await request(port, { headers: { Host: 'evil.example' } })).status, 401);
    assert.equal((await request(port, { headers: { Host: 'abc123.ngrok-free.app' } })).status, 401);
  } finally { server.close(); }
});

test('no ADMIN_TOKEN: cross-site posts (foreign Origin) are refused', async () => {
  const { server, port } = await listen(makeCtx());
  try {
    const res = await request(port, {
      headers: { Host: `localhost:${port}`, Origin: 'http://evil.example', 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert.equal(res.status, 401);
    assert.equal((await request(port, { headers: { Host: `localhost:${port}`, Origin: 'null' } })).status, 401);
  } finally { server.close(); }
});

test('ADMIN_TOKEN set: the token is required, and works through a proxy', async () => {
  const { server, port } = await listen(makeCtx({ adminToken: 'adm' }));
  try {
    assert.equal((await request(port, { headers: { Host: `localhost:${port}` } })).status, 401);
    const ok = await request(port, {
      headers: { Host: 'commitdoctor.onrender.com', 'X-Forwarded-For': '203.0.113.7', Authorization: 'Bearer adm' },
    });
    assert.equal(ok.status, PASSED);
    assert.equal((await request(port, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  } finally { server.close(); }
});

test('committer emails are not stored, and an email-only author is shown masked', async () => {
  const ctx = makeCtx();
  const { server, port } = await listen(ctx);
  try {
    const payload = pushPayload([{ timestamp: '2026-09-20T02:00:00Z' }]);
    payload.commits[0].author = { email: 'jane.doe@example.com' }; // no name, no username
    const body = JSON.stringify(payload);
    const res = await request(port, {
      path: '/webhook/github',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': sign(body) },
      body,
    });
    assert.equal(res.status, 200);

    const row = ctx.db.prepare('SELECT contributor, author_name, author_email FROM commits').get();
    assert.equal(row.author_email, null);
    assert.equal(row.contributor, 'j***@example.com');

    const commits = JSON.parse((await request(port, { method: 'GET', path: '/api/commits?date=2026-09-20' })).body);
    assert.ok(!JSON.stringify(commits).includes('jane.doe'));
  } finally { server.close(); }
});

test('opening an older database scrubs stored emails and email-shaped labels', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comdoc-'));
  const file = path.join(dir, 'old.db');
  try {
    const db = openDb(file);
    db.prepare(
      `INSERT INTO commits (sha, repo, author_name, author_email, contributor, message, committed_at, committed_date, committed_hour)
       VALUES ('abc', 'o/r', 'bob@example.com', 'bob@example.com', 'bob@example.com', 'm', '2026-09-20T02:00:00Z', '2026-09-20', 10)`
    ).run();
    db.close();

    const reopened = openDb(file);
    const row = reopened.prepare('SELECT contributor, author_name, author_email FROM commits').get();
    reopened.close();
    assert.deepEqual({ ...row }, { contributor: 'b***@example.com', author_name: 'b***@example.com', author_email: null });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
