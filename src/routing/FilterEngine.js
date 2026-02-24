'use strict';

/**
 * Evaluates recipient email addresses against filter rules.
 *
 * Modes:
 *   'none'      - No filtering; all configured destinations are used.
 *   'blacklist' - All destinations used by default. Recipients matching a
 *                 pattern are restricted to storage-only destinations.
 *   'whitelist' - Storage-only by default. Recipients matching a pattern
 *                 are allowed to reach all configured destinations.
 */
class FilterEngine {
  /**
   * Evaluate a recipient address against filter configuration.
   *
   * @param {string} recipient - Email address to evaluate.
   * @param {{ mode?: string, patterns?: string[] }} filter
   * @returns {{ storageOnly: boolean, matchedPattern: string|null }}
   */
  evaluate(recipient, filter = {}) {
    const { mode = 'none', patterns = [] } = filter;

    if (mode === 'none') {
      return { storageOnly: false, matchedPattern: null };
    }

    const matched = patterns.find((pattern) => {
      try {
        return new RegExp(pattern, 'i').test(recipient);
      } catch {
        return false;
      }
    }) ?? null;

    if (mode === 'blacklist') {
      // Blacklisted recipients (matched patterns) are restricted to storage only.
      return { storageOnly: matched !== null, matchedPattern: matched };
    }

    if (mode === 'whitelist') {
      // Only whitelisted recipients (matched patterns) reach all destinations.
      return { storageOnly: matched === null, matchedPattern: matched };
    }

    return { storageOnly: false, matchedPattern: null };
  }
}

module.exports = FilterEngine;
