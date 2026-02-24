'use strict';

const { Given, When, Then } = require('@cucumber/cucumber');
const assert = require('assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const MessageStore = require('../../../src/smtp/MessageStore');
const { createApp } = require('../../../src/web/server');

let store;
let app;
let response;

function makeMsg(id, subject) {
  return {
    id: id || uuidv4(),
    from: [{ address: 'from@example.com' }],
    to: [{ address: 'to@example.com' }],
    subject: subject || 'Test',
    html: `<p>${subject}</p>`,
    text: subject,
    headers: {},
    receivedAt: new Date().toISOString(),
  };
}

// ── Background ─────────────────────────────────────────────────────────────
Given('an empty message store and a running web app', () => {
  store = new MessageStore();
  app = createApp({ store, smtpConfig: { host: '127.0.0.1', port: 2525 } });
});

// ── Givens ──────────────────────────────────────────────────────────────────
Given('a captured message with subject {string}', (subject) => {
  store.add(makeMsg(null, subject));
});

Given('a captured message with id {string} and subject {string}', (id, subject) => {
  store.add(makeMsg(id, subject));
});

// ── Whens ───────────────────────────────────────────────────────────────────
When('I GET {string}', async (path) => {
  response = await request(app).get(path);
});

When('I DELETE {string}', async (path) => {
  response = await request(app).delete(path);
});

// ── Thens ───────────────────────────────────────────────────────────────────
Then('the response status should be {int}', (expected) => {
  assert.strictEqual(response.status, expected);
});

Then('the response body should be an empty array', () => {
  assert.deepStrictEqual(response.body, []);
});

Then('the response body should contain {int} message(s)', (count) => {
  assert.strictEqual(response.body.length, count);
});

Then('the response body subject should be {string}', (expected) => {
  assert.strictEqual(response.body.subject, expected);
});

Then('the response body should contain {string}', (text) => {
  const bodyStr = JSON.stringify(response.body);
  assert.ok(bodyStr.includes(text), `Expected "${text}" in response body`);
});

Then('the message {string} should no longer exist', (id) => {
  assert.strictEqual(store.getById(id), undefined);
});
