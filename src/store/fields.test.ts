import assert from 'node:assert/strict';
import test from 'node:test';
import type { Route } from '../http/types.ts';
import { startHarness } from '../testing/harness.ts';
import {
  applyFields,
  FieldsError,
  parseFields,
  unknownField,
} from './fields.ts';

const SAMPLE = {
  kind: 'list',
  nextPageToken: 'abc',
  items: [
    { id: '1', name: { givenName: 'A', familyName: 'B' }, extra: true },
    { id: '2', name: { givenName: 'C', familyName: 'D' }, extra: false },
  ],
};

const pick = (fields: string) => applyFields(SAMPLE, parseFields(fields));

test('top-level, path, and group selections trim the value', () => {
  assert.deepEqual(pick('kind,nextPageToken'), {
    kind: 'list',
    nextPageToken: 'abc',
  });
  assert.deepEqual(pick('items/id'), { items: [{ id: '1' }, { id: '2' }] });
  assert.deepEqual(pick('items(id,name/givenName)'), {
    items: [
      { id: '1', name: { givenName: 'A' } },
      { id: '2', name: { givenName: 'C' } },
    ],
  });
});

test('a wildcard keeps every key at its level', () => {
  assert.deepEqual(pick('items(*)'), { items: SAMPLE.items });
  assert.deepEqual(pick('*'), SAMPLE);
});

test('a whole-field selection wins over a narrower one', () => {
  assert.deepEqual(pick('items/id,items'), { items: SAMPLE.items });
  assert.deepEqual(pick('items,items/id'), { items: SAMPLE.items });
});

test('missing fields are left out', () => {
  assert.deepEqual(pick('missing,kind'), { kind: 'list' });
});

test('a selection is valid when a Google schema declares every name', () => {
  const unknown = (fields: string) => unknownField(parseFields(fields));
  assert.equal(unknown('kind,items/id'), null);
  assert.equal(unknown('*'), null);
  assert.equal(unknown('bogusField'), 'bogusField');
  assert.equal(unknown('chromeosdevices(deviceId,bogus)'), 'bogus');
  assert.equal(
    unknown('chromeosdevices(deviceId,recentUsers),nextPageToken'),
    null,
  );
  assert.equal(unknown('chromeosdevices(deviceId,meid)'), null);
  assert.equal(unknown('users(primaryEmail,thumbnailPhotoUrl)'), null);
  assert.equal(unknown('devices(deviceId,batteryInfo),nextPageToken'), null);
});

test('the Campus Commander device selection is valid for an empty device', () => {
  const fields =
    'nextPageToken,chromeosdevices(deviceId,serialNumber,model,annotatedAssetId,orgUnitPath,lastSync,annotatedLocation,notes,status)';
  assert.equal(unknownField(parseFields(fields)), null);
  assert.deepEqual(
    applyFields(
      { chromeosdevices: [{ deviceId: 'd', serialNumber: 's' }] },
      parseFields(fields),
    ),
    { chromeosdevices: [{ deviceId: 'd', serialNumber: 's' }] },
  );
});

test('malformed selections fail', () => {
  for (const text of ['', 'a,', 'a(b', 'a)', 'a//b', '(a)', 'a(b))'])
    assert.throws(() => parseFields(text), FieldsError, text);
});

test('the mock trims 2xx bodies and rejects bad selections', async (t) => {
  const routes: Route[] = [
    {
      id: 'test.sample',
      api: 'oauth',
      hosts: ['oauth2.googleapis.com'],
      methods: ['GET'],
      pattern: /^\/sample$/,
      scopes: [],
      admin: false,
      handler: () => ({ status: 200, body: SAMPLE }),
    },
  ];
  const harness = await startHarness({ routes });
  t.after(() => harness.close());
  const trimmed = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/sample',
    query: { fields: 'items/id' },
  });
  assert.deepEqual(trimmed.json(), { items: [{ id: '1' }, { id: '2' }] });
  const bad = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/sample',
    query: { fields: 'items(' },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error.errors[0].reason, 'invalidParameter');
  for (const fields of [
    'chromeosdevices(deviceId,recentUsers)',
    'chromeosdevices(deviceId,meid)',
    'users(primaryEmail,thumbnailPhotoUrl)',
    'devices(deviceId,batteryInfo),nextPageToken',
  ])
    assert.equal(
      (
        await harness.request({
          host: 'oauth2.googleapis.com',
          path: '/sample',
          query: { fields },
        })
      ).status,
      200,
      fields,
    );
  const unknown = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/sample',
    query: { fields: 'bogusField' },
  });
  assert.equal(unknown.status, 400);
  assert.equal(
    unknown.json().error.message,
    'Invalid field selection bogusField',
  );
  assert.equal(unknown.json().error.status, 'INVALID_ARGUMENT');
  assert.equal(unknown.json().error.errors[0].location, 'fields');
});
