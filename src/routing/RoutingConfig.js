'use strict';

/**
 * @file RoutingConfig.js
 * @description Live, in-memory routing and filter configuration.
 *
 * We store this in a class (rather than a plain object) for two reasons:
 *   1. Validation — we want to reject invalid config before it can affect routing.
 *   2. Reactivity — we extend EventEmitter so the rest of the app can subscribe
 *      to configuration changes and react immediately (e.g. log a notice, refresh
 *      a cached snapshot) without polling.
 *
 * Design notes:
 *   - We deep-clone on every get() call so that external code can't accidentally
 *     mutate our internal state by holding a reference to the returned object.
 *   - We validate in set() rather than in get(), so reads are always fast.
 *   - We emit a 'changed' event after every successful set() so that listeners
 *     (e.g. a future WebSocket push to connected browsers) can react.
 */

// EventEmitter lets us broadcast configuration changes to interested parties
// without them needing to poll or hold a direct reference to this instance.
const { EventEmitter } = require('events');

/**
 * The set of filter modes we recognise.
 * We define this as a module-level constant so we only write the list once —
 * both the validation logic and error messages reference the same array.
 *
 * @type {string[]}
 */
const VALID_MODES = ['none', 'blacklist', 'whitelist'];

/**
 * The set of destination types the Router knows how to handle.
 * Again, a module-level constant so validation and error messages stay in sync.
 *
 * @type {string[]}
 */
const VALID_DEST_TYPES = ['memory', 'filesystem', 's3', 'azure', 'gcp', 'smtp'];

/**
 * Holds the live routing + filter configuration and notifies listeners when it changes.
 *
 * Default configuration on startup:
 *   - One 'memory' destination (all emails go to the in-process store).
 *   - Filter mode 'none' (no recipient filtering; everyone gets everything).
 *
 * @extends EventEmitter
 * @fires RoutingConfig#changed - Emitted after every successful set(), with the
 *   new configuration object as the payload.
 */
class RoutingConfig extends EventEmitter {
  /**
   * Create a RoutingConfig, optionally pre-seeded with an initial configuration.
   *
   * We accept `initial` so that tests can start with a specific config without
   * needing to call set() after construction. The nullish coalescing operator
   * (`??`) means we only use the fallback when the caller didn't provide a value
   * at all — an explicit `null` or `undefined` would still trigger the default.
   *
   * @param {object}   [initial={}]
   * @param {object[]} [initial.destinations] - Starting destination list.
   * @param {object}   [initial.filter]       - Starting filter config.
   */
  constructor(initial = {}) {
    // We call super() before touching `this` so that EventEmitter's internal
    // listener registry is set up before we reference `this._config`.
    super();

    // We build the initial config object here in the constructor. We use `??`
    // rather than `||` for the defaults because `||` would replace an empty array
    // (falsy) with the default, which isn't what we want — an explicit empty
    // destinations array should remain empty, not be replaced with [{ type: 'memory' }].
    this._config = {
      destinations: initial.destinations ?? [{ type: 'memory' }],
      filter: initial.filter ?? { mode: 'none', patterns: [] },
    };
  }

  /**
   * Return a deep copy of the current configuration.
   *
   * We JSON round-trip the config to create a completely independent copy.
   * This is not the most performant deep-clone, but for small config objects
   * (a handful of destinations and patterns) it's fast enough and perfectly correct.
   * It also guarantees that any non-serialisable properties are dropped — though
   * in practice our config is always plain JSON.
   *
   * @returns {{ destinations: object[], filter: { mode: string, patterns: string[] } }}
   */
  get() {
    // JSON.parse(JSON.stringify(...)) gives us a deep clone. Any code that
    // receives this object can mutate it freely without affecting our internal state.
    return JSON.parse(JSON.stringify(this._config));
  }

  /**
   * Validate and apply a partial or full configuration update.
   *
   * We validate before mutating so that the internal state is never left in a
   * half-updated, inconsistent condition. If anything fails validation we throw
   * immediately with a descriptive message — the caller (the API layer) catches
   * this and returns a 400 to the client.
   *
   * We accept partial updates (just `destinations`, just `filter`, or both) so
   * that the API client doesn't need to send the entire config on every request.
   *
   * @param {{ destinations?: object[], filter?: object }} updates - Fields to update.
   * @throws {Error} If any part of `updates` fails validation.
   */
  set(updates) {
    // We start from a deep clone of the current config so that we're building
    // the "next" state without touching the live state. This means that if
    // validation fails partway through, `this._config` is still the last known
    // good config.
    const next = this.get();

    // ── Validate and apply destinations ──────────────────────────────────────
    if (updates.destinations !== undefined) {
      // We require destinations to be an array. A non-array (e.g. a single
      // object, a string, null) is a caller error and we tell them clearly.
      if (!Array.isArray(updates.destinations)) {
        throw new Error('"destinations" must be an array');
      }

      // We iterate over every destination and check that its type is one we
      // recognise. We validate all of them before mutating anything so that a
      // problem at index 3 doesn't leave indexes 0–2 already applied.
      for (const dest of updates.destinations) {
        if (!VALID_DEST_TYPES.includes(dest.type)) {
          throw new Error(
            `Unknown destination type "${dest.type}". Valid types: ${VALID_DEST_TYPES.join(', ')}`
          );
        }
      }

      // All destinations passed validation — we can safely update next.
      next.destinations = updates.destinations;
    }

    // ── Validate and apply filter ─────────────────────────────────────────────
    if (updates.filter !== undefined) {
      // We destructure mode and patterns so the validation code below reads cleanly.
      const { mode, patterns } = updates.filter;

      // We only validate mode if it was actually included in the update — the
      // caller might be updating only the patterns without changing the mode.
      if (mode !== undefined && !VALID_MODES.includes(mode)) {
        throw new Error(
          `Invalid filter mode "${mode}". Valid modes: ${VALID_MODES.join(', ')}`
        );
      }

      if (patterns !== undefined) {
        // Patterns must be an array of strings. A non-array means the caller
        // made a structural mistake in their request body.
        if (!Array.isArray(patterns)) {
          throw new Error('"filter.patterns" must be an array');
        }

        // We validate each pattern as a RegExp before storing it. If a pattern
        // is invalid we fail fast with a clear message — better to reject the
        // whole update now than to silently store a broken pattern that will
        // never match anything (or, worse, throw at evaluation time).
        for (const p of patterns) {
          try {
            new RegExp(p);
          } catch {
            throw new Error(`Invalid RegEx pattern: "${p}"`);
          }
        }
      }

      // All filter fields passed validation. We apply them to `next`, using
      // nullish coalescing to fall back to 'none' / [] when the caller omitted
      // either field from a partial filter update.
      next.filter = { mode: mode ?? 'none', patterns: patterns ?? [] };
    }

    // ── Commit the new configuration ─────────────────────────────────────────
    // We replace `_config` atomically (a single assignment) now that all
    // validation has passed. From this point forward, any call to get() will
    // return the new config.
    this._config = next;

    // We emit the 'changed' event AFTER committing so that any listener that
    // immediately calls get() will see the updated config, not the old one.
    this.emit('changed', this.get());
  }
}

module.exports = RoutingConfig;
