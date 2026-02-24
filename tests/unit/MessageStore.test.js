'use strict';

const MessageStore = require('../../src/smtp/MessageStore');

describe('MessageStore', () => {
  let store;

  beforeEach(() => {
    store = new MessageStore({ maxMessages: 5 });
  });

  const makeMessage = (overrides = {}) => ({
    id: `id-${Math.random()}`,
    from: [{ address: 'sender@example.com' }],
    to: [{ address: 'recipient@example.com' }],
    subject: 'Test Subject',
    html: '<p>Hello</p>',
    text: 'Hello',
    headers: {},
    receivedAt: new Date().toISOString(),
    ...overrides,
  });

  it('should start empty', () => {
    expect(store.count).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it('should add a message and return it', () => {
    const msg = makeMessage({ id: 'abc-123' });
    const stored = store.add(msg);
    expect(stored.id).toBe('abc-123');
    expect(store.count).toBe(1);
  });

  it('should return messages most-recent first', () => {
    const first = makeMessage({ id: 'first', receivedAt: '2024-01-01T00:00:00Z' });
    const second = makeMessage({ id: 'second', receivedAt: '2024-01-02T00:00:00Z' });
    store.add(first);
    store.add(second);
    const all = store.getAll();
    expect(all[0].id).toBe('second');
    expect(all[1].id).toBe('first');
  });

  it('should find a message by id', () => {
    store.add(makeMessage({ id: 'find-me' }));
    const found = store.getById('find-me');
    expect(found).toBeDefined();
    expect(found.id).toBe('find-me');
  });

  it('should return undefined for unknown id', () => {
    expect(store.getById('nope')).toBeUndefined();
  });

  it('should delete a message by id', () => {
    store.add(makeMessage({ id: 'del-me' }));
    const removed = store.deleteById('del-me');
    expect(removed).toBe(true);
    expect(store.count).toBe(0);
  });

  it('should return false when deleting non-existent id', () => {
    expect(store.deleteById('ghost')).toBe(false);
  });

  it('should clear all messages', () => {
    store.add(makeMessage());
    store.add(makeMessage());
    store.clear();
    expect(store.count).toBe(0);
  });

  it('should respect maxMessages limit', () => {
    for (let i = 0; i < 10; i++) {
      store.add(makeMessage({ id: `id-${i}` }));
    }
    expect(store.count).toBe(5);
  });

  it('should emit message:added event when a message is added', (done) => {
    const msg = makeMessage({ id: 'evt-test' });
    store.on('message:added', (stored) => {
      expect(stored.id).toBe('evt-test');
      done();
    });
    store.add(msg);
  });

  it('should emit message:deleted event when a message is deleted', (done) => {
    store.add(makeMessage({ id: 'evt-del' }));
    store.on('message:deleted', (id) => {
      expect(id).toBe('evt-del');
      done();
    });
    store.deleteById('evt-del');
  });

  it('should emit messages:cleared event when cleared', (done) => {
    store.on('messages:cleared', done);
    store.clear();
  });

  it('getAll returns a copy, not the internal array', () => {
    store.add(makeMessage({ id: 'copy-test' }));
    const all = store.getAll();
    all.push({ id: 'injected' });
    expect(store.count).toBe(1);
  });
});
