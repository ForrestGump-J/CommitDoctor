'use strict';
const { addDays, daysBetween, localDate } = require('./time');
const { IN_REPO, trackedRepo, getDeadline } = require('./repository');
const { classify } = require('./intent');
const { predictDeadline } = require('./predict');

/** Monday of the week a date falls in (weeks run Monday to Sunday). */
function weekStart(date) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/**
 * Everything the Analytics page draws, for the shown repository over the last
 * `days` days (ending today). Uses only stored commit metadata, flags and the
 * repo's deadline; nothing is saved.
 *
 *  - daily:    commits per day, the rolling baseline the summary compares that day
 *              against, and the flags raised for it.
 *  - weeks:    Monday-to-Sunday buckets (the first and last can be partial) with the
 *              intent mix and code churn.
 *  - people:   each contributor's commits per week, in name order (not a ranking).
 *  - pace:     the deadline prediction recomputed as of each day, or null without a deadline.
 */
function buildAnalytics(db, config, { days = 30, now = Date.now(), repo = trackedRepo(db, config) } = {}) {
  const today = localDate(now, config.timezone);
  const start = addDays(today, -(days - 1));
  const n = config.summary.comparisonDays;
  const first = db.prepare(`SELECT MIN(committed_date) AS d FROM commits WHERE ${IN_REPO}`).get({ repo }).d;

  // --- activity over time, with the same baseline the daily summary uses -----------
  const counts = new Map(
    db.prepare(`SELECT committed_date AS d, COUNT(*) AS c FROM commits WHERE committed_date >= ? AND committed_date <= ? AND ${IN_REPO} GROUP BY committed_date`)
      .all({ repo }, addDays(start, -n), today)
      .map((r) => [r.d, r.c])
  );
  const flagsByDay = new Map();
  for (const f of db.prepare(`SELECT date, type FROM flags WHERE date >= ? AND ${IN_REPO} ORDER BY id`).all({ repo }, start)) {
    if (!flagsByDay.has(f.date)) flagsByDay.set(f.date, []);
    if (!flagsByDay.get(f.date).includes(f.type)) flagsByDay.get(f.date).push(f.type);
  }
  const daily = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    let from = addDays(date, -n);
    if (first && first > from) from = first;
    const span = first ? Math.max(0, daysBetween(from, date)) : 0;
    let sum = 0;
    for (let d = from; d < date; d = addDays(d, 1)) sum += counts.get(d) || 0;
    daily.push({
      date,
      commits: counts.get(date) || 0,
      baseline: span > 0 ? Math.round((sum / span) * 10) / 10 : null,
      flags: flagsByDay.get(date) || [],
    });
  }

  // --- weekly buckets: work mix and churn ------------------------------------------
  const weeks = [];
  const weekOf = new Map();
  for (let ws = weekStart(start); ws <= today; ws = addDays(ws, 7)) {
    const w = {
      start: ws < start ? start : ws,
      end: addDays(ws, 6) > today ? today : addDays(ws, 6),
      partial: ws < start || addDays(ws, 6) > today,
      commits: 0,
      intents: {},
      lines_added: 0,
      lines_deleted: 0,
      line_commits: 0,
      files_added: 0,
      files_modified: 0,
      files_removed: 0,
    };
    weekOf.set(ws, w);
    weeks.push(w);
  }
  const people = new Map();
  const rows = db
    .prepare(`SELECT committed_date, contributor, message, is_merge, lines_added, lines_deleted, files_added, files_modified, files_removed
              FROM commits WHERE committed_date >= ? AND committed_date <= ? AND ${IN_REPO}`)
    .all({ repo }, start, today);
  for (const r of rows) {
    const idx = weeks.indexOf(weekOf.get(weekStart(r.committed_date)));
    const w = weeks[idx];
    w.commits += 1;
    const kind = r.is_merge ? 'merge' : classify(r.message).intent;
    w.intents[kind] = (w.intents[kind] || 0) + 1;
    if (r.lines_added != null && r.lines_deleted != null) {
      w.lines_added += r.lines_added;
      w.lines_deleted += r.lines_deleted;
      w.line_commits += 1;
    }
    w.files_added += r.files_added || 0;
    w.files_modified += r.files_modified || 0;
    w.files_removed += r.files_removed || 0;
    if (!people.has(r.contributor)) people.set(r.contributor, Array(weeks.length).fill(0));
    people.get(r.contributor)[idx] += 1;
  }
  const lineCommits = weeks.reduce((s, w) => s + w.line_commits, 0);

  // --- contributors: everyone with history, alphabetical ---------------------------
  const lastDates = db
    .prepare(`SELECT contributor AS name, MAX(committed_date) AS last_date FROM commits WHERE committed_date <= ? AND ${IN_REPO} GROUP BY contributor`)
    .all({ repo }, today);
  const contributors = lastDates
    .map((p) => {
      const weekly = people.get(p.name) || Array(weeks.length).fill(0);
      return { name: p.name, weekly, commits: weekly.reduce((s, x) => s + x, 0), last_date: p.last_date, idle_days: daysBetween(p.last_date, today) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- pace vs. deadline, as the prediction would have said on each day ------------
  const deadline = getDeadline(db, repo);
  let pace = null;
  if (deadline) {
    pace = daily.map(({ date }) => {
      const p = predictDeadline(db, config, date, repo);
      return { date, pace_ratio: p.pace_ratio ?? null, churn_ratio: p.churn_ratio ?? null, churn_basis: p.churn_basis || null, status: p.status };
    });
  }

  return {
    repo: repo || null,
    start,
    end: today,
    days,
    rules: { comparison_days: n, churn_window_days: config.prediction.windowDays, on_pace: 0.75, at_risk: 0.4, rework: 0.6 },
    totals: { commits: rows.length, contributors: people.size },
    daily,
    weeks,
    churn_basis: lineCommits > 0 ? 'lines' : 'files',
    contributors,
    deadline_date: deadline || null,
    pace,
  };
}

module.exports = { buildAnalytics, weekStart };
