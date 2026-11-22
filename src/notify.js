'use strict';

const{localDate} = require('./time');
const{predictDeadline} = require('./predict');
const { maskEmail } = require('./privacy');
const { trackedRepo } = require('./repository');

const RETRY_AFTER_FAILURE_MS = 15 * 60_000;
const failedAttempts = new WeakMap(); // db -> Map(key -> timestamp of last failed attempt)
// One email per repo, per day, per tier. Format: "<repo>|<date>: <tier>".
const dedupeKey = (repo, date, tier) => `${repo}|${date}: ${tier}`;

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#39;'}[c]));

// Each repository has its own subscriber list.
function getSubscriberEmails(db, repo){
    return db.prepare('SELECT email FROM subscribers WHERE repo = ?').all(repo).map((r) => r.email);
}

async function sendToAllSubscribers(db, mailer, { subject, html }, log, repo){
    const emails = getSubscriberEmails(db, repo);
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

function renderFlagsEmail(date, flags, repo){
    const items = flags.map((f) => `<li><strong>${escapeHtml(f.type)}</strong>: ${escapeHtml(f.detail)}</li>`).join('');
    const where = repo ? ` in <strong>${escapeHtml(repo)}</strong>` : '';

    return{
        subject: `Commit Doctor: ${flags.length} flag(s) for ${date}${repo ? ` (${repo})` : ''}`,
        html: `<p>Commit Doctor noticed the following for <strong>${date}</strong>${where}:</p><ul>${items}</ul>`,
    };
}

async function notifyFlags(db, config, mailer, date, flags, log = console, repo = trackedRepo(db, config)){
    if (!flags.length) return {sent: false, reason: 'no-flags'}
    
    const result = await sendToAllSubscribers(db, mailer, renderFlagsEmail(date, flags, repo), log, repo);

    if (result.sent) log.info(`[notify] sent ${flags.length} flag(s) for ${repo || 'all'} ${date} to ${result.count} subscriber(s)`);
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
    const left = p.days_remaining === 0 ? 'today' : `in ${p.days_remaining} day${p.days_remaining === 1 ? '' : 's'}`;
    const paceLine = p.pace_ratio != null
        ? `<p>Recent commit pace is ${Math.round(p.pace_ratio * 100)}% of the project's earlier pace.</p>` : '';
    const churnLine = worried && p.churn_ratio != null
        ? `<p>Recent changes are ${Math.round(p.churn_ratio * 100)}% deletions/rework (by ${escapeHtml(p.churn_basis)}).</p>` : '';

    const project = p.repo ? ` for ${escapeHtml(p.repo)}` : '';
    return{
        subject: `Commit Doctor - ${label}: deadline ${left}${worried ? ` (${p.status})` : ''}${p.repo ? ` - ${p.repo}` : ''}`,
        html: `<p><strong>${label}:</strong> the project deadline${project} (${escapeHtml(p.deadline_date)}) is ${left}.</p>
        <p>${STATUS_TEXT[p.status] || ''}</p>${paceLine}${churnLine}`,
    };
}

async function checkDeadlineUrgency(db, config, mailer, log = console, repo = trackedRepo(db, config)){
    const today = localDate(Date.now(), config.timezone);
    const prediction = predictDeadline(db, config, today, repo);

    if (!prediction.urgency || prediction.urgency === 'none') return {sent: false, reason: 'no-escalation-needed'};

    const key = dedupeKey(repo, today, prediction.urgency);
    if (db.prepare('SELECT 1 FROM notifications_sent WHERE key = ?').get(key)) return { sent: false, reason: 'already-sent-today' };

    if (!failedAttempts.has(db)) failedAttempts.set(db, new Map());
    const failures = failedAttempts.get(db);
    const lastFail = failures.get(key);
    if (lastFail && Date.now() - lastFail < RETRY_AFTER_FAILURE_MS) return { sent: false, reason: 'retry-backoff' };

    const result = await sendToAllSubscribers(db, mailer, renderDeadlineEmail(prediction), log, repo);
    if (result.sent){
        db.prepare('INSERT OR IGNORE INTO notifications_sent (key) VALUES (?)').run(key);
        failures.delete(key);
        log.info(`[notify] sent deadline "${prediction.urgency}" notice for ${repo || 'all'} to ${result.count} subscriber(s)`);
    } else if (result.attempted){
        failures.set(key, Date.now());
    }
    return{...result, urgency: prediction.urgency};
}

module.exports = {notifyFlags, checkDeadlineUrgency, renderDeadlineEmail};