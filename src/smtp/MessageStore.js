'use strict';

const { EventEmitter } = require('events');

/**
 * In-memory store for captured SMTP messages.
 * Implements the Observer pattern via EventEmitter.
 * Follows 12Factor principle: state is kept in-process (swap for Redis in prod).
 */
class MessageStore extends EventEmitter {
  constructor({ maxMessages = 200 } = {}) {
    super();
    this._messages = [];
    this._maxMessages = maxMessages;
  }

  /**
   * Add a parsed message to the store.
   * @param {object} message - Parsed mail object
   * @returns {object} stored message with id and receivedAt
   */
  add(message) {
    const stored = {
      id: message.id,
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html || null,
      text: message.text || null,
      headers: message.headers,
      receivedAt: message.receivedAt,
    };

    this._messages.unshift(stored);

    if (this._messages.length > this._maxMessages) {
      this._messages = this._messages.slice(0, this._maxMessages);
    }

    this.emit('message:added', stored);
    return stored;
  }

  /**
   * Return all messages (most-recent first).
   * @returns {object[]}
   */
  getAll() {
    return [...this._messages];
  }

  /**
   * Find a single message by id.
   * @param {string} id
   * @returns {object|undefined}
   */
  getById(id) {
    return this._messages.find((m) => m.id === id);
  }

  /**
   * Delete a message by id.
   * @param {string} id
   * @returns {boolean} true if removed
   */
  deleteById(id) {
    const before = this._messages.length;
    this._messages = this._messages.filter((m) => m.id !== id);
    const removed = this._messages.length < before;
    if (removed) this.emit('message:deleted', id);
    return removed;
  }

  /**
   * Clear all messages.
   */
  clear() {
    this._messages = [];
    this.emit('messages:cleared');
  }

  /**
   * Number of stored messages.
   * @returns {number}
   */
  get count() {
    return this._messages.length;
  }
}

module.exports = MessageStore;
