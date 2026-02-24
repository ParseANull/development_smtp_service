'use strict';

const http = require('http');
const MessageStore = require('./smtp/MessageStore');
const SmtpService = require('./smtp/SmtpService');
const Router = require('./routing/Router');
const RoutingConfig = require('./routing/RoutingConfig');
const { createApp } = require('./web/server');

// ── 12-Factor: configuration via environment variables ─────────────────────
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '2525', 10);
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || '200', 10);

async function main() {
  const store = new MessageStore({ maxMessages: MAX_MESSAGES });
  const routingConfig = new RoutingConfig();
  const router = new Router({ store });
  const smtpConfig = { host: SMTP_HOST, port: SMTP_PORT };

  // ── SMTP Server ────────────────────────────────────────────────────────────
  const smtp = new SmtpService({ ...smtpConfig, store, router, routingConfig });

  smtp.on('error', (err) => console.error('[smtp]', err.message));

  store.on('message:added', (msg) => {
    console.log(`[smtp] Received: "${msg.subject}" from ${JSON.stringify(msg.from)}`);
  });

  await smtp.start();
  console.log(`[smtp] Listening on ${SMTP_HOST}:${SMTP_PORT}`);

  // ── Web Server ─────────────────────────────────────────────────────────────
  const app = createApp({ store, smtpConfig, routingConfig });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(WEB_PORT, WEB_HOST, resolve));
  console.log(`[web]  UI available at http://localhost:${WEB_PORT}`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('\n[app]  Shutting down…');
    await smtp.stop().catch(() => {});
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[app] Fatal error:', err);
  process.exit(1);
});
