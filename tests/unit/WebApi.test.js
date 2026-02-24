'use strict';

const request = require('supertest');
const { createApp } = require('../../src/web/server');
const MessageStore = require('../../src/smtp/MessageStore');
const RoutingConfig = require('../../src/routing/RoutingConfig');

// Install supertest as a dev dependency if not present
// (it is declared in package.json devDependencies)

describe('Web API', () => {
  let app;
  let store;
  let routingConfig;

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
    routingConfig = new RoutingConfig();
    app = createApp({ store, smtpConfig: { host: '127.0.0.1', port: 2525 }, routingConfig });
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

  // ── GET /api/routing ────────────────────────────────────────────────────────
  it('GET /api/routing returns default routing config', async () => {
    const res = await request(app).get('/api/routing');
    expect(res.status).toBe(200);
    expect(res.body.destinations).toEqual([{ type: 'memory' }]);
    expect(res.body.filter).toEqual({ mode: 'none', patterns: [] });
  });

  // ── PUT /api/routing ────────────────────────────────────────────────────────
  it('PUT /api/routing updates the routing configuration', async () => {
    const payload = {
      destinations: [{ type: 'memory' }, { type: 'filesystem', path: '/tmp/mail' }],
      filter: { mode: 'blacklist', patterns: ['blocked@.*'] },
    };
    const res = await request(app).put('/api/routing').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.destinations).toHaveLength(2);
    expect(res.body.filter.mode).toBe('blacklist');
  });

  it('PUT /api/routing returns 400 for invalid destination type', async () => {
    const res = await request(app).put('/api/routing').send({ destinations: [{ type: 'ftp' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown destination type/);
  });

  it('PUT /api/routing returns 400 for invalid filter mode', async () => {
    const res = await request(app).put('/api/routing').send({ filter: { mode: 'deny', patterns: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid filter mode/);
  });

  // ── POST /api/routing/test ──────────────────────────────────────────────────
  it('POST /api/routing/test returns routing preview for a recipient', async () => {
    const res = await request(app).post('/api/routing/test').send({ recipient: 'user@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.recipient).toBe('user@example.com');
    expect(res.body.filter.mode).toBe('none');
    expect(res.body.destinations[0].active).toBe(true);
  });

  it('POST /api/routing/test returns 400 when recipient is missing', async () => {
    const res = await request(app).post('/api/routing/test').send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/routing/test shows storageOnly for blacklisted recipient', async () => {
    await request(app).put('/api/routing').send({
      destinations: [{ type: 'memory' }, { type: 'smtp', host: 'smtp.example.com' }],
      filter: { mode: 'blacklist', patterns: ['blocked@.*'] },
    });
    const res = await request(app)
      .post('/api/routing/test')
      .send({ recipient: 'blocked@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.filter.storageOnly).toBe(true);
    const smtpDest = res.body.destinations.find((d) => d.type === 'smtp');
    expect(smtpDest.active).toBe(false);
    const memDest = res.body.destinations.find((d) => d.type === 'memory');
    expect(memDest.active).toBe(true);
  });
});
