'use strict';

/**
 * @file SmtpService.js
 * @description Thin wrapper around the `smtp-server` package that turns raw
 * SMTP DATA streams into structured, routed message objects.
 *
 * We apply the Facade pattern here: the smtp-server library has a fairly
 * complex callback-based API, and mailparser adds another layer of async
 * complexity on top. This class hides all of that and gives the rest of the
 * app a clean start()/stop() interface plus a single 'message' event.
 *
 * Why extend EventEmitter? Because we want other parts of the system (like the
 * web UI or logging layers) to react to new messages without being tightly
 * coupled to this class. They just call `smtp.on('message', handler)` and
 * we handle the rest.
 */

// smtp-server gives us the actual SMTP protocol listener. We only need the
// SMTPServer constructor from the package.
const { SMTPServer } = require('smtp-server');

// mailparser's simpleParser converts a raw email byte stream (RFC 5322 format)
// into a nicely structured JavaScript object with parsed headers, addresses, etc.
const { simpleParser } = require('mailparser');

// We use UUID v4 to generate a unique identifier for each received message.
// This ID travels with the message through storage and routing so we can
// always look up or delete any specific email.
const { v4: uuidv4 } = require('uuid');

// EventEmitter is Node's built-in publish/subscribe primitive. We extend it
// so that SmtpService itself can act as an event source.
const { EventEmitter } = require('events');

// We delegate recipient filtering decisions to FilterEngine rather than
// doing string matching inline here. Keeping the logic separate makes it
// easier to unit-test in isolation.
const FilterEngine = require('../routing/FilterEngine');

/**
 * Listens for SMTP connections, parses incoming mail, and routes each message
 * to the configured destinations via the Router.
 *
 * @extends EventEmitter
 *
 * @fires SmtpService#message - Emitted for every successfully parsed email,
 *   with the structured message object as the event payload.
 * @fires SmtpService#error   - Emitted when the underlying SMTPServer encounters
 *   a transport-level error (e.g. a broken socket).
 */
class SmtpService extends EventEmitter {
  /**
   * Set up the SMTP service but don't bind to a port yet — that happens in start().
   *
   * We separate construction from binding so that tests can create a service
   * instance, swap out dependencies, and only then call start(). It also makes
   * the constructor synchronous and therefore simpler to reason about.
   *
   * @param {object}  [options={}]
   * @param {string}  [options.host='0.0.0.0']          - Interface to bind to.
   * @param {number}  [options.port=2525]                - Port to listen on.
   * @param {boolean} [options.allowInsecureAuth=true]   - Allow plaintext AUTH (dev only!).
   * @param {import('../smtp/MessageStore')} options.store          - Where to fall back to if no router.
   * @param {import('../routing/Router')}   [options.router]        - Handles per-destination dispatch.
   * @param {import('../routing/RoutingConfig')} [options.routingConfig] - Live routing + filter settings.
   */
  constructor({ host = '0.0.0.0', port = 2525, allowInsecureAuth = true, store, router, routingConfig } = {}) {
    // Always call super() before accessing `this` in a class that extends
    // another. EventEmitter's constructor sets up the internal listener map.
    super();

    // We save host and port as plain instance properties so that start() can
    // pass them to _server.listen() without needing to close over the options object.
    this.host = host;
    this.port = port;

    // We keep references to shared services as private-by-convention properties
    // (underscore prefix). They're injected rather than instantiated here so
    // tests can pass in mocks without modifying this file.
    this._store = store;
    this._router = router;
    this._routingConfig = routingConfig;

    // We create our own FilterEngine instance rather than injecting one because
    // FilterEngine is stateless — there's no benefit to sharing an instance, and
    // creating it here keeps the constructor self-contained.
    this._filterEngine = new FilterEngine();

    // We configure the underlying smtp-server instance here but don't start it.
    // - allowInsecureAuth: fine for dev, but don't do this in production!
    // - authOptional: we accept mail from unauthenticated senders — we're a
    //   catch-all dev mailbox, not a secure relay.
    // - size: we cap individual messages at 25 MB to prevent a single oversized
    //   email from exhausting process memory (the smtp-server library enforces
    //   this automatically and returns a 552 response to the sender).
    // - onData: we bind our _onData method so `this` inside it is always the
    //   SmtpService instance, not the raw SMTPServer.
    // - onError: we re-emit server errors on ourselves so callers only need to
    //   listen on the SmtpService, not on the internal _server.
    this._server = new SMTPServer({
      allowInsecureAuth,
      authOptional: true,
      size: 26214400, // 25 MB hard limit per message
      onData: this._onData.bind(this),
      onError: (err) => this.emit('error', err),
    });

    // The smtp-server package can also emit 'error' events directly on the server
    // object (separate from onError). We forward those too so nothing slips through.
    this._server.on('error', (err) => this.emit('error', err));
  }

  /**
   * Bind the SMTP server to the configured host and port.
   *
   * We wrap the callback-based `_server.listen()` in a Promise so that callers
   * can use `await smtp.start()` instead of dealing with nested callbacks.
   * If the port is already in use the Promise will reject and the error will
   * propagate up to our `main()` function.
   *
   * @returns {Promise<void>} Resolves when the server is ready to accept connections.
   */
  start() {
    return new Promise((resolve, reject) => {
      // We pass the callback form of listen() which receives an error argument.
      // If err is truthy something went wrong (e.g. EADDRINUSE) and we reject;
      // otherwise we resolve and the server is ready for connections.
      this._server.listen(this.port, this.host, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /**
   * Gracefully stop accepting new connections and close existing ones.
   *
   * We again wrap the callback API in a Promise for the same reason as start() —
   * it gives us a consistent async/await interface throughout the application.
   *
   * @returns {Promise<void>} Resolves when the server has fully closed.
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
   * Handle an incoming SMTP DATA command.
   *
   * This is the hot path: every email that hits us flows through here.
   * The sequence is:
   *   1. Parse the raw stream into a structured message object.
   *   2. Assign a unique ID and a received-at timestamp.
   *   3. Evaluate the filter to decide if non-storage destinations should fire.
   *   4. Dispatch to the router (or fall back to direct store insertion).
   *   5. Emit 'message' so any other listeners know about the new email.
   *   6. Call callback() to tell smtp-server we're done with this message.
   *
   * We mark this private (underscore prefix) because it's only ever called by
   * the smtp-server library — external callers should never invoke it directly.
   *
   * @private
   * @param {import('stream').Readable} stream   - Raw SMTP data stream.
   * @param {object}                    session  - smtp-server session metadata.
   * @param {Function}                  callback - Must be called when we're done.
   * @returns {Promise<void>}
   */
  async _onData(stream, session, callback) {
    try {
      // Step 1 — parse the raw RFC 5322 byte stream into a structured object.
      // simpleParser handles multi-part MIME, base64 attachments, encoded headers,
      // and all the other email weirdness so we don't have to.
      const parsed = await simpleParser(stream);

      // Step 2 — build our canonical message shape. We do this rather than
      // passing the raw `parsed` object around because:
      //   a) it gives us a stable, predictable schema,
      //   b) we add our own id and receivedAt fields here,
      //   c) we normalise missing fields to empty arrays / null so downstream
      //      code never has to guard against undefined.
      const message = {
        // We assign a UUID v4 so this message can be addressed uniquely by the
        // REST API and by any routing destination that needs a file name.
        id: uuidv4(),

        // We fall back to empty arrays for from/to so callers can always iterate
        // without an extra existence check.
        from: parsed.from?.value ?? [],
        to: parsed.to?.value ?? [],

        // A missing subject is normalised to '(no subject)' to avoid blank rows
        // in the UI table.
        subject: parsed.subject ?? '(no subject)',

        // We coerce falsy html/text to null rather than keeping undefined or ''.
        html: parsed.html || null,
        text: parsed.text || null,

        // parsed.headers is a Map; we convert it to a plain object so it can
        // be JSON-serialised without any special handling.
        headers: Object.fromEntries(parsed.headers),

        // We record the receipt time here (not the Date header from the email)
        // because we care about when OUR service saw the message, not when the
        // sender claims they sent it.
        receivedAt: new Date().toISOString(),
      };

      // Step 3 & 4 — decide where the message goes.
      if (this._router && this._routingConfig) {
        // We have a full router + config, so we do proper per-recipient filtering.

        // We snapshot the live config right now so that even if a concurrent API
        // request changes it mid-flight, this message uses a consistent config.
        const cfg = this._routingConfig.get();

        // We extract plain address strings from the potentially-structured to field.
        // The router and filter engine both work with strings, not address objects.
        const recipients = Array.isArray(message.to)
          ? message.to.map((t) => t.address || t)
          : [String(message.to || '')];

        // We evaluate every recipient against the filter. We use the "most
        // permissive wins" rule: if ANY recipient is allowed through (i.e.
        // storageOnly === false), we route to ALL destinations — not just storage.
        // This matches the mental model of "if anyone on the To line is
        // whitelisted, the whole email gets forwarded."
        const storageOnly = recipients.every((addr) => {
          // We ask the filter engine what it thinks about this address.
          // It returns { storageOnly: boolean, matchedPattern: string|null }.
          const result = this._filterEngine.evaluate(addr, cfg.filter);
          return result.storageOnly;
        });

        // We hand off to the router with the storageOnly flag we just computed.
        // The router will iterate over cfg.destinations and skip non-storage ones
        // if storageOnly is true.
        await this._router.route(message, cfg.destinations, storageOnly);
      } else if (this._store) {
        // Fallback path: no router is configured (e.g. in certain unit tests),
        // so we write directly to the in-memory store. This keeps things working
        // even in minimal setups.
        this._store.add(message);
      }

      // Step 5 — broadcast the parsed message to any external listeners.
      // app.js listens here to log a one-liner to stdout for each email.
      this.emit('message', message);

      // Step 6 — tell smtp-server we successfully processed this DATA stream.
      // Calling callback() with no arguments means "250 OK" to the sender.
      callback();
    } catch (err) {
      // If anything went wrong (parse error, router error, etc.) we pass the
      // error to the callback. smtp-server will respond with a 5xx error to the
      // sending client, which is the right behaviour — better than silently losing mail.
      callback(err);
    }
  }
}

module.exports = SmtpService;
