'use strict';
const crypto = require('crypto');
const express = require('express');
const { localDate, addDays } = require('./time');
const { trackedRepo, IN_REPO } = require('./repository');

/**
 * Research question 6: a small within-subjects feasibility test.
 * Each participant answers two parallel sets of five awareness questions about
 * real commit activity, one set using only GitHub's commit history and the other
 * using only Commit Doctor. Condition order and set assignment are
 * counterbalanced across participants. Afterwards they fill in the System
 * Usability Scale (SUS) for Commit Doctor.
 *
 * Answer keys are computed from the database when the session starts and never
 * leave the server, so participants can't see whether they were right.
 */

const CODE_RE = /^[A-Za-z0-9_-]{1,16}$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pickRandom = (arr) => arr[crypto.randomInt(arr.length)];

// The ten standard SUS statements (Brooke, 1996), worded for Commit Doctor.
const SUS_ITEMS = [
  'I think that I would like to use Commit Doctor frequently.',
  'I found Commit Doctor unnecessarily complex.',
  'I thought Commit Doctor was easy to use.',
  'I think that I would need the support of a technical person to be able to use Commit Doctor.',
  'I found the various functions in Commit Doctor were well integrated.',
  'I thought there was too much inconsistency in Commit Doctor.',
  'I would imagine that most people would learn to use Commit Doctor very quickly.',
  'I found Commit Doctor very cumbersome to use.',
  'I felt very confident using Commit Doctor.',
  'I needed to learn a lot of things before I could get going with Commit Doctor.',
];

/** SUS score 0-100: odd items score (x - 1), even items (5 - x), sum times 2.5. */
function susScore(items) {
  return items.reduce((sum, x, i) => sum + (i % 2 === 0 ? x - 1 : 5 - x), 0) * 2.5;
}

const longDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {
  timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric',
});

/** Five parallel questions about one day of activity in one repository. */
function tasksForDay(db, repo, day, options) {
  const rows = db.prepare(`SELECT contributor, committed_at FROM commits WHERE committed_date = ? AND ${IN_REPO} ORDER BY committed_at`).all({ repo }, day);
  const counts = new Map();
  for (const r of rows) counts.set(r.contributor, (counts.get(r.contributor) || 0) + 1);
  const max = Math.max(...counts.values());
  const top = [...counts].filter(([, n]) => n === max).map(([name]) => name);
  const asked = pickRandom(options);
  const weekTotal = db.prepare(`SELECT COUNT(*) AS c FROM commits WHERE committed_date BETWEEN ? AND ? AND ${IN_REPO}`).get({ repo }, addDays(day, -6), day).c;
  const label = longDay(day);
  return [
    { prompt: `Who made the most commits on ${label}?`, kind: 'choice', options, key: top },
    { prompt: `How many commits were made on ${label}?`, kind: 'number', key: rows.length },
    { prompt: `Did ${asked} make at least one commit on ${label}?`, kind: 'yesno', key: counts.has(asked) ? 'yes' : 'no' },
    { prompt: `How many commits were made in total from ${longDay(addDays(day, -6))} to ${label}?`, kind: 'number', key: weekTotal },
    { prompt: `Who made the first commit on ${label}?`, kind: 'choice', options, key: [rows[0].contributor] },
  ];
}

function isCorrect(kind, key, response) {
  if (kind === 'choice') return key.includes(response);
  if (kind === 'number') return response !== '' && Number(response) === key;
  return response === key;
}

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function createStudyRouter({ db, config, requireAdmin }) {
  const router = express.Router();
  const tz = config.timezone;

  const instructions = (condition, repo) => (condition === 'github'
    ? { title: 'Use GitHub only', text: `Answer using only the repository's commit history on GitHub. Do not open Commit Doctor. Days are in ${tz} time.`, link: `https://github.com/${repo}/commits`, link_label: 'Open the commit history on GitHub' }
    : { title: 'Use Commit Doctor only', text: `Answer using only the Commit Doctor dashboard. Do not open GitHub. Days are in ${tz} time.`, link: '/', link_label: 'Open Commit Doctor' });

  function sessionFor(req, res) {
    const id = parseInt(req.params.id, 10);
    const token = String((req.body && req.body.token) || '');
    const s = Number.isInteger(id) ? db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id) : null;
    if (!s || !token || sha256(token) !== s.token_hash) {
      res.status(403).json({ error: 'Unknown session or wrong session token.' });
      return null;
    }
    return s;
  }

  router.get('/sus-items', (_req, res) => res.json(SUS_ITEMS));

  router.post('/sessions', requireAdmin, (req, res) => {
    const body = req.body || {};
    const code = String(body.code || '').trim();
    if (!CODE_RE.test(code)) return res.status(400).json({ error: 'Participant code must be 1-16 letters, digits, - or _ (for example P01).' });
    if (body.consent !== true) return res.status(400).json({ error: 'The participant must give consent first.' });
    if (db.prepare('SELECT 1 FROM study_sessions WHERE code = ?').get(code)) {
      return res.status(409).json({ error: `Participant code ${code} was already used. Pick a new code, or delete that session from the results first.` });
    }
    const repo = trackedRepo(db, config);
    if (!repo) return res.status(409).json({ error: 'Connect a repository before running the study.' });

    const today = localDate(Date.now(), tz);
    const days = db.prepare(
      `SELECT committed_date AS d FROM commits WHERE committed_date < ? AND ${IN_REPO} GROUP BY committed_date ORDER BY committed_date DESC LIMIT 2`
    ).all({ repo }, today).map((r) => r.d);
    if (days.length < 2) return res.status(409).json({ error: 'Not enough data yet: the study needs at least two past days with commits.' });

    const contributors = db.prepare(`SELECT contributor FROM commits WHERE ${IN_REPO} GROUP BY contributor ORDER BY COUNT(*) DESC LIMIT 8`).all({ repo }).map((r) => r.contributor);
    const sets = { A: days[0], B: days[1] };

    // Counterbalance by participant number: order of conditions x which set goes first.
    const n = db.prepare('SELECT COUNT(*) AS c FROM study_sessions').get().c;
    const conditions = n % 2 === 0 ? ['comdoc', 'github'] : ['github', 'comdoc'];
    const setOrder = Math.floor(n / 2) % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
    const plan = conditions.map((condition, i) => ({ block: i + 1, condition, task_set: setOrder[i], day: sets[setOrder[i]] }));

    const token = crypto.randomBytes(24).toString('hex');
    const nowIso = new Date().toISOString();
    db.exec('BEGIN');
    let sessionId;
    try {
      sessionId = Number(db.prepare('INSERT INTO study_sessions (repo, code, token_hash, plan, consent_at) VALUES (?, ?, ?, ?, ?)')
        .run(repo, code, sha256(token), JSON.stringify(plan), nowIso).lastInsertRowid);
      const insertTask = db.prepare(
        `INSERT INTO study_tasks (session_id, block, condition, task_set, position, prompt, kind, options, answer_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const b of plan) {
        const dayOptions = [...new Set([...contributors, ...db.prepare(`SELECT DISTINCT contributor FROM commits WHERE committed_date = ? AND ${IN_REPO}`).all({ repo }, b.day).map((r) => r.contributor)])].sort();
        tasksForDay(db, repo, b.day, dayOptions).forEach((t, i) => {
          insertTask.run(sessionId, b.block, b.condition, b.task_set, i + 1, t.prompt, t.kind, t.options ? JSON.stringify(t.options) : null, JSON.stringify(t.key));
        });
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const tasks = db.prepare('SELECT id, block, position, prompt, kind, options FROM study_tasks WHERE session_id = ? ORDER BY block, position').all(sessionId);
    return res.status(201).json({
      id: sessionId,
      code,
      token,
      blocks: plan.map((b) => ({
        block: b.block,
        condition: b.condition,
        ...instructions(b.condition, repo),
        tasks: tasks.filter((t) => t.block === b.block).map((t) => ({
          id: t.id, prompt: t.prompt, kind: t.kind, options: t.options ? JSON.parse(t.options) : null,
        })),
      })),
    });
  });

  router.post('/sessions/:id/answers', (req, res) => {
    const s = sessionFor(req, res);
    if (!s) return undefined;
    if (s.completed_at) return res.status(409).json({ error: 'This session is already finished.' });
    const taskId = parseInt(req.body.task_id, 10);
    const task = db.prepare('SELECT * FROM study_tasks WHERE id = ? AND session_id = ?').get(taskId, s.id);
    if (!task) return res.status(404).json({ error: 'Unknown task.' });
    if (task.answered_at) return res.status(409).json({ error: 'This question was already answered.' });
    const response = String(req.body.response ?? '').trim().slice(0, 200);
    const ms = Math.round(Number(req.body.ms));
    if (!Number.isFinite(ms) || ms < 0) return res.status(400).json({ error: 'ms must be the time taken in milliseconds.' });
    const correct = isCorrect(task.kind, JSON.parse(task.answer_key), response) ? 1 : 0;
    db.prepare(`UPDATE study_tasks SET response = ?, correct = ?, ms = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(response, correct, Math.min(ms, 60 * 60 * 1000), task.id);
    return res.status(204).end();
  });

  router.post('/sessions/:id/finish', (req, res) => {
    const s = sessionFor(req, res);
    if (!s) return undefined;
    if (s.completed_at) return res.status(409).json({ error: 'This session is already finished.' });
    const items = req.body.sus;
    if (!Array.isArray(items) || items.length !== 10 || !items.every((x) => Number.isInteger(x) && x >= 1 && x <= 5)) {
      return res.status(400).json({ error: 'Answer all ten statements (1 to 5).' });
    }
    const unanswered = db.prepare('SELECT COUNT(*) AS c FROM study_tasks WHERE session_id = ? AND answered_at IS NULL').get(s.id).c;
    if (unanswered) return res.status(409).json({ error: `${unanswered} question(s) are still unanswered.` });
    const c = req.body.comments || {};
    const comments = {};
    for (const k of ['helped', 'confusing', 'other']) comments[k] = String(c[k] || '').slice(0, 2000);
    db.prepare(`UPDATE study_sessions SET sus_items = ?, sus_score = ?, comments = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(JSON.stringify(items), susScore(items), JSON.stringify(comments), s.id);
    return res.status(204).end();
  });

  // --- facilitator side (admin) ----------------------------------------------------

  router.get('/results', requireAdmin, (_req, res) => {
    const sessions = db.prepare('SELECT id, repo, code, completed_at, sus_score, created_at FROM study_sessions ORDER BY id').all();
    const byCondition = {};
    for (const condition of ['github', 'comdoc']) {
      const rows = db.prepare(
        `SELECT t.correct, t.ms FROM study_tasks t JOIN study_sessions s ON s.id = t.session_id
         WHERE t.condition = ? AND t.answered_at IS NOT NULL AND s.completed_at IS NOT NULL`
      ).all(condition);
      const times = rows.map((r) => r.ms / 1000).sort((a, b) => a - b);
      byCondition[condition] = {
        answers: rows.length,
        accuracy_pct: rows.length ? Math.round((rows.reduce((n, r) => n + r.correct, 0) / rows.length) * 1000) / 10 : null,
        mean_seconds: times.length ? Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 10) / 10 : null,
        median_seconds: times.length ? Math.round(times[Math.floor((times.length - 1) / 2)] * 10) / 10 : null,
      };
    }
    const done = sessions.filter((s) => s.completed_at);
    const susMean = done.length ? Math.round((done.reduce((n, s) => n + s.sus_score, 0) / done.length) * 10) / 10 : null;
    const g = byCondition.github;
    const c = byCondition.comdoc;
    const ready = done.length > 0 && g.answers > 0 && c.answers > 0;
    res.json({
      participants: { started: sessions.length, completed: done.length },
      by_condition: byCondition,
      sus_mean: susMean,
      criteria: ready ? {
        as_accurate: c.accuracy_pct >= g.accuracy_pct,
        faster: c.mean_seconds < g.mean_seconds,
        sus_at_least_68: susMean >= 68,
      } : null,
      sessions,
    });
  });

  router.get('/export.csv', requireAdmin, (_req, res) => {
    const rows = db.prepare(
      `SELECT s.code, s.repo, s.completed_at, s.sus_score, s.comments, t.block, t.condition, t.task_set, t.position,
              t.prompt, t.response, t.correct, t.ms, t.answered_at
       FROM study_tasks t JOIN study_sessions s ON s.id = t.session_id ORDER BY s.id, t.block, t.position`
    ).all();
    const header = ['participant', 'repository', 'completed_at', 'sus_score', 'block', 'condition', 'task_set', 'question', 'prompt', 'response', 'correct', 'seconds', 'answered_at', 'comments'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.code, r.repo, r.completed_at, r.sus_score, r.block, r.condition, r.task_set, r.position, r.prompt, r.response,
        r.correct, r.ms == null ? '' : (r.ms / 1000).toFixed(1), r.answered_at, r.position === 1 && r.block === 1 ? r.comments : '',
      ].map(csvCell).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="commit-doctor-study.csv"');
    res.send(`${lines.join('\r\n')}\r\n`);
  });

  // Remove a pilot run, or honor a participant who withdraws (RA 10173).
  router.delete('/sessions/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a whole number.' });
    db.prepare('DELETE FROM study_tasks WHERE session_id = ?').run(id);
    const info = db.prepare('DELETE FROM study_sessions WHERE id = ?').run(id);
    return info.changes ? res.status(204).end() : res.status(404).json({ error: 'Session not found.' });
  });

  return router;
}

module.exports = { createStudyRouter, susScore, SUS_ITEMS };
