import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate } from '../src/lib/estimate.js';

const tabs = [
  { id: 1, windowId: 1, url: 'https://blog.example/post', title: 'A post', content: { wordCount: 2380 } },
  { id: 2, windowId: 1, url: 'https://github.com/a/b/pull/9', title: 'PR' },
];

test('the local engine handles everything without a key', async () => {
  const result = await estimate(tabs, { engine: 'local' });
  assert.equal(result.engine, 'local');
  assert.equal(result.estimates.length, 2);
  assert.deepEqual(result.warnings, []);
});

test('the Claude engine falls back to local when no key is set', async () => {
  const result = await estimate(tabs, { engine: 'claude', apiKey: '' });
  assert.equal(result.engine, 'local');
  assert.equal(result.estimates.length, 2);
  assert.match(result.warnings[0], /No API key/);
});

test('the Claude engine reports a clear error instead of throwing', async () => {
  const result = await estimate(tabs, {
    engine: 'claude',
    apiKey: 'sk-ant-invalid',
    model: 'claude-opus-5',
  });
  // Without network access this exercises the failure path; with a bad key it
  // exercises the 401 path. Either way the run must still produce estimates.
  assert.equal(result.estimates.length, 2);
  if (result.engine === 'local') {
    assert.match(result.warnings[0], /Claude request failed|No API key/);
  }
});
