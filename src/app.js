'use strict';

/**
 * @file app.js
 * @description Entry point for our development SMTP service.
 * We wire together the SMTP listener, the in-memory message store, the
 * routing engine, and the Express web UI so they all talk to each other.
 * Think of this file as the conductor of our little orchestra — it doesn't
 * play any instruments itself, it just makes sure everyone starts at the
 * right time and stops gracefully when the show is over.
 */

// We pull in Node's built-in HTTP module so we can wrap our Express app
// in a real TCP server and control its lifecycle ourselves.
const http = require('http');

// These are our own modules — each one is responsible for a single concern.
// We keep them separate so we can test and swap them independently.
const MessageStore = require('./smtp/MessageStore');
const SmtpService = require('./smtp/SmtpService');
const Router = require('./routing/Router');
const RoutingConfig = require('./routing/RoutingConfig');
const { createApp } = require('./web/server');

// ── 12-Factor: we read ALL configuration from environment variables ─────────
// This is why we never hard-code hostnames or port numbers: it lets us run
// the same binary in development, staging, and production without code changes.
// The fallback values on the right-hand side are safe defaults for local dev.

/** @type {string} The interface address the SMTP server should bind to. */
const SMTP_HOST = process.env.SMTP_HOST || '0.0.0.0';

/**
 * The TCP port number for the SMTP server.
 * We parse with radix 10 to be explicit — parseInt can behave oddly without it.
 * @type {number}
 */
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '2525', 10);

/** @type {string} The interface address the HTTP/web server should bind to. */
const WEB_HOST = process.env.WEB_HOST || '0.0.0.0';

/** @type {number} The TCP port the web UI and REST API will be served on. */
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

/**
 * The maximum number of messages we'll keep in memory at one time.
 * Once we exceed this, the oldest messages are dropped — we don't want
 * to OOM the process if someone fires a firehose of test emails at us.
 * @type {number}
 */
const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || '200', 10);

/**
 * Bootstrap and run the application.
 *
 * We use an async function here so we can await the SMTP and HTTP servers
 * starting up before we consider the process "ready". Any unhandled rejection
 * bubbles out to the `.catch` at the bottom where we log and exit cleanly.
 *
 * @async
 * @returns {Promise<void>}
 */
async function main() {
  // We create the message store first because everything else depends on it.
  // MAX_MESSAGES tells it how many emails to hold before it starts evicting old ones.
  const store = new MessageStore({ maxMessages: MAX_MESSAGES });

  // The routing config holds the live "where do emails go?" settings.
  // It starts with a sensible default: store everything in memory, no filtering.
  const routingConfig = new RoutingConfig();

  // The router is the component that actually dispatches a received email to
  // each configured destination (memory, filesystem, another SMTP server, etc.).
  // We hand it the store so it can write to memory without needing to import it.
  const router = new Router({ store });

  // We bundle the SMTP host/port into a plain object so we can pass it around
  // as a unit — both the SMTP service and the web config endpoint need it.
  const smtpConfig = { host: SMTP_HOST, port: SMTP_PORT };

  // ── SMTP Server ────────────────────────────────────────────────────────────
  // We spread smtpConfig in here so the SmtpService gets host+port alongside
  // the store, router, and routingConfig it needs for full operation.
  const smtp = new SmtpService({ ...smtpConfig, store, router, routingConfig });

  // We listen for SMTP-level errors and route them to stderr so they're visible
  // in logs without crashing the process. Network hiccups shouldn't kill us.
  smtp.on('error', (err) => console.error('[smtp]', err.message));

  // Whenever the store receives a new message we log a one-liner so developers
  // can see activity in the terminal without opening the UI.
  store.on('message:added', (msg) => {
    console.log(`[smtp] Received: "${msg.subject}" from ${JSON.stringify(msg.from)}`);
  });

  // Now we actually bind the SMTP server to its port. We await this so that if
  // the port is already in use we find out immediately and can exit with an error
  // rather than silently failing.
  await smtp.start();
  console.log(`[smtp] Listening on ${SMTP_HOST}:${SMTP_PORT}`);

  // ── Web Server ─────────────────────────────────────────────────────────────
  // We create the Express app, passing in the same shared dependencies so the
  // REST API has direct access to the live store and routing config.
  const app = createApp({ store, smtpConfig, routingConfig });

  // We wrap the Express app in a raw Node http.Server so we can call
  // server.close() during shutdown and wait for in-flight requests to finish.
  const server = http.createServer(app);

  // We wrap server.listen in a Promise so we can await it the same way we
  // awaited smtp.start() — consistent async flow throughout main().
  await new Promise((resolve) => server.listen(WEB_PORT, WEB_HOST, resolve));
  console.log(`[web]  UI available at http://localhost:${WEB_PORT}`);

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // We define the shutdown handler once and register it for both SIGTERM (sent
  // by container orchestrators like Kubernetes) and SIGINT (Ctrl-C in a terminal).
  // The goal here is to let in-flight connections finish before we exit, so we
  // don't cut off a client mid-response.
  const shutdown = async () => {
    console.log('\n[app]  Shutting down…');

    // We stop the SMTP server first — new mail won't be accepted during shutdown.
    // We swallow any error here because a clean close isn't always possible
    // (e.g. if the server was never fully started).
    await smtp.stop().catch(() => {});

    // Closing the HTTP server lets pending requests drain before we exit(0).
    server.close(() => process.exit(0));
  };

  // We register the same handler for both signals — they both mean "please stop".
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// We kick off main() here. If anything throws during startup we log the full
// error and exit with a non-zero code so process managers know we failed.
main().catch((err) => {
  console.error('[app] Fatal error:', err);
  process.exit(1);
});
