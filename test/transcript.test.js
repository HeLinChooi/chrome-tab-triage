import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../src/lib/estimator-claude.js';

const exchange = (overrides = {}) => ({
  model: 'claude-opus-5',
  tabCount: 50,
  request: 'x'.repeat(1000),
  response: 'y'.repeat(500),
  usage: { input_tokens: 4000, output_tokens: 1200 },
  stopReason: 'end_turn',
  ms: 2400,
  ...overrides,
});

test('totals add up across requests', () => {
  const t = buildTranscript([exchange(), exchange()]);
  assert.equal(t.requests, 2);
  assert.equal(t.totals.inputTokens, 8000);
  assert.equal(t.totals.outputTokens, 2400);
  assert.equal(t.totals.ms, 4800);
});

test('cost uses the model rate', () => {
  const t = buildTranscript([exchange()]);
  // 4000 in at $5/MTok + 1200 out at $25/MTok
  assert.ok(Math.abs(t.totals.costUsd - (0.004 * 5 + 0.0012 * 25)) < 1e-9);
});

test('an unknown model reports tokens but no dollar figure', () => {
  const t = buildTranscript([exchange({ model: 'some-future-model' })]);
  assert.equal(t.totals.costUsd, null);
  assert.equal(t.totals.inputTokens, 4000);
});

test('the exact system prompt and schema are carried, not a paraphrase', () => {
  const t = buildTranscript([exchange()]);
  assert.match(t.systemPrompt, /baselineMinutes is a rule-based estimate/);
  assert.match(t.systemPrompt, /Do NOT discount for how/);
  assert.equal(t.schema.properties.tabs.items.required.includes('minutes'), true);
});

test('an oversized transcript is truncated rather than stored whole', () => {
  const huge = () => exchange({ request: 'x'.repeat(200000), response: 'y'.repeat(200000) });
  const t = buildTranscript([huge(), huge(), huge()]);
  assert.equal(t.truncated, true);
  assert.ok(t.exchanges.length < 3);
  assert.equal(t.omittedExchanges, 3 - t.exchanges.length);
  // Totals still reflect every request, including the ones not stored.
  assert.equal(t.requests, 3);
  assert.equal(t.totals.inputTokens, 12000);
});

test('a failed run keeps whatever exchanges completed', () => {
  const t = buildTranscript([exchange()], { failure: 'rate limited' });
  assert.equal(t.failure, 'rate limited');
  assert.equal(t.exchanges.length, 1);
});

test('no exchanges is a valid empty transcript, not a crash', () => {
  const t = buildTranscript([]);
  assert.equal(t.requests, 0);
  assert.equal(t.model, null);
  assert.equal(t.totals.costUsd, null);
});
