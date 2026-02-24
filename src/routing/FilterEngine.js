'use strict';

/**
 * @file FilterEngine.js
 * @description Stateless engine that decides, for a single recipient address,
 * whether a message should be sent to ALL configured destinations or restricted
 * to storage-only destinations.
 *
 * We keep this class small and stateless intentionally. It receives all the
 * information it needs as arguments — no shared state, no side effects. This
 * makes it trivial to unit-test and safe to reuse across the SMTP and HTTP
 * layers without worrying about ordering or concurrency.
 *
 * Filter modes we support:
 *   'none'      - We don't filter at all; every destination receives every message.
 *   'blacklist' - We treat all recipients as allowed UNLESS their address matches
 *                 one of the patterns, in which case we restrict to storage only.
 *   'whitelist' - We treat all recipients as storage-only UNLESS their address
 *                 matches one of the patterns, in which case we allow all destinations.
 */

/**
 * Evaluates recipient email addresses against filter rules and reports
 * whether the message should be restricted to storage-only destinations.
 */
class FilterEngine {
  /**
   * Evaluate a single recipient address against the current filter configuration
   * and return a routing decision.
   *
   * We return an object (rather than a plain boolean) so that callers can also
   * see WHICH pattern matched — useful for the `/api/routing/test` endpoint that
   * wants to show the user exactly why a decision was made.
   *
   * @param {string} recipient - The email address we're evaluating (e.g. "user@example.com").
   * @param {object} [filter={}]             - Filter configuration from RoutingConfig.
   * @param {string} [filter.mode='none']    - The active filter mode ('none'|'blacklist'|'whitelist').
   * @param {string[]} [filter.patterns=[]] - Array of regex pattern strings to test against.
   * @returns {{ storageOnly: boolean, matchedPattern: string|null }}
   *   `storageOnly` is true when non-storage destinations should be skipped.
   *   `matchedPattern` is the first pattern string that matched, or null.
   */
  evaluate(recipient, filter = {}) {
    // We destructure with defaults so that callers can safely pass a partial
    // filter object (or no filter at all) without us throwing on undefined access.
    const { mode = 'none', patterns = [] } = filter;

    // ── Fast path: no filtering requested ─────────────────────────────────────
    // If mode is 'none' we skip all the pattern-matching work entirely and tell
    // the caller "send to everyone, nothing matched".
    if (mode === 'none') {
      return { storageOnly: false, matchedPattern: null };
    }

    // ── Pattern matching ───────────────────────────────────────────────────────
    // We iterate over patterns to find the FIRST one that matches our recipient.
    // We use Array.find() rather than filter() because we only need one match —
    // there's no benefit to testing every pattern once we know there's a hit.
    //
    // Each pattern is treated as a case-insensitive regular expression.
    // We wrap the RegExp constructor in try/catch because RoutingConfig validates
    // patterns on write, but defensive programming here costs almost nothing.
    //
    // We cap the input length before regex evaluation to limit the blast radius
    // of any pattern that could still cause excessive backtracking at runtime.
    const safeRecipient = recipient.length > 256 ? recipient.slice(0, 256) : recipient;
    const matched = patterns.find((pattern) => {
      try {
        // We compile a new RegExp for each pattern on every call. In practice the
        // pattern list is short (typically < 10 entries) and calls are infrequent
        // enough that caching isn't worth the added complexity.
        return new RegExp(pattern, 'i').test(safeRecipient);
      } catch {
        // If a pattern somehow failed to compile (shouldn't happen if
        // RoutingConfig validated it), we treat it as a non-match and move on.
        return false;
      }
    }) ?? null; // ?? null converts undefined (find returned nothing) to null

    // ── Blacklist mode ────────────────────────────────────────────────────────
    // In blacklist mode we ALLOW all recipients through to every destination by
    // default. We only restrict to storage when the recipient matches a pattern —
    // i.e. they're on the "block list".
    if (mode === 'blacklist') {
      // A non-null `matched` means this recipient is blacklisted → storage only.
      // A null `matched` means they're fine → all destinations.
      return { storageOnly: matched !== null, matchedPattern: matched };
    }

    // ── Whitelist mode ────────────────────────────────────────────────────────
    // In whitelist mode we RESTRICT all recipients to storage by default.
    // We only open up all destinations when the recipient matches a pattern —
    // i.e. they're on the "allow list".
    if (mode === 'whitelist') {
      // A null `matched` means this recipient is NOT whitelisted → storage only.
      // A non-null `matched` means they are whitelisted → all destinations.
      return { storageOnly: matched === null, matchedPattern: matched };
    }

    // ── Unknown mode fallback ─────────────────────────────────────────────────
    // We should never reach here because RoutingConfig validates the mode, but
    // defensive programming means we return a safe default rather than throwing.
    return { storageOnly: false, matchedPattern: null };
  }
}

module.exports = FilterEngine;
