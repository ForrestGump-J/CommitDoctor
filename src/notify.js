'use strict';

const { localDate } = require('./time');
const { predictDeadline } = require('./predict');
const { currentScope } = require('./scope');

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[c]));

function getSubscriberEmails(db) {
  return db.prepare('SELECT email FROM subscribers').all().map((r) => r.email);
}

/**
 * Send one notification to every subscriber, at most once per (repo, kind, key).
 * Every attempt is written to the notifications table, so the record survives
 * restarts (no duplicate reminders) and doubles as the prototype's own log of
 * what it sent and when (research question 4). Failed or skipped attempts are
 * not "sent", so they are retried on the next check.
 */
async function sendOnce(db, config, mailer, { kind, key, subject, html }, log) {
  const repo = currentScope(db, config);
  const already = db
    .prepare("SELECT 1 FROM notifications WHERE repo = ? AND kind = ? AND dedupe_key = ? AND status = 'sent'")
    .get(repo, kind, key);
  if (already) return { sent: false, reason: 'already-sent' };
  // The scheduler checks every 30 s; after a failed send, wait before trying the mail server again.
  const recentFailure = db
    .prepare(
      `SELECT 1 FROM notifications WHERE repo = ? AND kind = ? AND dedupe_key = ? AND status = 'failed'
       AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')`
    )
    .get(repo, kind, key);
  if (recentFailure) return { sent: false, reason: 'retry-later' };

  const record = db.prepare(
    `INSERT INTO notifications (repo, kind, dedupe_key, subject, status, recipients, delivered, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const emails = getSubscriberEmails(db);
  if (!emails.length) {
    // Not logged on every check: a missing subscriber list is reported once per key.
    const loggedSkip = db
      .prepare("SELECT 1 FROM notifications WHERE repo = ? AND kind = ? AND dedupe_key = ? AND status = 'skipped'")
      .get(repo, kind, key);
    if (!loggedSkip) record.run(repo, kind, key, subject, 'skipped', 0, 0, 'No subscribers');
    return { sent: false, reason: 'no-subscribers' };
  }

  let delivered = 0;
  const errors = [];
  for (const email of emails) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await mailer.sendMail({ to: email, subject, html });
      delivered += 1;
    } catch (err) {
      errors.push(`${email}: ${err.message}`);
      log.error(`[notify] failed to email ${email}: ${err.message}`);
    }
  }
  const status = delivered > 0 ? 'sent' : 'failed';
  record.run(repo, kind, key, subject, status, emails.length, delivered, errors.join('; ') || null);
  return { sent: delivered > 0, count: delivered, attempted: emails.length };
}

// --- flagged activity ------------------------------------------------------------

function renderFlagsEmail(repo, date, flags) {
  const items = flags.map((f) => `<li><strong>${escapeHtml(f.type)}</strong>: ${escapeHtml(f.detail)}</li>`).join('');
  const where = repo ? ` in <strong>${escapeHtml(repo)}</strong>` : '';
  return {
    subject: `Commit Doctor: ${flags.length} flag(s) for ${date}${repo ? ` (${repo})` : ''}`,
    html: `<p>Commit Doctor noticed the following${where} on <strong>${escapeHtml(date)}</strong>:</p><ul>${items}</ul>`,
  };
}

async function notifyFlags(db, config, mailer, date, flags, log = console) {
  if (!flags.length) return { sent: false, reason: 'no-flags' };
  const repo = currentScope(db, config);
  const result = await sendOnce(db, config, mailer, { kind: 'flags', key: date, ...renderFlagsEmail(repo, date, flags) }, log);
  if (result.sent) log.info(`[notify] sent ${flags.length} flag(s) for ${date} to ${result.count} subscriber(s)`);
  return result;
}

// --- approaching deadline ----------------------------------------------------------

const TIER_LABEL = { reminder: 'Reminder', urgent: 'Urgent', final: 'Final notice' };
const PACE_TEXT = {
  'on-pace': 'The team is on pace.',
  'at-risk': 'The team is at risk of missing it.',
  behind: 'The team is behind pace.',
  'insufficient-data': 'There is not enough commit history yet to judge the pace.',
};

function renderDeadlineEmail(repo, p) {
  const label = TIER_LABEL[p.urgency] || 'Notice';
  const days = `${p.days_remaining} day${p.days_remaining === 1 ? '' : 's'}`;
  const pace = p.pace_ratio != null
    ? `<p>Recent pace: ${p.recent_commit_rate} commits a day over the last ${p.window_days} days, against ${p.earlier_commit_rate} a day before that (${Math.round(p.pace_ratio * 100)}%).</p>`
    : '';
  const churn = p.churn_ratio != null
    ? `<p>${Math.round(p.churn_ratio * 100)}% of recently changed ${p.churn_basis === 'lines' ? 'lines' : 'files'} were deletions or rework.</p>`
    : '';
  return {
    subject: `Commit Doctor ${label.toLowerCase()}: ${days} until the deadline${repo ? ` (${repo})` : ''}`,
    html: `<p><strong>${label}:</strong> the deadline${repo ? ` for <strong>${escapeHtml(repo)}</strong>` : ''} (${escapeHtml(p.deadline_date)}) is ${days} away.</p>
      <p><strong>${escapeHtml(PACE_TEXT[p.status] || p.status)}</strong></p>${pace}${churn}`,
  };
}

/**
 * Remind subscribers as the deadline approaches: once at 7 days left, once at 3,
 * and once at 1 (see urgencyForDays in predict.js). Each tier is sent once per
 * deadline; changing the deadline starts the reminders over.
 */
async function checkDeadlineUrgency(db, config, mailer, log = console) {
  const today = localDate(Date.now(), config.timezone);
  const prediction = predictDeadline(db, config, today);
  if (!prediction.urgency || prediction.urgency === 'none') return { sent: false, reason: 'no-reminder-due' };

  const repo = currentScope(db, config);
  const key = `${prediction.deadline_date}:${prediction.urgency}`;
  const result = await sendOnce(db, config, mailer, { kind: 'deadline', key, ...renderDeadlineEmail(repo, prediction) }, log);
  if (result.sent) log.info(`[notify] sent deadline "${prediction.urgency}" reminder to ${result.count} subscriber(s)`);
  return { ...result, urgency: prediction.urgency };
}

module.exports = { notifyFlags, checkDeadlineUrgency, renderDeadlineEmail };
