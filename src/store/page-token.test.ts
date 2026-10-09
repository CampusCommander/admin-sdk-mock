import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePageToken,
  encodePageToken,
  fingerprint,
  PageTokenError,
} from './page-token.ts';

const params = (text: string) => new URLSearchParams(text);

test('a token round-trips its cursor', () => {
  const fp = fingerprint('/x', params('query=a'), 1);
  assert.deepEqual(decodePageToken(encodePageToken(fp, ['b', 2]), fp), [
    'b',
    2,
  ]);
});

test('paging parameters do not change the fingerprint', () => {
  assert.equal(
    fingerprint(
      '/x',
      params('query=a&maxResults=5&pageToken=t&fields=x&prettyPrint=false'),
      1,
    ),
    fingerprint('/x', params('query=a'), 1),
  );
});

test('filters, paths, order, and the seeding time change the fingerprint', () => {
  const base = fingerprint('/x', params('query=a&orderBy=status'), 1);
  assert.notEqual(base, fingerprint('/x', params('query=b&orderBy=status'), 1));
  assert.notEqual(base, fingerprint('/y', params('query=a&orderBy=status'), 1));
  assert.notEqual(base, fingerprint('/x', params('query=a&orderBy=notes'), 1));
  assert.notEqual(base, fingerprint('/x', params('query=a&orderBy=status'), 2));
  assert.equal(base, fingerprint('/x', params('orderBy=status&query=a'), 1));
});

test('a token from another query or a garbled token fails', () => {
  const fp = fingerprint('/x', params('query=a'), 1);
  const other = fingerprint('/x', params('query=b'), 1);
  assert.throws(
    () => decodePageToken(encodePageToken(other, ['b', 2]), fp),
    PageTokenError,
  );
  for (const token of [
    '',
    'garbage',
    Buffer.from('{"f":1}').toString('base64url'),
  ])
    assert.throws(() => decodePageToken(token, fp), PageTokenError);
});
