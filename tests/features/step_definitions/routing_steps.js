'use strict';

const { Given, When, Then } = require('@cucumber/cucumber');
const assert = require('assert');
const request = require('supertest');
const MessageStore = require('../../../src/smtp/MessageStore');
const RoutingConfig = require('../../../src/routing/RoutingConfig');
const { createApp } = require('../../../src/web/server');
const state = require('./shared_state');

// ── Background ──────────────────────────────────────────────────────────────
Given('an empty message store and a running web app with routing', () => {
  state.store = new MessageStore();
  state.routingConfig = new RoutingConfig();
  state.app = createApp({ store: state.store, smtpConfig: { host: '127.0.0.1', port: 2525 }, routingConfig: state.routingConfig });
});

// ── Givens ───────────────────────────────────────────────────────────────────
Given(
  'the routing is configured with filter mode {string} and patterns {string} and destinations {string}',
  (mode, patterns, destList) => {
    const destinations = destList.split(',').map((t) => ({ type: t.trim() }));
    state.routingConfig.set({
      destinations,
      filter: { mode, patterns: [patterns] },
    });
  }
);

// ── Whens ────────────────────────────────────────────────────────────────────
When(
  'I PUT {string} with destinations {string} and filter mode {string} and patterns {string}',
  async (path, destList, mode, patterns) => {
    const destinations = destList.split(',').map((t) => ({ type: t.trim() }));
    state.response = await request(state.app)
      .put(path)
      .send({ destinations, filter: { mode, patterns: [patterns] } });
  }
);

When('I PUT {string} with an invalid destination type {string}', async (path, badType) => {
  state.response = await request(state.app).put(path).send({ destinations: [{ type: badType }] });
});

When('I POST {string} with recipient {string}', async (path, recipient) => {
  state.response = await request(state.app).post(path).send({ recipient });
});

When('I POST {string} without a recipient', async (path) => {
  state.response = await request(state.app).post(path).send({});
});

// ── Thens ────────────────────────────────────────────────────────────────────
Then('the routing destinations should include {string}', (type) => {
  const dests = state.response.body.destinations;
  assert.ok(
    Array.isArray(dests) && dests.some((d) => d.type === type),
    `Expected destination "${type}" in ${JSON.stringify(dests)}`
  );
});

Then('the filter mode should be {string}', (mode) => {
  assert.strictEqual(state.response.body.filter.mode, mode);
});

Then('the routing test result should be storage only', () => {
  assert.strictEqual(state.response.body.filter.storageOnly, true);
});

Then('the routing test result should not be storage only', () => {
  assert.strictEqual(state.response.body.filter.storageOnly, false);
});

Then('the smtp destination should be active', () => {
  const dest = state.response.body.destinations.find((d) => d.type === 'smtp');
  assert.ok(dest, 'Expected smtp destination in response');
  assert.strictEqual(dest.active, true);
});

Then('the smtp destination should not be active', () => {
  const dest = state.response.body.destinations.find((d) => d.type === 'smtp');
  assert.ok(dest, 'Expected smtp destination in response');
  assert.strictEqual(dest.active, false);
});
