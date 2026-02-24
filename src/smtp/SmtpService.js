'use strict';

const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');
const FilterEngine = require('../routing/FilterEngine');

/**
 * SmtpService wraps an smtp-server instance and emits parsed mail events.
 * Implements the Facade pattern: hides smtp-server and mailparser complexity.
 */
class SmtpService extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.host='0.0.0.0']
   * @param {number} [options.port=2525]
   * @param {boolean} [options.allowInsecureAuth=true]
   * @param {import('../smtp/MessageStore')} options.store
   * @param {import('../routing/Router')} [options.router]
   * @param {import('../routing/RoutingConfig')} [options.routingConfig]
   */
  constructor({ host = '0.0.0.0', port = 2525, allowInsecureAuth = true, store, router, routingConfig } = {}) {
    super();
    this.host = host;
    this.port = port;
    this._store = store;
    this._router = router;
    this._routingConfig = routingConfig;
    this._filterEngine = new FilterEngine();

    this._server = new SMTPServer({
      allowInsecureAuth,
      authOptional: true,
      onData: this._onData.bind(this),
      onError: (err) => this.emit('error', err),
    });

    this._server.on('error', (err) => this.emit('error', err));
  }

  /**
   * Start listening for SMTP connections.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server.listen(this.port, this.host, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Stop the SMTP server gracefully.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      this._server.close((err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Handle incoming SMTP DATA stream.
   * @private
   */
  async _onData(stream, session, callback) {
    try {
      const parsed = await simpleParser(stream);
      const message = {
        id: uuidv4(),
        from: parsed.from?.value ?? [],
        to: parsed.to?.value ?? [],
        subject: parsed.subject ?? '(no subject)',
        html: parsed.html || null,
        text: parsed.text || null,
        headers: Object.fromEntries(parsed.headers),
        receivedAt: new Date().toISOString(),
      };

      if (this._router && this._routingConfig) {
        // Determine routing based on filter evaluation for each recipient.
        const cfg = this._routingConfig.get();
        const recipients = Array.isArray(message.to)
          ? message.to.map((t) => t.address || t)
          : [String(message.to || '')];

        // Use the most permissive result: if ANY recipient passes, route to all.
        const storageOnly = recipients.every((addr) => {
          const result = this._filterEngine.evaluate(addr, cfg.filter);
          return result.storageOnly;
        });

        await this._router.route(message, cfg.destinations, storageOnly);
      } else if (this._store) {
        // Fallback: no router configured, just store in memory.
        this._store.add(message);
      }

      this.emit('message', message);
      callback();
    } catch (err) {
      callback(err);
    }
  }
}

module.exports = SmtpService;
