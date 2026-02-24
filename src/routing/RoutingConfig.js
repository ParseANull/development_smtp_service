'use strict';

const { EventEmitter } = require('events');

const VALID_MODES = ['none', 'blacklist', 'whitelist'];
const VALID_DEST_TYPES = ['memory', 'filesystem', 's3', 'azure', 'gcp', 'smtp'];

/**
 * Manages routing and filter configuration.
 * Configuration is held in-memory and can be updated at runtime via the API.
 *
 * Default: single memory destination with no filtering.
 */
class RoutingConfig extends EventEmitter {
  /**
   * @param {object} [initial]
   * @param {object[]} [initial.destinations]
   * @param {object}   [initial.filter]
   */
  constructor(initial = {}) {
    super();
    this._config = {
      destinations: initial.destinations ?? [{ type: 'memory' }],
      filter: initial.filter ?? { mode: 'none', patterns: [] },
    };
  }

  /**
   * Return a deep copy of the current configuration.
   * @returns {{ destinations: object[], filter: { mode: string, patterns: string[] } }}
   */
  get() {
    return JSON.parse(JSON.stringify(this._config));
  }

  /**
   * Replace the routing configuration after validation.
   * Throws an Error describing the first validation problem found.
   *
   * @param {{ destinations?: object[], filter?: object }} updates
   */
  set(updates) {
    const next = this.get();

    if (updates.destinations !== undefined) {
      if (!Array.isArray(updates.destinations)) {
        throw new Error('"destinations" must be an array');
      }
      for (const dest of updates.destinations) {
        if (!VALID_DEST_TYPES.includes(dest.type)) {
          throw new Error(
            `Unknown destination type "${dest.type}". Valid types: ${VALID_DEST_TYPES.join(', ')}`
          );
        }
      }
      next.destinations = updates.destinations;
    }

    if (updates.filter !== undefined) {
      const { mode, patterns } = updates.filter;
      if (mode !== undefined && !VALID_MODES.includes(mode)) {
        throw new Error(
          `Invalid filter mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`
        );
      }
      if (patterns !== undefined) {
        if (!Array.isArray(patterns)) {
          throw new Error('"filter.patterns" must be an array');
        }
        for (const p of patterns) {
          try {
            new RegExp(p);
          } catch {
            throw new Error(`Invalid RegEx pattern: "${p}"`);
          }
        }
      }
      next.filter = { mode: mode ?? 'none', patterns: patterns ?? [] };
    }

    this._config = next;
    this.emit('changed', this.get());
  }
}

module.exports = RoutingConfig;
