'use strict';

const RoutingConfig = require('../../src/routing/RoutingConfig');

describe('RoutingConfig', () => {
  let config;

  beforeEach(() => {
    config = new RoutingConfig();
  });

  it('starts with memory-only destination and no filter', () => {
    const cfg = config.get();
    expect(cfg.destinations).toEqual([{ type: 'memory' }]);
    expect(cfg.filter).toEqual({ mode: 'none', patterns: [] });
  });

  it('get() returns a deep copy', () => {
    const cfg = config.get();
    cfg.destinations.push({ type: 'smtp' });
    expect(config.get().destinations).toHaveLength(1);
  });

  it('set() updates destinations', () => {
    config.set({ destinations: [{ type: 'memory' }, { type: 'filesystem', path: '/tmp/mail' }] });
    expect(config.get().destinations).toHaveLength(2);
  });

  it('set() updates filter', () => {
    config.set({ filter: { mode: 'blacklist', patterns: ['blocked@.*'] } });
    const cfg = config.get();
    expect(cfg.filter.mode).toBe('blacklist');
    expect(cfg.filter.patterns).toEqual(['blocked@.*']);
  });

  it('set() accepts a partial update (only filter)', () => {
    config.set({ filter: { mode: 'whitelist', patterns: [] } });
    const cfg = config.get();
    expect(cfg.destinations).toEqual([{ type: 'memory' }]); // unchanged
    expect(cfg.filter.mode).toBe('whitelist');
  });

  it('emits "changed" event after set()', (done) => {
    config.on('changed', (cfg) => {
      expect(cfg.filter.mode).toBe('blacklist');
      done();
    });
    config.set({ filter: { mode: 'blacklist', patterns: [] } });
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  it('throws on invalid destination type', () => {
    expect(() => config.set({ destinations: [{ type: 'ftp' }] }))
      .toThrow(/Unknown destination type/);
  });

  it('throws when destinations is not an array', () => {
    expect(() => config.set({ destinations: 'memory' }))
      .toThrow(/"destinations" must be an array/);
  });

  it('throws on invalid filter mode', () => {
    expect(() => config.set({ filter: { mode: 'deny', patterns: [] } }))
      .toThrow(/Invalid filter mode/);
  });

  it('throws when filter.patterns is not an array', () => {
    expect(() => config.set({ filter: { mode: 'none', patterns: 'bad' } }))
      .toThrow(/"filter.patterns" must be an array/);
  });

  it('throws on invalid RegEx pattern', () => {
    expect(() => config.set({ filter: { mode: 'blacklist', patterns: ['[invalid'] } }))
      .toThrow(/Invalid RegEx pattern/);
  });

  it('accepts a custom initial configuration', () => {
    const custom = new RoutingConfig({
      destinations: [{ type: 'filesystem', path: '/tmp' }],
      filter: { mode: 'whitelist', patterns: ['admin@.*'] },
    });
    const cfg = custom.get();
    expect(cfg.destinations[0].type).toBe('filesystem');
    expect(cfg.filter.mode).toBe('whitelist');
  });
});
