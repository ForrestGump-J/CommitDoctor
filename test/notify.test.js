'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeCtx } = require('./helpers');
const { createStore } = require('../src/store');
const { localDate, addDays } = require('../src/time');
const { checkDeadlineUrgency, notifyFlags } = require('../src/notify');
const { urgencyForDays } = require('../src/predict');

const quiet = { info() {}, error() {} };

function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return { sent, sendMail: async (msg) => { if (fail) throw new Error('SMTP down'); sent.push(msg); } };
}

function setup({ daysLeft, subscribers = ['a@example.com', 'b@example.com'] }) {
  const ctx = makeCtx();
  const today = localDate(Date.now(), ctx.config.timezone);
  // Steady history so the team is on pace: reminders must go out anyway.
  const store = createStore(ctx.db, ctx.config);
  for (let i = 1; i <= 20; i++) {
    store.addCommit({
      sha: crypto.randomBytes(20).toString('hex'), repo: 'r/r', branch: 'main', authorName: 'a', authorUsername: 'a',
      authorEmail: 'a@x', message: 'Work', url: null, timestamp: `${addDays(today, -i)}T03:00:00Z`,
    });
  }
  ctx.db.prepare('UPDATE project_settings SET deadline_date = ?').run(addDays(today, daysLeft));
  for (const e of subscribers) ctx.db.prepare('INSERT INTO subscribers (name, email) VALUES (?, ?)').run(e, e);
  return { ...ctx, today };
}

const rows = (db) => db.prepare('SELECT kind, dedupe_key, status, delivered, recipients FROM notifications ORDER BY id').all();

test('reminders escalate by days left: 7, 3, 1', () => {
  assert.equal(urgencyForDays(8), 'none');
  assert.equal(urgencyForDays(7), 'reminder');
  assert.equal(urgencyForDays(4), 'reminder');
  assert.equal(urgencyForDays(3), 'urgent');
  assert.equal(urgencyForDays(1), 'final');
  assert.equal(urgencyForDays(0), 'final');
  assert.equal(urgencyForDays(-1), 'none');
});

test('an on-pace team still gets a reminder when the deadline is near', async () => {
  const { db, config } = setup({ daysLeft: 6 });
  const mailer = fakeMailer();
  const result = await checkDeadlineUrgency(db, config, mailer, quiet);
  assert.equal(result.sent, true);
  assert.equal(result.urgency, 'reminder');
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[0].subject, /6 days until the deadline/);
  assert.match(mailer.sent[0].html, /on pace/);
});

test('each tier is sent once per deadline, even across restarts', async () => {
  const { db, config } = setup({ daysLeft: 3 });
  const mailer = fakeMailer();
  await checkDeadlineUrgency(db, config, mailer, quiet);
  // A restart loses all in-memory state; the record lives in the database.
  delete require.cache[require.resolve('../src/notify')];
  const fresh = require('../src/notify');
  const again = await fresh.checkDeadlineUrgency(db, config, mailer, quiet);
  assert.equal(again.reason, 'already-sent');
  assert.equal(mailer.sent.length, 2);
  assert.deepEqual(rows(db).map((r) => [r.kind, r.status]), [['deadline', 'sent']]);
});

test('moving the deadline starts the reminders over', async () => {
  const { db, config, today } = setup({ daysLeft: 2 });
  const mailer = fakeMailer();
  await checkDeadlineUrgency(db, config, mailer, quiet);
  db.prepare('UPDATE project_settings SET deadline_date = ?').run(addDays(today, 1));
  const result = await checkDeadlineUrgency(db, config, mailer, quiet);
  assert.equal(result.urgency, 'final');
  assert.equal(result.sent, true);
  assert.equal(mailer.sent.length, 4);
});

test('nothing is sent while the deadline is more than a week away', async () => {
  const { db, config } = setup({ daysLeft: 12 });
  const mailer = fakeMailer();
  assert.equal((await checkDeadlineUrgency(db, config, mailer, quiet)).reason, 'no-reminder-due');
  assert.equal(rows(db).length, 0);
});

test('with no subscribers, the skip is logged once and the reminder stays due', async () => {
  const { db, config } = setup({ daysLeft: 5, subscribers: [] });
  const mailer = fakeMailer();
  await checkDeadlineUrgency(db, config, mailer, quiet);
  await checkDeadlineUrgency(db, config, mailer, quiet);
  assert.deepEqual(rows(db).map((r) => r.status), ['skipped']);

  db.prepare("INSERT INTO subscribers (name, email) VALUES ('c', 'c@example.com')").run();
  assert.equal((await checkDeadlineUrgency(db, config, mailer, quiet)).sent, true);
});

test('a failed send is logged, retried later, and not marked as sent', async () => {
  const { db, config } = setup({ daysLeft: 5 });
  const broken = fakeMailer({ fail: true });
  assert.equal((await checkDeadlineUrgency(db, config, broken, quiet)).sent, false);
  assert.equal((await checkDeadlineUrgency(db, config, broken, quiet)).reason, 'retry-later');
  const [row] = rows(db);
  assert.equal(row.status, 'failed');
  assert.equal(row.delivered, 0);

  // An hour later the mail server is back.
  db.prepare("UPDATE notifications SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')").run();
  const working = fakeMailer();
  assert.equal((await checkDeadlineUrgency(db, config, working, quiet)).sent, true);
});

test('flag alerts go out once per day', async () => {
  const { db, config, today } = setup({ daysLeft: 30 });
  const mailer = fakeMailer();
  const flags = [{ type: 'contributor_inactive', detail: 'bob has had no commits since 2026-10-01 (20 days).' }];
  assert.equal((await notifyFlags(db, config, mailer, today, flags, quiet)).sent, true);
  assert.equal((await notifyFlags(db, config, mailer, today, flags, quiet)).reason, 'already-sent');
  assert.equal((await notifyFlags(db, config, mailer, today, [], quiet)).reason, 'no-flags');
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[0].html, /bob has had no commits/);
});
