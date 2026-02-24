'use strict';

const { Given, When, Then, defineStep } = require('@cucumber/cucumber');
const assert = require('assert');
const { v4: uuidv4 } = require('uuid');
const MessageStore = require('../../../src/smtp/MessageStore');

let store;

function makeMsg(subject, from, to, id) {
  return {
    id: id || uuidv4(),
    from: [{ address: from || 'sender@example.com' }],
    to: [{ address: to || 'recipient@example.com' }],
    subject,
    html: `<p>${subject}</p>`,
    text: subject,
    headers: {},
    receivedAt: new Date().toISOString(),
  };
}

// ── Background ─────────────────────────────────────────────────────────────
Given('an empty message store', () => {
  store = new MessageStore();
});

Given('a store with a maximum of {int} messages', (max) => {
  store = new MessageStore({ maxMessages: max });
});

// ── Shared step (works as both When and Given) ─────────────────────────────
defineStep(
  'a message is added with subject {string} from {string} to {string}',
  (subject, from, to) => {
    store.add(makeMsg(subject, from, to));
  }
);

When('the message {string} is deleted', (subject) => {
  const msg = store.getAll().find((m) => m.subject === subject);
  assert.ok(msg, `Message with subject "${subject}" not found`);
  store.deleteById(msg.id);
});

When('all messages are cleared', () => {
  store.clear();
});

When('{int} messages are added', (count) => {
  for (let i = 0; i < count; i++) {
    store.add(makeMsg(`Message ${i + 1}`, 'a@example.com', 'b@example.com'));
  }
});

// ── Thens ──────────────────────────────────────────────────────────────────
Then('the store should contain {int} message(s)', (expected) => {
  assert.strictEqual(store.count, expected);
});

Then('the first message should have subject {string}', (expected) => {
  const all = store.getAll();
  assert.ok(all.length > 0, 'Store is empty');
  assert.strictEqual(all[0].subject, expected);
});
