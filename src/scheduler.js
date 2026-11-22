'use strict';
const { localDate } = require('./time');
const { generateSummary, catchUp } = require('./summary');
const { notifyFlags, checkDeadlineUrgency } = require('./notify');
const { reposToProcess } = require('./repository');

/**
 * Saves each day's summary when the day ends.
 * No cron dependency: once every 30 s we compare "today" (in the configured
 * timezone) with the day we last saw. When it changes, the day that just
 * finished is summarized. catchUp() also runs every tick, so days missed while
 * the server was down, and commits pushed late for an already-summarized day,
 * are folded in. Every followed repository is handled on each tick.
 */
function startScheduler({ db, config, mailer = null, log = console, intervalMs = 30_000 }) {
  const label = (repo) => repo || 'all repos';
  const runCatchUp = () => {
    for (const repo of reposToProcess(db, config)) {
      try {
        const caught = catchUp(db, config, Date.now(), repo);
        if (caught.length) {
          const saved = caught.filter((c) => c.saved).length;
          log.info(`[scheduler] ${label(repo)} catch-up: ${saved} of ${caught.length} day(s) summarized or refreshed`);
        }
      } catch (err) {
        log.error(`[scheduler] ${label(repo)} catch-up failed: ${err.message}`);
      }
    }
  };
  runCatchUp();

  let lastDate = localDate(Date.now(), config.timezone);
  let checkingDeadline = false;
  const doneForLastDate = new Set(); // repos whose finished day was already summarized

  const timer = setInterval(() => {
    const repos = reposToProcess(db, config);
    if (mailer && !checkingDeadline) {
      checkingDeadline = true;
      (async () => {
        for (const repo of repos) {
          // eslint-disable-next-line no-await-in-loop
          await checkDeadlineUrgency(db, config, mailer, log, repo)
            .catch((err) => log.error(`[scheduler] ${label(repo)} deadline check failed: ${err.message}`));
        }
      })().finally(() => { checkingDeadline = false; });
    }

    const today = localDate(Date.now(), config.timezone);
    if (today !== lastDate) {
      let failed = false;
      for (const repo of repos) {
        if (doneForLastDate.has(repo)) continue;
        try {
          const result = generateSummary(db, config, lastDate, 'scheduled', { repo });
          log.info(`[scheduler] ${label(repo)} ${lastDate}: ${result.saved ? 'summary saved' : `skipped (${result.reason})`}`);
          if ((result.saved || result.flagged) && mailer) {
            const flags = db.prepare('SELECT type, detail FROM flags WHERE repo = ? AND date = ?').all(repo, lastDate);
            notifyFlags(db, config, mailer, lastDate, flags, log, repo)
              .catch((err) => log.error(`[scheduler] ${label(repo)} flag email failed: ${err.message}`));
          }
          doneForLastDate.add(repo);
        } catch (err) {
          // Don't let one bad repo crash the process; catch-up retries it on a later tick.
          log.error(`[scheduler] could not summarize ${label(repo)} ${lastDate}: ${err.message}`);
          failed = true;
        }
      }
      if (failed) return; // the next tick retries only the repos that failed
      lastDate = today;
      doneForLastDate.clear();
    }
    runCatchUp();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startScheduler };
