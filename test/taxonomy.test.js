import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, siteLabel, registrableDomain, isInternalUrl } from '../src/lib/taxonomy.js';

test('registrableDomain handles multi-part TLDs', () => {
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(registrableDomain('news.ycombinator.com'), 'ycombinator.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
});

test('siteLabel keeps meaningful subdomains distinct', () => {
  assert.equal(siteLabel('https://mail.google.com/mail/u/0/#inbox'), 'Gmail');
  assert.equal(siteLabel('https://docs.google.com/document/d/abc'), 'Google Docs');
  assert.equal(siteLabel('https://github.com/foo/bar'), 'GitHub');
  assert.equal(siteLabel('not a url'), 'Other');
});

test('a GitHub pull request is an action, not reference', () => {
  const { type } = classify({ url: 'https://github.com/acme/app/pull/42', title: 'Fix login' });
  assert.equal(type, 'act');
});

test('a GitHub repo root is reference', () => {
  const { type } = classify({ url: 'https://github.com/acme/app', title: 'acme/app' });
  assert.equal(type, 'reference');
});

test('a YouTube watch page is watch, the homepage is not', () => {
  assert.equal(classify({ url: 'https://www.youtube.com/watch?v=x' }).type, 'watch');
  assert.equal(classify({ url: 'https://www.youtube.com/' }).type, 'social');
});

test('page content classifies an unknown domain', () => {
  const long = classify({ url: 'https://blog.unknown.example/post', content: { wordCount: 1200 } });
  assert.equal(long.type, 'read');
  const video = classify({ url: 'https://unknown.example/x', content: { wordCount: 30, videoSeconds: 600 } });
  assert.equal(video.type, 'watch');
});

test('unread-count titles read as pending action', () => {
  assert.equal(classify({ url: 'https://unknown.example/x', title: '(3) Something' }).type, 'act');
});

test('internal pages are recognized', () => {
  assert.ok(isInternalUrl('chrome://extensions'));
  assert.ok(!isInternalUrl('https://example.com'));
});
