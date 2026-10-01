import test from 'node:test';
import assert from 'node:assert/strict';
import { matchLiveTabs } from '../src/lib/match.js';

test('a tab with the same id and URL is matched by id', () => {
  const live = [{ id: 7, url: 'https://a.test/' }];
  const matched = matchLiveTabs([{ id: 7, url: 'https://a.test/' }], live);
  assert.equal(matched.get(7), 7);
});

test('after a browser restart, a tab is found again by its URL', () => {
  // Chrome assigns new tab ids every session, but the dashboard shows the
  // report stored in the previous one.
  const live = [{ id: 501, url: 'https://a.test/' }];
  const matched = matchLiveTabs([{ id: 12, url: 'https://a.test/' }], live);
  assert.equal(matched.get(12), 501);
});

test('an id now held by a different page is not trusted', () => {
  const live = [{ id: 12, url: 'https://other.test/' }];
  const matched = matchLiveTabs([{ id: 12, url: 'https://a.test/' }], live);
  assert.equal(matched.get(12), null);
});

test('two stale copies of one URL match two different live tabs', () => {
  const live = [
    { id: 501, url: 'https://a.test/' },
    { id: 502, url: 'https://a.test/' },
  ];
  const matched = matchLiveTabs(
    [
      { id: 12, url: 'https://a.test/' },
      { id: 13, url: 'https://a.test/' },
    ],
    live,
  );
  assert.deepEqual([matched.get(12), matched.get(13)].sort(), [501, 502]);
});

test('an exact id match is not taken by an earlier URL match', () => {
  const live = [
    { id: 501, url: 'https://a.test/' },
    { id: 13, url: 'https://a.test/' },
  ];
  const matched = matchLiveTabs(
    [
      { id: 12, url: 'https://a.test/' },
      { id: 13, url: 'https://a.test/' },
    ],
    live,
  );
  assert.equal(matched.get(13), 13);
  assert.equal(matched.get(12), 501);
});

test('a tab that was really closed matches nothing', () => {
  const matched = matchLiveTabs([{ id: 12, url: 'https://a.test/' }], []);
  assert.equal(matched.get(12), null);
});
