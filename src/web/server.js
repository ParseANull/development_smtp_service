'use strict';

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const staticLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Create and configure the Express application.
 * @param {object} deps - Dependencies (store, smtpConfig)
 * @returns {express.Application}
 */
function createApp({ store, smtpConfig = {} } = {}) {
  const app = express();

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
