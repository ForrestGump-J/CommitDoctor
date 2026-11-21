'use strict';
const express = require('express');

/**
 * Research question 5: the dashboard offers three ways to read the same day
 * (Digest, Team, Timeline). This records, anonymously, which view people open,
 * how long it stays on screen, and whether they found it helpful, so a later
 * study can compare them. No names, emails or IPs are stored; session_id is a
 * random id the browser makes for itself.
 */
const VIEWS = new Set(['digest', 'team', 'timeline']);
const SESSION_RE = /^[a-f0-9]{16,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DWELL_MS = 2 * 60 * 60 * 1000; // ignore tabs left open overnight

// Public endpoint, so keep it cheap to abuse: a small per-session and global budget per minute.
function rateLimiter({ perKey = 60, global = 3000, windowMs = 60_000 } = {}) {
  let windowStart = Date.now();
  let total = 0;
  const counts = new Map();
  return (key) => {
    const now = Date.now();
    if (now - windowStart > windowMs) { windowStart = now; total = 0; counts.clear(); }
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    total += 1;
    return n <= perKey && total <= global;
  };
}

function createViewsRouter({ db, limiter = rateLimiter() }) {
  const router = express.Router();
  const insertEvent = db.prepare('INSERT INTO view_events (session_id, view, kind, value, day) VALUES (?, ?, ?, ?, ?)');
  const upsertFeedback = db.prepare(
    `INSERT INTO view_feedback (session_id, view, day, helpful) VALUES (?, ?, ?, ?)
     ON CONFLICT (session_id, view, day) DO UPDATE SET helpful = excluded.helpful,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  );

  router.post('/events', (req, res) => {
    const b = req.body || {};
    const session = String(b.session || '');
    const view = String(b.view || '');
    const kind = String(b.kind || '');
    const day = b.day == null ? null : String(b.day);
    if (!SESSION_RE.test(session) || !VIEWS.has(view) || (day !== null && !DAY_RE.test(day))) {
      return res.status(400).json({ error: 'Invalid view event.' });
    }
    if (!limiter(session)) return res.status(429).json({ error: 'Too many events; slow down.' });

    if (kind === 'open') {
      insertEvent.run(session, view, 'open', null, day);
    } else if (kind === 'dwell') {
      const ms = Math.round(Number(b.value));
      if (!Number.isFinite(ms) || ms < 0) return res.status(400).json({ error: 'dwell needs a value in ms.' });
      insertEvent.run(session, view, 'dwell', Math.min(ms, MAX_DWELL_MS), day);
    } else if (kind === 'feedback') {
      if (day === null || (b.value !== 1 && b.value !== 0)) return res.status(400).json({ error: 'feedback needs a day and value 1 or 0.' });
      upsertFeedback.run(session, view, day, b.value);
    } else {
      return res.status(400).json({ error: 'kind must be open, dwell or feedback.' });
    }
    return res.status(204).end();
  });

  router.get('/stats', (_req, res) => {
    const usage = db.prepare(
      `SELECT view,
              SUM(kind = 'open') AS opens,
              COUNT(DISTINCT CASE WHEN kind = 'open' THEN session_id END) AS sessions,
              COALESCE(SUM(CASE WHEN kind = 'dwell' THEN value END), 0) AS dwell_ms
       FROM view_events GROUP BY view`
    ).all();
    const feedback = db.prepare(
      'SELECT view, SUM(helpful) AS up, SUM(1 - helpful) AS down FROM view_feedback GROUP BY view'
    ).all();
    const out = [...VIEWS].map((view) => {
      const u = usage.find((r) => r.view === view) || { opens: 0, sessions: 0, dwell_ms: 0 };
      const f = feedback.find((r) => r.view === view) || { up: 0, down: 0 };
      const votes = f.up + f.down;
      return {
        view,
        opens: u.opens,
        sessions: u.sessions,
        avg_seconds_per_open: u.opens ? Math.round(u.dwell_ms / u.opens / 100) / 10 : null,
        helpful: f.up,
        not_helpful: f.down,
        helpful_pct: votes ? Math.round((f.up / votes) * 100) : null,
      };
    });
    res.json(out);
  });

  return router;
}

module.exports = { createViewsRouter, rateLimiter };
