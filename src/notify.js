'use strict';

const{localDate} = require('./time');
const{predictDeadline} = require('./predict');
const { maskEmail } = require('./privacy');

const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const failedAttempts = new WeakMap(); // db -> Map(key -> timestamp of last failed attempt)
const dedupeKey = (date, tier) => `${date}: ${tier}`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#39;'}[c]));

function getSubscriberEmails(db){
    return db.prepare('SELECT email FROM subscribers').all().map((r) => r.email);
}

async function sendToAllSubscribers(db, mailer, { subject, html }, log){
    const emails = getSubscriberEmails(db);
    if (!emails.length) return {sent: false, reason: 'no-subscribers'};

    let delivered = 0;
    for (const email of emails){
        try{
            await mailer.sendMail({to: email, subject, html});
            delivered += 1;
        }
        catch (err){
            log.error(`[notify] failed to email ${maskEmail(email)}: ${err.message}`);
        }
    }
    return {sent:delivered > 0, count: delivered, attempted: emails.length}
}

function renderFlagsEmail(date, flags){
    const items = flags.map((f) => `<li><strong>${escapeHtml(f.type)}</strong>: ${escapeHtml(f.detail)}</li>`).join('');

    return{
        subject: `Commit Doctor: ${flags.length} flag(s) for ${date}`,
        html: `<p>Commit Doctor noticed the following for <strong>${date}</strong>:</p><ul>${items}</ul>`,
    };
}

async function notifyFlags(db, config, mailer, date, flags, log = console){
    if (!flags.length) return {sent: false, reason: 'no-flags'}
    
    const result = await sendToAllSubscribers(db, mailer, renderFlagsEmail(date, flags), log);

    if (result.sent) log.info(`[notify] sent ${flags.length} flag(s) for ${date} to ${result.count} subscriber(s)`);
    return result;
}

const TIER_LABEL = {reminder: 'Reminder', urgent: 'Urgent', final: 'FINAL WARNING'};
const STATUS_TEXT = {
    'on-pace': 'The team is on pace.',
    'at-risk': 'The team is at risk of missing it: recent commits have slowed down.',
    behind: 'The team is behind pace: recent commits have dropped sharply.',
    'insufficient-data': 'There is not enough commit history yet to judge the pace.',
};

function renderDeadlineEmail(p){
    const worried = p.status === 'at-risk' || p.status === 'behind';
    // A team that is on pace gets a calm reminder, not a warning.
    const label = worried ? (TIER_LABEL[p.urgency] || 'Notice') : 'Reminder';
    const left = p.days_remaining === 0 ? 'today' : `in ${p.days_remaining} day(s)`;
    const paceLine = p.pace_ratio != null
        ? `<p>Recent commit pace is ${Math.round(p.pace_ratio * 100)}% of the project's earlier pace.</p>` : '';
    const churnLine = worried && p.churn_ratio != null
        ? `<p>Recent changes are ${Math.round(p.churn_ratio * 100)}% deletions/rework (by ${escapeHtml(p.churn_basis)}).</p>` : '';

    return{
        subject: `Commit Doctor - ${label}: deadline ${left}${worried ? ` (${p.status})` : ''}`,
        html: `<p><strong>${label}:</strong> the project deadline (${escapeHtml(p.deadline_date)}) is ${left}.</p>
        <p>${STATUS_TEXT[p.status] || ''}</p>${paceLine}${churnLine}`,
    };
}

async function checkDeadlineUrgency(db, config, mailer, log = console){
    const today = localDate(Date.now(), config.timezone);
    const prediction = predictDeadline(db, config, today);

    if (!prediction.urgency || prediction.urgency === 'none') return {sent: false, reason: 'no-escalation-needed'};

    const key = dedupeKey(today, prediction.urgency);
    if (db.prepare('SELECT 1 FROM notifications_sent WHERE key = ?').get(key)) return { sent: false, reason: 'already-sent-today' };

    if (!failedAttempts.has(db)) failedAttempts.set(db, new Map());
    const failures = failedAttempts.get(db);
    const lastFail = failures.get(key);
    if (lastFail && Date.now() - lastFail < RETRY_AFTER_FAILURE_MS) return { sent: false, reason: 'retry-backoff' };

    const result = await sendToAllSubscribers(db, mailer, renderDeadlineEmail(prediction), log);
    if (result.sent){
        db.prepare('INSERT OR IGNORE INTO notifications_sent (key) VALUES (?)').run(key);
        failures.delete(key);
        log.info(`[notify] sent deadline "${prediction.urgency}" notice to ${result.count} subscriber(s)`);
    } else if (result.attempted){
        failures.set(key, Date.now());
    }
    return{...result, urgency: prediction.urgency};
}

module.exports = {notifyFlags, checkDeadlineUrgency, renderDeadlineEmail};