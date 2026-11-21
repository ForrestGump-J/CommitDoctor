'use strict';
const { config } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./scheduler');
const { startPoller } = require('./poller');
const { createMailer } = require('./mailer');
const { startRepoSync } = require('./hooks');

const db = openDb(config.dbPath);
const mailer = createMailer(config);
const app = createApp({ db, config, mailer });
startScheduler({ db, config, mailer });
startPoller({ db, config, intervalMs: config.pollIntervalMs });
startRepoSync({ db, config });

const server = app.listen(config.port, () => {
  console.log(`Commit Doctor listening on http://localhost:${config.port}`);
  console.log(`  Webhook endpoint : POST /webhook/github`);
  console.log(`  Timezone         : ${config.timezone}`);
  console.log(`  Repository       : ${config.repo || '(any - set GITHUB_REPO to lock to one)'}`);
  console.log(`  Background sync  : ${config.syncIntervalMs ? `every ${Math.round(config.syncIntervalMs / 60_000)} min` : 'off (SYNC_INTERVAL_MS=0)'}`);
  console.log(`  Email            : ${mailer ? `on (${config.smtp.host})` : 'off (set SMTP_HOST to enable)'}`);
  console.log(`  Webhook secret   : ${process.env.GITHUB_WEBHOOK_SECRET ? 'from .env' : 'auto-generated (shown in the dashboard setup panel)'}`);
});

// server.close() waits for open keep-alive connections (an open dashboard tab
// holds one), so drop idle ones and force-close the rest after a moment.
const shutdown = () => {
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); }, 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
