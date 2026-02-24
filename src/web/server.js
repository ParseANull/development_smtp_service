'use strict';

/**
 * @file server.js
 * @description Express application factory for the development SMTP service web UI.
 *
 * We export a `createApp` factory function rather than a module-level singleton
 * so that each test file can spin up a fresh Express instance with its own
 * store and routing config. This avoids the subtle cross-test contamination you
 * get when multiple tests share a single app instance.
 *
 * What lives here:
 *   - A rate limiter on the SPA fallback route (protects against accidental
 *     hammering from browser extensions or misconfigured proxies).
 *   - A REST API for messages (list, get, delete, clear).
 *   - A REST API for SMTP config info (read-only).
 *   - A REST API for routing + filter config (read/write).
 *   - A routing test endpoint so developers can preview filter decisions.
 *   - A health-check endpoint for liveness probes.
 *   - A SPA fallback that serves index.html for any unrecognised path.
 */

// Express is our web framework. We use it for routing, middleware, and JSON parsing.
const express = require('express');

// path is a Node built-in we use to build absolute file paths for static serving
// without hardcoding OS-specific separators.
const path = require('path');

// express-rate-limit protects our static file serving from being abused.
// We don't rate-limit the API itself because in development you often want to
// run automated tests or scripts that fire many requests quickly.
const rateLimit = require('express-rate-limit');

// We need FilterEngine here so the routing/test endpoint can preview decisions
// using the same logic as the real SMTP path — we never want them to diverge.
const FilterEngine = require('../routing/FilterEngine');

// ── Rate limiter for static assets / SPA fallback ─────────────────────────
// 300 requests per minute is generous for a human browsing the UI but should
// stop a runaway bot or misconfigured proxy from hammering us. We only apply
// this to the SPA fallback route, not the API, to avoid interfering with tests.
const staticLimiter = rateLimit({
  windowMs: 60 * 1000,  // We use a 60-second sliding window
  max: 300,             // We allow up to 300 requests per window per IP
  standardHeaders: true,  // We send RateLimit-* headers so clients can back off
  legacyHeaders: false,   // We don't send the older X-RateLimit-* headers
});

/**
 * The routing config we fall back to when no `routingConfig` instance was
 * injected (e.g. in certain unit tests). We keep it here so the API still
 * returns sensible data rather than crashing with a null dereference.
 *
 * @type {{ destinations: object[], filter: { mode: string, patterns: string[] } }}
 */
const DEFAULT_ROUTING = {
  destinations: [{ type: 'memory' }],
  filter: { mode: 'none', patterns: [] },
};

/**
 * Create and configure an Express application with all routes wired up.
 *
 * We accept dependencies as a plain object so that callers only need to provide
 * what they have — a test that only exercises the message API doesn't need to
 * pass a routingConfig, and a test for the routing API doesn't need a store.
 *
 * @param {object}  [deps={}]
 * @param {import('../smtp/MessageStore')}    [deps.store]         - In-memory message store.
 * @param {object}                            [deps.smtpConfig={}] - SMTP host/port for the config endpoint.
 * @param {import('../routing/RoutingConfig')} [deps.routingConfig] - Live routing + filter config.
 * @returns {import('express').Application} The configured Express app (not yet listening).
 */
function createApp({ store, smtpConfig = {}, routingConfig } = {}) {
  // We create a fresh Express app instance each time this function is called.
  // This is what makes the factory pattern safe for parallel test runs.
  const app = express();

  // We create a FilterEngine instance to use in the routing/test endpoint.
  // It's stateless so we only need one per app instance.
  const filterEngine = new FilterEngine();

  // We register JSON body parsing globally so every route that reads req.body
  // gets a parsed JavaScript object without needing to add middleware per route.
  app.use(express.json());

  // We serve everything in the `public` directory as static files. This is how
  // the browser-based UI (HTML, CSS, JS) is delivered. express.static handles
  // ETags, Last-Modified, and Content-Type for us automatically.
  app.use(express.static(path.join(__dirname, 'public')));

  // ── REST API ────────────────────────────────────────────────────────────────
  // We prefix all API routes with /api/ to make it easy to distinguish them
  // from static file requests and to set up a reverse proxy if needed.

  /**
   * GET /api/messages
   * Return the full list of captured messages, most-recent first.
   * We return an empty array (not 404) when the store isn't set — an empty
   * inbox is a valid state, not an error.
   */
  app.get('/api/messages', (req, res) => {
    // We guard against a missing store (could happen in a minimal test setup)
    // by falling back to an empty array, which is a sensible "no messages" response.
    res.json(store ? store.getAll() : []);
  });

  /**
   * GET /api/messages/:id
   * Look up a single message by its UUID. We return 404 if it doesn't exist
   * so the client can distinguish "not found" from "store is empty".
   */
  app.get('/api/messages/:id', (req, res) => {
    // We look up the message by ID. If the store is missing or the ID doesn't
    // match anything, `message` will be null/undefined and we return 404.
    const message = store ? store.getById(req.params.id) : null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  });

  /**
   * DELETE /api/messages/:id
   * Delete a single message by UUID. Returns 204 on success, 404 if not found.
   * We use 204 (No Content) rather than 200 because there's nothing useful to
   * return in the body after a deletion.
   */
  app.delete('/api/messages/:id', (req, res) => {
    // deleteById returns true if something was removed, false otherwise.
    // We map those outcomes to 204 and 404 respectively.
    const removed = store ? store.deleteById(req.params.id) : false;
    if (!removed) return res.status(404).json({ error: 'Message not found' });
    res.status(204).end();
  });

  /**
   * DELETE /api/messages
   * Clear ALL messages at once. Always returns 204 — even if the store was
   * already empty, clearing an empty inbox is a no-op success, not an error.
   */
  app.delete('/api/messages', (req, res) => {
    // We call clear() only if a store exists. Either way the response is the same.
    if (store) store.clear();
    res.status(204).end();
  });

  /**
   * GET /api/config
   * Return non-sensitive SMTP configuration so the UI can display the correct
   * host:port for the "connect your mail client here" instructions.
   * We deliberately omit any credentials or secrets from this response.
   */
  app.get('/api/config', (req, res) => {
    res.json({
      smtp: {
        // We fall back to safe default values if smtpConfig wasn't passed in.
        host: smtpConfig.host || '0.0.0.0',
        port: smtpConfig.port || 2525,
      },
    });
  });

  // ── Routing & Filtering API ─────────────────────────────────────────────────
  // These endpoints let the developer change routing and filter behaviour at
  // runtime via the UI or a REST client, without restarting the service.

  /**
   * GET /api/routing
   * Return the current routing + filter configuration as JSON.
   * We fall back to DEFAULT_ROUTING so the endpoint always returns something
   * sensible even if routingConfig wasn't injected.
   */
  app.get('/api/routing', (req, res) => {
    res.json(routingConfig ? routingConfig.get() : DEFAULT_ROUTING);
  });

  /**
   * PUT /api/routing
   * Replace the routing + filter configuration with the request body.
   * We delegate validation to RoutingConfig.set(); if it throws we turn the
   * error message into a 400 response so the client knows what went wrong.
   */
  app.put('/api/routing', (req, res) => {
    // We return 503 if routingConfig wasn't injected — this endpoint can't work
    // without it, and 503 (Service Unavailable) is more informative than 500.
    if (!routingConfig) return res.status(503).json({ error: 'Routing not configured' });
    try {
      // We pass the parsed request body directly to set(). It does the validation
      // and either updates the config or throws with a descriptive error message.
      routingConfig.set(req.body);

      // On success we return the *new* config so the client can confirm what
      // was applied without needing a follow-up GET request.
      res.json(routingConfig.get());
    } catch (err) {
      // Validation failed — we surface the error message as-is. RoutingConfig
      // formats its error messages to be readable by an end user.
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/routing/test
   * Preview how an email to a given recipient would be handled under the
   * current routing + filter configuration, without actually sending an email.
   *
   * This is our "what would happen if…?" endpoint — really useful for debugging
   * filter rules without needing to send real test emails.
   *
   * Request body:  { "recipient": "user@example.com" }
   * Response body: {
   *   recipient,
   *   filter: { mode, storageOnly, matchedPattern },
   *   destinations: [{ type, active, ...destConfig }]
   * }
   */
  app.post('/api/routing/test', (req, res) => {
    // We extract the recipient from the body. If it's missing or not a string
    // we return 400 immediately — there's nothing else we can do without it.
    const { recipient } = req.body || {};
    if (!recipient || typeof recipient !== 'string') {
      return res.status(400).json({ error: '"recipient" string is required' });
    }

    // We snapshot the current config (or fall back to DEFAULT_ROUTING) so that
    // the test runs against a consistent state even if a concurrent PUT is in flight.
    const cfg = routingConfig ? routingConfig.get() : DEFAULT_ROUTING;

    // We ask the filter engine what it would do with this recipient under the
    // current filter config. This gives us storageOnly and matchedPattern.
    const filterResult = filterEngine.evaluate(recipient, cfg.filter);

    // We annotate each configured destination with an `active` flag that
    // reflects whether it would receive this email given the filter decision.
    // - If storageOnly is false, ALL destinations are active.
    // - If storageOnly is true, only storage-type destinations are active.
    const destinations = cfg.destinations.map((dest) => {
      // We check whether this destination type is a "storage" type.
      const isStorage = ['memory', 'filesystem', 's3', 'azure', 'gcp'].includes(dest.type);

      // A destination is "active" if either: the filter didn't restrict us to
      // storage only, OR this particular destination is a storage type anyway.
      const active = !filterResult.storageOnly || isStorage;

      // We spread the original dest config and add the `active` field so the
      // caller can see the full destination settings alongside the decision.
      return { ...dest, active };
    });

    // We send back a rich response so the caller can understand the full picture:
    // which filter mode is active, what decision was made, why (matchedPattern),
    // and what each destination would do.
    res.json({
      recipient,
      filter: {
        mode: cfg.filter.mode,
        storageOnly: filterResult.storageOnly,
        matchedPattern: filterResult.matchedPattern,
      },
      destinations,
    });
  });

  /**
   * GET /health
   * Liveness probe for container orchestrators (Kubernetes, ECS, etc.).
   * We return the process uptime so operators can see how long we've been running
   * without needing to check external monitoring.
   */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // ── SPA fallback ────────────────────────────────────────────────────────────
  // Any request that didn't match an API route or a static file should get the
  // index.html SPA shell, which handles client-side routing in the browser.
  // We apply the rate limiter here specifically to prevent browser-refresh loops
  // or automated crawlers from hitting this path excessively.
  app.get('/{*path}', staticLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // We return the fully configured app. The caller (app.js or a test) is
  // responsible for calling server.listen() — we stay agnostic about ports here.
  return app;
}

module.exports = { createApp };
