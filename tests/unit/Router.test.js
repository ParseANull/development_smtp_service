'use strict';

const Router = require('../../src/routing/Router');
const MessageStore = require('../../src/smtp/MessageStore');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('Router', () => {
  let store;
  let router;

  const makeMessage = (id = 'msg-1') => ({
    id,
    from: [{ address: 'sender@example.com' }],
    to: [{ address: 'recipient@example.com' }],
    subject: 'Test',
    html: '<p>Test</p>',
    text: 'Test',
    headers: {},
    receivedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    store = new MessageStore();
    router = new Router({ store });
  });

  // ── memory destination ────────────────────────────────────────────────────
  describe('memory destination', () => {
    it('adds message to store and returns ["memory"]', async () => {
      const msg = makeMessage();
      const routed = await router.route(msg, [{ type: 'memory' }]);
      expect(routed).toEqual(['memory']);
      expect(store.count).toBe(1);
    });

    it('does not add to store when storageOnly=false and no memory dest', async () => {
      const msg = makeMessage();
      const routed = await router.route(msg, []);
      expect(routed).toEqual([]);
      expect(store.count).toBe(0);
    });
  });

  // ── filesystem destination ────────────────────────────────────────────────
  describe('filesystem destination', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-router-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes body content to {prefix}/{timestamp}.html and returns ["filesystem"]', async () => {
      const msg = {
        ...makeMessage('fs-msg'),
        receivedAt: '2026-10-13T14:17:05.001Z',
      };
      const routed = await router.route(msg, [{ type: 'filesystem', path: tmpDir }]);
      expect(routed).toEqual(['filesystem']);
      // to: [{ address: 'recipient@example.com' }] → no '+' → prefix only
      const filePath = path.join(tmpDir, 'recipient', '20261013-141705001.html');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('<p>Test</p>');
    });

    it('creates {prefix}/{suffix} subdirectory for plus-addressed recipient', async () => {
      const msg = {
        ...makeMessage('plus-msg'),
        to: [{ address: 'rusty_gregg+testing@domain.local' }],
        receivedAt: '2026-10-13T14:17:05.001Z',
      };
      const routed = await router.route(msg, [{ type: 'filesystem', path: tmpDir }]);
      expect(routed).toEqual(['filesystem']);
      const filePath = path.join(tmpDir, 'rusty_gregg', 'testing', '20261013-141705001.html');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('uses .txt extension for text-only messages', async () => {
      const msg = {
        ...makeMessage('txt-msg'),
        html: null,
        text: 'plain body',
        receivedAt: '2026-10-13T14:17:05.001Z',
      };
      const routed = await router.route(msg, [{ type: 'filesystem', path: tmpDir }]);
      expect(routed).toEqual(['filesystem']);
      const filePath = path.join(tmpDir, 'recipient', '20261013-141705001.txt');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe('plain body');
    });
  });

  // ── storageOnly flag ──────────────────────────────────────────────────────
  describe('storageOnly flag', () => {
    it('skips smtp destination when storageOnly=true', async () => {
      const msg = makeMessage();
      const destinations = [
        { type: 'memory' },
        { type: 'smtp', host: 'smtp.example.com', port: 587 },
      ];
      const routed = await router.route(msg, destinations, true);
      expect(routed).toContain('memory');
      expect(routed).not.toContain('smtp');
    });

    it('includes smtp destination when storageOnly=false', async () => {
      let called = false;
      // Monkey-patch _routeSmtp to avoid real SMTP connection.
      router._routeSmtp = async () => { called = true; };

      const msg = makeMessage();
      const destinations = [{ type: 'smtp', host: 'smtp.example.com', port: 587 }];
      const routed = await router.route(msg, destinations, false);
      expect(routed).toContain('smtp');
      expect(called).toBe(true);
    });
  });

  // ── unknown destination type ──────────────────────────────────────────────
  it('skips unknown destination types without throwing', async () => {
    const msg = makeMessage();
    const routed = await router.route(msg, [{ type: 'unknown-type' }]);
    expect(routed).toEqual([]);
  });

  // ── destination errors ────────────────────────────────────────────────────
  it('continues routing other destinations when one fails', async () => {
    let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-router-err-'));
    try {
      router._routeSmtp = async () => { throw new Error('SMTP error'); };
      const msg = makeMessage('err-msg');
      const destinations = [
        { type: 'smtp', host: 'smtp.example.com' },
        { type: 'filesystem', path: tmpDir },
      ];
      const routed = await router.route(msg, destinations, false);
      expect(routed).not.toContain('smtp');
      expect(routed).toContain('filesystem');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
