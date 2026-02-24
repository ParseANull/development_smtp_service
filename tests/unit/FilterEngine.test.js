'use strict';

const FilterEngine = require('../../src/routing/FilterEngine');

describe('FilterEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new FilterEngine();
  });

  // ── mode: none ─────────────────────────────────────────────────────────────
  describe('mode: none', () => {
    it('returns storageOnly=false for any recipient', () => {
      const result = engine.evaluate('anyone@example.com', { mode: 'none', patterns: [] });
      expect(result.storageOnly).toBe(false);
      expect(result.matchedPattern).toBeNull();
    });

    it('returns storageOnly=false even when patterns are provided', () => {
      const result = engine.evaluate('anyone@example.com', { mode: 'none', patterns: ['.*'] });
      expect(result.storageOnly).toBe(false);
    });
  });

  // ── mode: blacklist ────────────────────────────────────────────────────────
  describe('mode: blacklist', () => {
    it('returns storageOnly=false when no pattern matches', () => {
      const result = engine.evaluate('user@example.com', {
        mode: 'blacklist',
        patterns: ['blocked@.*'],
      });
      expect(result.storageOnly).toBe(false);
      expect(result.matchedPattern).toBeNull();
    });

    it('returns storageOnly=true and sets matchedPattern when a pattern matches', () => {
      const result = engine.evaluate('blocked@example.com', {
        mode: 'blacklist',
        patterns: ['blocked@.*'],
      });
      expect(result.storageOnly).toBe(true);
      expect(result.matchedPattern).toBe('blocked@.*');
    });

    it('matches case-insensitively', () => {
      const result = engine.evaluate('BLOCKED@example.com', {
        mode: 'blacklist',
        patterns: ['blocked@.*'],
      });
      expect(result.storageOnly).toBe(true);
    });

    it('matches the first matching pattern', () => {
      const result = engine.evaluate('test@example.com', {
        mode: 'blacklist',
        patterns: ['nomatch@.*', 'test@.*', 'also@.*'],
      });
      expect(result.matchedPattern).toBe('test@.*');
    });
  });

  // ── mode: whitelist ────────────────────────────────────────────────────────
  describe('mode: whitelist', () => {
    it('returns storageOnly=true when no pattern matches', () => {
      const result = engine.evaluate('user@example.com', {
        mode: 'whitelist',
        patterns: ['allowed@.*'],
      });
      expect(result.storageOnly).toBe(true);
      expect(result.matchedPattern).toBeNull();
    });

    it('returns storageOnly=false and sets matchedPattern when a pattern matches', () => {
      const result = engine.evaluate('allowed@example.com', {
        mode: 'whitelist',
        patterns: ['allowed@.*'],
      });
      expect(result.storageOnly).toBe(false);
      expect(result.matchedPattern).toBe('allowed@.*');
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns storageOnly=false when filter is not provided', () => {
      const result = engine.evaluate('user@example.com');
      expect(result.storageOnly).toBe(false);
    });

    it('skips invalid RegEx patterns without throwing', () => {
      const result = engine.evaluate('user@example.com', {
        mode: 'blacklist',
        patterns: ['[invalid', 'user@.*'],
      });
      // The invalid pattern is skipped; the valid one matches.
      expect(result.storageOnly).toBe(true);
      expect(result.matchedPattern).toBe('user@.*');
    });

    it('returns storageOnly=false for unknown mode', () => {
      const result = engine.evaluate('user@example.com', {
        mode: 'unknown',
        patterns: ['.*'],
      });
      expect(result.storageOnly).toBe(false);
    });

    it('truncates a very long recipient to 256 characters before matching', () => {
      const longAddr = 'a'.repeat(300) + '@example.com';
      // Should not throw and should still evaluate correctly.
      expect(() => engine.evaluate(longAddr, { mode: 'none', patterns: [] })).not.toThrow();
      // Exact match on truncated form: pattern covering the 256-char prefix still matches.
      const result = engine.evaluate(longAddr, {
        mode: 'blacklist',
        patterns: ['a{256}'],
      });
      expect(result.storageOnly).toBe(true);
    });
  });
});
