'use strict';

const request = require('supertest');
const { createApp } = require('../../src/web/server');
const MessageStore = require('../../src/smtp/MessageStore');

// Install supertest as a dev dependency if not present
// (it is declared in package.json devDependencies)

describe('Web API', () => {
  let app;
  let store;

  const makeMessage = (id = 'test-id') => ({
    id,
    from: [{ address: 'from@example.com' }],
    to: [{ address: 'to@example.com' }],
    subject: 'Hello',
    html: '<p>Hi</p>',
    text: 'Hi',
    headers: {},
    receivedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    store = new MessageStore();
    app = createApp({ store, smtpConfig: { host: '127.0.0.1', port: 2525 } });
  });

  // ── GET /health ─────────────────────────────────────────────────────────────
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  // ── GET /api/config ─────────────────────────────────────────────────────────
  it('GET /api/config returns smtp settings', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body.smtp.port).toBe(2525);
  });

  // ── GET /api/messages ───────────────────────────────────────────────────────
  it('GET /api/messages returns empty array initially', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /api/messages returns stored messages', async () => {
    store.add(makeMessage('m1'));
    store.add(makeMessage('m2'));
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // ── GET /api/messages/:id ───────────────────────────────────────────────────
  it('GET /api/messages/:id returns a message', async () => {
    store.add(makeMessage('find-123'));
    const res = await request(app).get('/api/messages/find-123');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('find-123');
  });

  it('GET /api/messages/:id returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/messages/nope');
    expect(res.status).toBe(404);
  });

  // ── DELETE /api/messages/:id ────────────────────────────────────────────────
  it('DELETE /api/messages/:id deletes a message', async () => {
    store.add(makeMessage('del-123'));
    const res = await request(app).delete('/api/messages/del-123');
    expect(res.status).toBe(204);
    expect(store.getById('del-123')).toBeUndefined();
  });

  it('DELETE /api/messages/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/messages/ghost');
    expect(res.status).toBe(404);
  });

  // ── DELETE /api/messages ────────────────────────────────────────────────────
  it('DELETE /api/messages clears all messages', async () => {
    store.add(makeMessage('a'));
    store.add(makeMessage('b'));
    const res = await request(app).delete('/api/messages');
    expect(res.status).toBe(204);
    expect(store.count).toBe(0);
  });
});
