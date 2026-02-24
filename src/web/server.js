'use strict';

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const FilterEngine = require('../routing/FilterEngine');

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const DEFAULT_ROUTING = {
  destinations: [{ type: 'memory' }],
  filter: { mode: 'none', patterns: [] },
};

/**
 * Create and configure the Express application.
 * @param {object} deps - Dependencies (store, smtpConfig, routingConfig)
 * @returns {express.Application}
 */
function createApp({ store, smtpConfig = {}, routingConfig } = {}) {
  const app = express();
  const filterEngine = new FilterEngine();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── REST API ────────────────────────────────────────────────────────────────

  /** GET /api/messages – list all captured messages */
  app.get('/api/messages', (req, res) => {
    res.json(store ? store.getAll() : []);
  });

  /** GET /api/messages/:id – get single message */
  app.get('/api/messages/:id', (req, res) => {
    const message = store ? store.getById(req.params.id) : null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json(message);
  });

  /** DELETE /api/messages/:id – delete single message */
  app.delete('/api/messages/:id', (req, res) => {
    const removed = store ? store.deleteById(req.params.id) : false;
    if (!removed) return res.status(404).json({ error: 'Message not found' });
    res.status(204).end();
  });

  /** DELETE /api/messages – clear all messages */
  app.delete('/api/messages', (req, res) => {
    if (store) store.clear();
    res.status(204).end();
  });

  /** GET /api/config – return running configuration (non-sensitive) */
  app.get('/api/config', (req, res) => {
    res.json({
      smtp: {
        host: smtpConfig.host || '0.0.0.0',
        port: smtpConfig.port || 2525,
      },
    });
  });

  // ── Routing & Filtering API ─────────────────────────────────────────────────

  /** GET /api/routing – return current routing + filter configuration */
  app.get('/api/routing', (req, res) => {
    res.json(routingConfig ? routingConfig.get() : DEFAULT_ROUTING);
  });

  /** PUT /api/routing – replace routing + filter configuration */
  app.put('/api/routing', (req, res) => {
    if (!routingConfig) return res.status(503).json({ error: 'Routing not configured' });
    try {
      routingConfig.set(req.body);
      res.json(routingConfig.get());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * POST /api/routing/test – preview how an email to a given recipient
   * would be handled under the current routing + filter configuration.
   *
   * Body: { "recipient": "user@example.com" }
   * Response: { recipient, filter: { mode, storageOnly, matchedPattern }, destinations: [{ type, active }] }
   */
  app.post('/api/routing/test', (req, res) => {
    const { recipient } = req.body || {};
    if (!recipient || typeof recipient !== 'string') {
      return res.status(400).json({ error: '"recipient" string is required' });
    }

    const cfg = routingConfig ? routingConfig.get() : DEFAULT_ROUTING;
    const filterResult = filterEngine.evaluate(recipient, cfg.filter);

    const destinations = cfg.destinations.map((dest) => {
      const isStorage = ['memory', 'filesystem', 's3', 'azure', 'gcp'].includes(dest.type);
      const active = !filterResult.storageOnly || isStorage;
      return { ...dest, active };
    });

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

  /** GET /health – liveness probe */
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // ── SPA fallback ────────────────────────────────────────────────────────────
  app.get('/{*path}', staticLimiter, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

module.exports = { createApp };
