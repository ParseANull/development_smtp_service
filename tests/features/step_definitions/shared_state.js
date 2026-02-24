'use strict';

/**
 * Shared mutable state for Cucumber step definitions.
 * Each scenario resets the relevant fields in its Background step.
 */
const state = {
  app: null,
  store: null,
  routingConfig: null,
  response: null,
};

module.exports = state;
