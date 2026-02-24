'use strict';

/**
 * @file MessageStore.js
 * @description In-memory store for captured SMTP messages.
 *
 * We chose to keep messages in a plain JavaScript array rather than a database
 * because the whole point of this service is fast, zero-dependency development
 * feedback. If you need persistence across restarts, swap this class out for a
 * Redis or PostgreSQL-backed equivalent — the interface stays the same.
 *
 * We extend EventEmitter so that other parts of the application (e.g. the web
 * server) can react to store changes without polling. This follows the Observer
 * pattern: subscribers register callbacks; we fire events when state changes.
 *
 * 12-Factor note: in a production deployment you'd replace this with an
 * external backing service (Redis, a database, etc.) so that state survives
 * restarts. For local dev, in-process memory is exactly what we want.
 */

// EventEmitter gives us the on/emit/off API we need to broadcast store events
// to any listeners without coupling them to this class directly.
const { EventEmitter } = require('events');

/**
 * Holds parsed email messages in memory and notifies listeners of changes.
 *
 * @extends EventEmitter
 *
 * @fires MessageStore#message:added   - Fired whenever a new message is stored.
 * @fires MessageStore#message:deleted - Fired when a message is removed by ID.
 * @fires MessageStore#messages:cleared - Fired when all messages are wiped.
 */
class MessageStore extends EventEmitter {
  /**
   * Create a new MessageStore.
   *
   * We accept a `maxMessages` option so that long-running test suites don't
   * silently fill up memory. Once we're over the limit we slice off the tail
   * (i.e. the oldest messages) to keep the array at a predictable size.
   *
   * @param {object} [opts={}]
   * @param {number} [opts.maxMessages=200] - Maximum number of messages to keep.
   */
  constructor({ maxMessages = 200 } = {}) {
    // We must call super() before accessing `this` because EventEmitter sets up
    // internal state (the listener registry) that our methods depend on.
    super();

    // _messages is our backing array. We keep the newest message at index 0
    // (unshift) so callers get the most-recent-first order they expect from
    // an inbox, without needing to reverse or sort on every read.
    this._messages = [];

    // We store the cap so that add() can enforce it every time a new message
    // arrives — we don't want the array growing without bound in a long session.
    this._maxMessages = maxMessages;
  }

  /**
   * Add a parsed message to the front of the store.
   *
   * We extract only the fields we care about from the raw parsed mail object.
   * This keeps our stored representation lean and consistent, regardless of
   * whatever extra metadata the parser attached to the original object.
   *
   * @param {object}      message            - Parsed mail object from mailparser.
   * @param {string}      message.id         - UUID assigned to this message.
   * @param {object[]}    message.from       - Sender address objects.
   * @param {object[]}    message.to         - Recipient address objects.
   * @param {string}      message.subject    - Email subject line.
   * @param {string|null} message.html       - HTML body (null if absent).
   * @param {string|null} message.text       - Plain-text body (null if absent).
   * @param {object}      message.headers    - Flat key/value header map.
   * @param {string}      message.receivedAt - ISO-8601 timestamp of receipt.
   * @returns {object} The stored message snapshot (same shape as the input fields above).
   */
  add(message) {
    // We build a new plain object here rather than storing a reference to the
    // original parsed mail. This prevents external code from accidentally
    // mutating what's in the store — our snapshots are effectively immutable.
    const stored = {
      id: message.id,
      from: message.from,
      to: message.to,
      subject: message.subject,
      // We coerce falsy html/text values to null so consumers can reliably
      // check `=== null` instead of guessing whether they'll get undefined,
      // an empty string, or false.
      html: message.html || null,
      text: message.text || null,
      headers: message.headers,
      receivedAt: message.receivedAt,
    };

    // We unshift (prepend) rather than push (append) so that index 0 always
    // holds the most recent message — no sorting needed on the read side.
    this._messages.unshift(stored);

    // Now we enforce the cap. If we've gone over maxMessages we slice the array
    // down to exactly maxMessages elements, dropping the oldest ones from the tail.
    // We reassign _messages rather than mutating in-place so the slice is atomic
    // from any concurrent-reading perspective (JavaScript is single-threaded,
    // but it's still a cleaner mental model).
    if (this._messages.length > this._maxMessages) {
      this._messages = this._messages.slice(0, this._maxMessages);
    }

    // We emit after storing so that any listener that immediately calls getAll()
    // will see the new message already in the array.
    this.emit('message:added', stored);

    // We return the stored snapshot so the caller can use it without needing
    // to turn around and call getById() — saves a lookup.
    return stored;
  }

  /**
   * Return a shallow copy of all stored messages, most-recent first.
   *
   * We spread into a new array (`[...this._messages]`) so that external code
   * can sort, filter, or otherwise mutate the returned array without affecting
   * our internal state. The message objects themselves are not deep-cloned —
   * that's an acceptable trade-off for a development tool.
   *
   * @returns {object[]} All messages, newest at index 0.
   */
  getAll() {
    // We return a copy of the array, not the array itself, to prevent accidental
    // external mutations (e.g. array.sort() would reorder our internal store).
    return [...this._messages];
  }

  /**
   * Look up a single message by its UUID.
   *
   * We use Array.find() which stops at the first match, so this is O(n) in the
   * worst case but typically fast because recent messages are near the front.
   *
   * @param {string} id - The UUID of the message to find.
   * @returns {object|undefined} The matching message, or undefined if not found.
   */
  getById(id) {
    // We scan from the front (newest first). If the caller is looking for a
    // recently received message, we'll find it quickly.
    return this._messages.find((m) => m.id === id);
  }

  /**
   * Remove a message from the store by its UUID.
   *
   * We use filter() to build a new array that excludes the target message.
   * By comparing lengths before and after we can tell the caller whether
   * anything was actually removed, which is useful for returning the right
   * HTTP status code in the API layer.
   *
   * @param {string} id - The UUID of the message to delete.
   * @returns {boolean} `true` if a message was removed, `false` if it wasn't found.
   */
  deleteById(id) {
    // We snapshot the length before filtering so we can detect whether anything changed.
    const before = this._messages.length;

    // We build a new array that keeps every message EXCEPT the one with the
    // matching ID. This replaces the entire reference, which is safer than
    // splicing in place when we're dealing with potential concurrent readers.
    this._messages = this._messages.filter((m) => m.id !== id);

    // If the array shrank, we know we removed exactly one message (IDs are UUIDs
    // so duplicates shouldn't exist). We emit so UI subscribers can update.
    const removed = this._messages.length < before;
    if (removed) this.emit('message:deleted', id);

    return removed;
  }

  /**
   * Wipe all stored messages.
   *
   * We reset _messages to a fresh empty array rather than calling
   * `array.length = 0` because the latter mutates the existing reference, which
   * could cause subtle bugs if anything else is holding a reference to the old array.
   *
   * After resetting we emit so that any live UI connections know to refresh.
   */
  clear() {
    // Replacing the reference drops all stored message objects for GC to reclaim.
    this._messages = [];

    // We fire this event so that connected clients (e.g. a polling frontend)
    // know the inbox is now empty and can update their view accordingly.
    this.emit('messages:cleared');
  }

  /**
   * The current number of stored messages.
   *
   * We expose this as a getter rather than a method so that callers can write
   * `store.count` instead of `store.count()` — it reads more naturally as a
   * property of the store's current state.
   *
   * @type {number}
   */
  get count() {
    return this._messages.length;
  }
}

module.exports = MessageStore;
