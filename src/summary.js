'use strict';
const { addDays, daysBetween, localDate, localTime } = require('./time');
const { predictDeadline } = require('./predict');
const { classify } = require('./intent');
const { IN_REPO, trackedRepo } = require('./repository');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hourLabel = (h) => `${String(h).padStart(2, '0')}:00`;
/** "Oct 14" (with the year when it differs from `ref`). */
function dayText(date, ref = date) {
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(String(ref).slice(0, 4) !== date.slice(0, 4) ? { year: 'numeric' } : {}) });
}

/**
 * How a day compares with its baseline, in words people can read at a glance:
 * "40% above the 7-day average", "well above the usual 0.3 a day" (a quiet repo,
 * where percentages explode), "about 6× the usual 1.2 a day", "after a quiet
 * 7-day stretch". Shared by the headline and the stored flags.
 */
function comparisonPhrase(c, total) {
  const avg = c.average;
  if (c.trend === 'above') {
    if (!avg) return `after a quiet ${c.baseline_days}-day stretch`;
    if (avg < 1) return `well above the usual ${avg} a day`;
    if (total / avg >= 3) return `about ${Math.round(total / avg)}× the usual ${avg} a day`;
    return `${c.delta_pct}% above the ${c.baseline_days}-day average`;
  }
  if (c.trend === 'below') return `${Math.abs(c.delta_pct)}% below the ${c.baseline_days}-day average`;
  if (c.trend === 'steady') return `about the usual for the last ${c.baseline_days} days`;
  return '';
}

// Every function below works on one repository. `repo` defaults to the one the
// dashboard is showing; the scheduler passes each followed repo in turn.

/**
 * Turn the commits of one calendar day into a summary object.
 * Pure aggregation over SQLite; no side effects, so it can be used both for the
 * "live" view of today and for the snapshot saved at the end of a day.
 */
function buildSummary(db, config, date, repo = trackedRepo(db, config)) {
  const tz = config.timezone;
  const rows = db
    .prepare(`SELECT * FROM commits WHERE committed_date = ? AND ${IN_REPO} ORDER BY committed_at`)
    .all({ repo }, date);
  const total = rows.length;

  // --- who, how many, when -------------------------------------------------
  const hourly = Array(24).fill(0);
  const byPerson = new Map();
  let merges = 0;
  const intents = {};
  for (const r of rows) {
    // NLP: what kind of work each commit message describes (src/intent.js).
    const it = r.is_merge ? 'merge' : classify(r.message).intent;
    intents[it] = (intents[it] || 0) + 1;
    hourly[r.committed_hour] += 1;
    if (r.is_merge) merges += 1;
    let p = byPerson.get(r.contributor);
    if (!p) {
      p = { name: r.contributor, display_name: r.author_name, commits: 0, merges: 0, first_at: r.committed_at, last_at: r.committed_at, lines_added: 0, lines_deleted: 0, lines_known: false };
      byPerson.set(r.contributor, p);
    }
    p.commits += 1;
    if (r.is_merge) p.merges += 1;
    if (r.lines_added != null && r.lines_deleted != null){
      p.lines_added += r.lines_added;
      p.lines_deleted += r.lines_deleted;
      p.lines_known = true;
    }
    p.last_at = r.committed_at;
  }
  const contributors = [...byPerson.values()]
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
    .map((p) => ({
      name: p.name,
      display_name: p.display_name,
      commits: p.commits,
      merges: p.merges,
      lines_added: p.lines_known ? p.lines_added : null,
      lines_deleted: p.lines_known ? p.lines_deleted : null,
      lines_changed: p.lines_known ? p.lines_added + p.lines_deleted : null,
      share: total ? p.commits / total : 0,
      first_time: localTime(p.first_at, tz),
      last_time: localTime(p.last_at, tz),
    }));

  const peakCount = Math.max(...hourly);
  const peakHour = total ? hourly.indexOf(peakCount) : null;

  // --- compared to recent days ---------------------------------------------
  // Baseline = average commits per day over the previous N calendar days, but
  // never reaching back before the first commit ever recorded (otherwise a new
  // installation would look permanently "busy" against empty history).
  const n = config.summary.comparisonDays;
  const firstDate = db.prepare(`SELECT MIN(committed_date) AS d FROM commits WHERE ${IN_REPO}`).get({ repo }).d;
  let start = addDays(date, -n);
  if (firstDate && firstDate > start) start = firstDate;
  const baselineDays = Math.max(0, daysBetween(start, date));

  let comparison = { baseline_days: 0, average: null, delta_pct: null, trend: 'no-baseline' };
  if (baselineDays > 0) {
    const sum = db
      .prepare(`SELECT COUNT(*) AS c FROM commits WHERE committed_date >= ? AND committed_date < ? AND ${IN_REPO}`)
      .get({ repo }, start, date).c;
    const average = sum / baselineDays;
    // Above/below needs both a relative change (25%) and an absolute one
    // (SUMMARY_MIN_DIFFERENCE commits), so tiny repos aren't flagged for 1-2 commits.
    let trend = 'steady';
    const farEnough = Math.abs(total - average) >= (config.summary.minDifference ?? 3);
    if (average === 0) trend = total > 0 && farEnough ? 'above' : 'steady';
    else if (total > average * 1.25 && farEnough) trend = 'above';
    else if (total < average * 0.75 && farEnough) trend = 'below';
    comparison = {
      baseline_days: baselineDays,
      average: Math.round(average * 10) / 10,
      delta_pct: average > 0 ? Math.round(((total - average) / average) * 100) : null,
      trend,
    };
  }

  const summary = {
    repo: repo || null,
    date,
    timezone: tz,
    total_commits: total,
    contributor_count: contributors.length,
    merge_commits: merges,
    first_commit_time: total ? localTime(rows[0].committed_at, tz) : null,
    last_commit_time: total ? localTime(rows[total - 1].committed_at, tz) : null,
    peak_hour: peakHour,
    hourly,
    contributors,
    comparison,
    intents,
  };
  summary.headline = writeHeadline(summary);
  return summary;
}

const INTENT_WORD = { feature: 'feature work', fix: 'fixes', docs: 'documentation', refactor: 'refactoring', test: 'tests', chore: 'maintenance', merge: 'merges' };
const INTENT_COUNT = { feature: 'feature', fix: 'fix', docs: 'docs change', refactor: 'refactor', test: 'test change', chore: 'chore', merge: 'merge' };
const countIntent = (k, v) => (k === 'fix' ? `${v} fix${v === 1 ? '' : 'es'}` : plural(v, INTENT_COUNT[k] || k));

/** " Mostly fixes (3 of 5)." — the dominant commit intent, when there is one. */
function describeIntents(intents, total) {
  const [top, n] = Object.entries(intents).sort((a, b) => b[1] - a[1])[0] || [];
  if (!top || total < 2) return '';
  if (n === total) return ` All ${INTENT_WORD[top]}.`;
  if (n / total > 0.5) return ` Mostly ${INTENT_WORD[top]} (${n} of ${total}).`;
  return ` Mixed work: ${Object.entries(intents).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => countIntent(k, v)).join(', ')}.`;
}

/** One plain sentence or two: the "doctor's note" for the day. */
function writeHeadline(s) {
  if (s.total_commits === 0) return 'No commits were recorded this day.';
  const c = s.comparison;
  let text = `${plural(s.total_commits, 'commit')} from ${plural(s.contributor_count, 'contributor')}`;
  const phrase = comparisonPhrase(c, s.total_commits);
  if (phrase) text += `, ${phrase}`;
  text += '.';
  const top = s.contributors[0];
  text += s.contributor_count > 1
    ? ` ${top.name} was most active with ${top.commits}.`
    : ` All by ${top.name}.`;
  text += ` Activity peaked around ${hourLabel(s.peak_hour)}.`;
  text += describeIntents(s.intents || {}, s.total_commits);
  return text;
}

/**
 * Discrete, storable version of the rolling-baseline comparison: activity clearly
 * above/below the baseline, and any contributor who has commits on record but has
 * gone quiet for a full comparison window as of this date ("extended inactivity").
 * Pure function of the summary + commit history; storage happens in generateSummary.
 */
function detectFlags(db, config, date, summaryData, repo = trackedRepo(db, config)) {
  const flags = [];
  const c = summaryData.comparison;

  if (c.trend === 'above' || c.trend === 'below') {
    flags.push({
      type: c.trend === 'above' ? 'activity_above_baseline' : 'activity_below_baseline',
      detail: `${plural(summaryData.total_commits, 'commit')}, ${comparisonPhrase(c, summaryData.total_commits)}.`,
    });
  }

  // Contributors with history who have gone quiet for a full comparison window.
  const n = config.summary.comparisonDays;
  const cutoff = addDays(date, -n);
  const quiet = db
    .prepare(
      `SELECT contributor, MAX(committed_date) AS last_date FROM commits
       WHERE committed_date <= ? AND ${IN_REPO}
       GROUP BY contributor
       HAVING last_date <= ?`
    )
    .all({ repo }, date, cutoff);
    // Only flag once per stretch of inactivity (same contributor + same last commit
  // date), not on every following day.
  const alreadyFlagged = db.prepare(
    `SELECT 1 FROM flags WHERE repo = ? AND type = 'contributor_inactive' AND date < ? AND instr(detail, ?) = 1 LIMIT 1`
  );
  for (const row of quiet) {
    const since = `${row.contributor} has had no commits since `;
    // Older flags wrote the date as 2026-10-14; newer ones as "Oct 14".
    if (alreadyFlagged.get(repo, date, `${since}${row.last_date} `) || alreadyFlagged.get(repo, date, `${since}${dayText(row.last_date, date)} (`)) continue;
    const idleDays = daysBetween(row.last_date, date);
    flags.push({
      type: 'contributor_inactive',
      detail: `${since}${dayText(row.last_date, date)} (${plural(idleDays, 'day')}).`,
    });
  }

  return flags;
}

/**
 * Deadline-projection flag, kept separate from detectFlags above since it isn't
 * a function of the day's summary alone — it needs project_settings.deadline_date
 * and the commit history up to `date`. Returns [] when there's no deadline set,
 * not enough history yet, or the projection is on-pace (nothing worth flagging).
 */
function detectDeadlineFlag(db, config, date, repo = trackedRepo(db, config)) {
  const p = predictDeadline(db, config, date, repo);
  if (p.status !== 'at-risk' && p.status !== 'behind') return [];
  const pct = Math.round(p.pace_ratio * 100);
  let detail = `Recent commit pace is ${pct}% of the project's earlier pace, with ${plural(p.days_remaining, 'day')} left until the deadline.`;
  if (p.churn_ratio != null && p.churn_ratio > 0.6) {
    detail += ` Recent changes lean heavily toward removals/rework (${Math.round(p.churn_ratio * 100)}% of ${p.churn_basis === 'lines' ? 'lines' : 'files'} changed).`;
  }
  return [{ type: p.status === 'behind' ? 'deadline_behind' : 'deadline_at_risk', detail }];
}

/** Replaces the stored flags for a day with freshly detected ones. Returns how many. */
function saveFlags(db, config, date, data, repo) {
  db.prepare('DELETE FROM flags WHERE repo = ? AND date = ?').run(repo, date);
  const insertFlag = db.prepare('INSERT INTO flags (repo, date, type, detail) VALUES (?, ?, ?, ?)');
  const flags = [...detectFlags(db, config, date, data, repo), ...detectDeadlineFlag(db, config, date, repo)];
  for (const f of flags) insertFlag.run(repo, date, f.type, f.detail);
  return flags.length;
}
// --- saving ----------------------------------------------------------------

function generateSummary(db, config, date, trigger, { force = false, repo = trackedRepo(db, config) } = {}) {
  const total = db.prepare(`SELECT COUNT(*) AS c FROM commits WHERE committed_date = ? AND ${IN_REPO}`).get({ repo }, date).c;
  const insertRun = db.prepare('INSERT INTO summary_runs (repo, date, trigger, outcome, total_commits) VALUES (?, ?, ?, ?, ?)');
  const logRun = { run: (...args) => insertRun.run(repo, ...args) };

  if (total === 0) {
    // No summary to save, but a silent day can still be worth flagging.
    const flagCount = saveFlags(db, config, date, buildSummary(db, config, date, repo), repo);
    logRun.run(date, trigger, 'skipped', 0);
    return { saved: false, flagged: flagCount > 0, reason: 'No commits on this day.' };
  }
  if (!force && total < config.summary.minCommits) {
    logRun.run(date, trigger, 'skipped', total);
    return { saved: false, reason: `Only ${plural(total, 'commit')}; the minimum is ${config.summary.minCommits}.` };
  }

  const data = buildSummary(db, config, date, repo);
  const generatedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO summaries (repo, date, total_commits, data, trigger, generated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, date) DO UPDATE SET total_commits = excluded.total_commits, data = excluded.data,
       trigger = excluded.trigger, generated_at = excluded.generated_at`
  ).run(repo, date, total, JSON.stringify(data), trigger, generatedAt);

  saveFlags(db, config, date, data, repo);
  
  logRun.run(date, trigger, 'saved', total);
  return { saved: true, summary: { ...data, source: 'saved', trigger, generated_at: generatedAt } };
}

/**
 * Summary for a day as the dashboard should show it:
 * today (or later) is always computed live; past days use the saved snapshot
 * if one exists and fall back to a live computation if not.
 */
function getSummary(db, config, date, now = Date.now(), repo = trackedRepo(db, config)) {
  const today = localDate(now, config.timezone);
  if (date < today) {
    const row = db.prepare('SELECT * FROM summaries WHERE repo = ? AND date = ?').get(repo, date);
    if (row) return { ...JSON.parse(row.data), source: 'saved', trigger: row.trigger, generated_at: row.generated_at };
  }
  return { ...buildSummary(db, config, date, repo), source: 'live', trigger: null, generated_at: null };
}

/**
 * Past days whose saved summary is missing or out of date: never summarized (e.g. the
 * server was off at midnight), or commits arrived after the summary was saved (e.g. a
 * commit made Friday but pushed Monday). Days skipped for being under the minimum are
 * left alone until their commit count changes.
 */
function catchUp(db, config, now = Date.now(), repo = trackedRepo(db, config)) {
  const today = localDate(now, config.timezone);
  const stale = db
    .prepare(
      `SELECT c.d AS d FROM (
         SELECT committed_date AS d, COUNT(*) AS n FROM commits WHERE committed_date < ? AND ${IN_REPO} GROUP BY committed_date
       ) c
       LEFT JOIN summaries s ON s.repo = @repo AND s.date = c.d
       WHERE (s.date IS NULL AND NOT EXISTS (
                SELECT 1 FROM summary_runs r WHERE r.repo = @repo AND r.date = c.d AND r.outcome = 'skipped' AND r.total_commits = c.n))
          OR (s.date IS NOT NULL AND s.total_commits <> c.n)
       ORDER BY c.d`
    )
    .all({ repo }, today)
    .map((r) => r.d);
  return stale.map((d) => ({ date: d, ...generateSummary(db, config, d, 'catchup', { repo }) }));
}

/** Commits per day for the last `days` days ending today, zero-filled. */
function getTrend(db, config, days = 14, now = Date.now(), repo = trackedRepo(db, config)) {
  const today = localDate(now, config.timezone);
  const start = addDays(today, -(days - 1));
  const counts = new Map(
    db
      .prepare(`SELECT committed_date AS d, COUNT(*) AS c, COUNT(DISTINCT contributor) AS p FROM commits WHERE committed_date >= ? AND ${IN_REPO} GROUP BY committed_date`)
      .all({ repo }, start)
      .map((r) => [r.d, r])
  );
  const saved = new Set(db.prepare('SELECT date FROM summaries WHERE repo = ? AND date >= ?').all(repo, start).map((r) => r.date));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const r = counts.get(date);
    return { date, commits: r ? r.c : 0, contributors: r ? r.p : 0, saved: saved.has(date), is_today: date === today };
  });
}

/**
 * Rewrite stored flag text from older versions into the current wording
 * ("1 commit", "Oct 14", "well above the usual 0.3 a day" instead of "4450%").
 * Text only: ids, types and dates stay, so read markers are unaffected. Idempotent.
 */
function tidyFlagText(db) {
  const update = db.prepare('UPDATE flags SET detail = ? WHERE id = ?');
  let changed = 0;
  for (const f of db.prepare("SELECT id, date, type, detail FROM flags WHERE type IN ('activity_above_baseline', 'activity_below_baseline', 'contributor_inactive', 'deadline_at_risk', 'deadline_behind')").all()) {
    let d = f.detail;
    let m;
    if ((m = d.match(/^(\d+) commits?, (\d+)% above the (\d+)-day average\.$/))) {
      const total = Number(m[1]);
      const pct = Number(m[2]);
      const average = Math.round((total / (1 + pct / 100)) * 10) / 10;
      d = `${plural(total, 'commit')}, ${comparisonPhrase({ trend: 'above', average, delta_pct: pct, baseline_days: Number(m[3]) }, total)}.`;
    } else if ((m = d.match(/^(\d+) commits?, (.*)$/))) {
      d = `${plural(Number(m[1]), 'commit')}, ${m[2]}`;
    } else if ((m = d.match(/^(.+ has had no commits since )(\d{4}-\d{2}-\d{2}) \((\d+) days?\)\.$/))) {
      d = `${m[1]}${dayText(m[2], f.date)} (${plural(Number(m[3]), 'day')}).`;
    }
    d = d.replace(/with (\d+) day\(s\) left/, (_, n) => `with ${plural(Number(n), 'day')} left`);
    if (d !== f.detail) { update.run(d, f.id); changed += 1; }
  }
  return changed;
}

module.exports = { tidyFlagText, comparisonPhrase, dayText, buildSummary, generateSummary, getSummary, catchUp, getTrend, detectFlags, detectDeadlineFlag };