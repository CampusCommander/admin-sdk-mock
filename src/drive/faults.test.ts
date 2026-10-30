import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WRITE_SCOPES } from '../auth/scopes.ts';
import { fakeClock } from '../clock.ts';
import { faultTargets } from '../routes.ts';
import {
  googleClient,
  grantToken,
  seedTestDomain,
  startHarness,
} from '../testing/harness.ts';
import { CSV_MIME } from './store.ts';

const SPEC = {
  tier: 'small',
  seed: 'drive-faults',
  counts: { schools: 1, students: 10, staff: 2, devices: 2 },
};
const CONTENT = 'id,name\n1,Ana\n';

async function setup(t: import('node:test').TestContext) {
  const clock = fakeClock();
  const harness = await startHarness({ clock });
  t.after(() => harness.close());
  const domain = seedTestDomain(harness, SPEC);
  const owner = `admin@${domain.spec.primaryDomain}`;
  const token = grantToken(harness, domain, [WRITE_SCOPES.drive[0]], owner);
  const file = harness.mock.drive.create(domain.customerId, {
    name: 'Devices.csv',
    mimeType: CSV_MIME,
    owner,
    content: CONTENT,
  });
  const drive = googleClient(harness, token, 'www.googleapis.com', '/drive/v3');
  const sheets = googleClient(harness, token, 'sheets.googleapis.com');
  const faults = (rule: unknown) =>
    harness.mock.faults.add(domain.customerId, rule);
  return { clock, harness, domain, token, file, drive, sheets, faults };
}

test('the status fault covers the Drive routes', async (t) => {
  const { drive, faults } = await setup(t);
  faults({
    kind: 'status',
    method: 'drive.files.list',
    status: 503,
    reason: 'backendError',
    count: 1,
  });
  faults({
    kind: 'status',
    method: 'drive.files.get',
    status: 403,
    reason: 'forbidden',
    count: 1,
  });
  const first = await drive('GET', '/files');
  assert.equal(first.status, 503);
  assert.equal(first.json().error.message, 'Backend Error');
  assert.equal((await drive('GET', '/files')).status, 200);
  const injected = await drive('GET', '/files/anything');
  assert.equal(injected.status, 403);
  assert.equal(injected.json().error.errors[0].reason, 'forbidden');
  assert.equal((await drive('GET', '/files/anything')).status, 404);
});

test('the status fault covers the Sheets routes', async (t) => {
  const { sheets, faults } = await setup(t);
  faults({
    kind: 'status',
    method: 'sheets.spreadsheets.create',
    status: 429,
    reason: 'RESOURCE_EXHAUSTED',
    count: 1,
  });
  const refused = await sheets('POST', '/v4/spreadsheets', {
    body: { properties: { title: 'x' } },
  });
  assert.equal(refused.status, 429);
  assert.equal(refused.json().error.status, 'RESOURCE_EXHAUSTED');
  assert.equal(
    refused.json().error.message,
    'Injected fault: RESOURCE_EXHAUSTED',
  );
  const created = await sheets('POST', '/v4/spreadsheets', {
    body: { properties: { title: 'x' } },
  });
  assert.equal(created.status, 200);
  assert.equal(
    (await sheets('GET', `/v4/spreadsheets/${created.json().spreadsheetId}`))
      .status,
    200,
  );
});

test('a hang on the media read waits before the file lookup, so a delete during it answers 404', async (t) => {
  const { clock, harness, domain, token, file, drive, faults } = await setup(t);
  faults({
    kind: 'hang',
    method: 'drive.files.get.media',
    ms: 10_000,
    count: 1,
  });

  const held = harness.request({
    host: 'www.googleapis.com',
    path: `/drive/v3/files/${file.id}`,
    token,
    query: { alt: 'media' },
  });
  for (let tries = 0; tries < 200 && clock.pending() === 0; tries++)
    await delay(5);
  assert.equal(clock.pending(), 1);
  assert.equal(harness.mock.drive.remove(domain.customerId, file.id), true);
  await clock.advance(10_000);
  const response = await held;
  assert.equal(response.status, 404);
  assert.equal(response.json().error.errors[0].reason, 'notFound');
  assert.equal((await drive('GET', '/files')).json().files.length, 0);
});

test('the media hang leaves the metadata read of the same path free', async (t) => {
  const { clock, harness, domain, token, file, faults } = await setup(t);
  faults({
    kind: 'hang',
    method: 'drive.files.get.media',
    ms: 10_000,
    count: 1,
  });
  const metadata = await harness.request({
    host: 'www.googleapis.com',
    path: `/drive/v3/files/${file.id}`,
    token,
  });
  assert.equal(metadata.status, 200);
  assert.equal(clock.pending(), 0);
  const media = harness.request({
    host: 'www.googleapis.com',
    path: `/drive/v3/files/${file.id}`,
    token,
    query: { alt: 'media' },
  });
  for (let tries = 0; tries < 200 && clock.pending() === 0; tries++)
    await delay(5);
  await clock.advance(10_000);
  assert.equal((await media).status, 200);
  assert.equal(
    harness.mock.drive.file(domain.customerId, file.id)?.id,
    file.id,
  );
});

test('every Drive and Sheets route is a fault target', async (t) => {
  const { harness } = await setup(t);
  const newRoutes = harness.mock.routes
    .filter((route) => route.api === 'drive' || route.api === 'sheets')
    .map((route) => route.id);
  assert.deepEqual(newRoutes.sort(), [
    'drive.files.get',
    'drive.files.get.media',
    'drive.files.list',
    'sheets.spreadsheets.batchUpdate',
    'sheets.spreadsheets.create',
    'sheets.spreadsheets.get',
    'sheets.spreadsheets.values.get',
    'sheets.spreadsheets.values.update',
  ]);
  assert.deepEqual(
    faultTargets(harness.mock.routes)
      .filter((id) => newRoutes.includes(id))
      .sort(),
    newRoutes,
  );
});

test('a status fault covers each new route, and leaves the route after it', async (t) => {
  const { drive, sheets, file, faults } = await setup(t);
  const created = await sheets('POST', '/v4/spreadsheets', {
    body: { properties: { title: 'Held' } },
  });
  const spreadsheetId = created.json().spreadsheetId as string;
  const routes = [
    {
      id: 'drive.files.list',
      api: 'drive',
      call: () => drive('GET', '/files'),
    },
    {
      id: 'drive.files.get',
      api: 'drive',
      call: () => drive('GET', `/files/${file.id}`),
    },
    {
      id: 'drive.files.get.media',
      api: 'drive',
      call: () =>
        drive('GET', `/files/${file.id}`, { query: { alt: 'media' } }),
    },
    {
      id: 'sheets.spreadsheets.create',
      api: 'sheets',
      call: () =>
        sheets('POST', '/v4/spreadsheets', {
          body: { properties: { title: 'Fault' } },
        }),
    },
    {
      id: 'sheets.spreadsheets.get',
      api: 'sheets',
      call: () => sheets('GET', `/v4/spreadsheets/${spreadsheetId}`),
    },
    {
      id: 'sheets.spreadsheets.batchUpdate',
      api: 'sheets',
      call: () =>
        sheets('POST', `/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
          body: { requests: [] },
        }),
    },
    {
      id: 'sheets.spreadsheets.values.get',
      api: 'sheets',
      call: () => sheets('GET', `/v4/spreadsheets/${spreadsheetId}/values/A1`),
    },
    {
      id: 'sheets.spreadsheets.values.update',
      api: 'sheets',
      call: () =>
        sheets('PUT', `/v4/spreadsheets/${spreadsheetId}/values/A1`, {
          query: { valueInputOption: 'RAW' },
          body: { values: [['a']] },
        }),
    },
  ];
  for (const route of routes) {
    assert.notEqual((await route.call()).status, 500, route.id);
    faults({
      kind: 'status',
      method: route.id,
      status: 500,
      reason: route.api === 'sheets' ? 'INTERNAL' : 'backendError',
      count: 1,
    });
    const injected = await route.call();
    assert.equal(injected.status, 500, route.id);
    if (route.api === 'sheets')
      assert.equal(injected.json().error.status, 'INTERNAL', route.id);
    else
      assert.equal(
        injected.json().error.errors[0].reason,
        'backendError',
        route.id,
      );
    assert.notEqual((await route.call()).status, 500, `${route.id} after it`);
  }
});

test('a hang covers a Sheets route and holds that route alone', async (t) => {
  const { clock, drive, sheets, faults } = await setup(t);
  const created = await sheets('POST', '/v4/spreadsheets', {
    body: { properties: { title: 'Held' } },
  });
  const spreadsheetId = created.json().spreadsheetId as string;
  faults({
    kind: 'hang',
    method: 'sheets.spreadsheets.get',
    ms: 5_000,
    count: 1,
  });
  const held = sheets('GET', `/v4/spreadsheets/${spreadsheetId}`);
  for (let tries = 0; tries < 200 && clock.pending() === 0; tries++)
    await delay(5);
  assert.equal(clock.pending(), 1);
  assert.equal((await drive('GET', '/files')).status, 200);
  await clock.advance(5_000);
  assert.equal((await held).status, 200);
  assert.equal(clock.pending(), 0);
  assert.equal(
    (await sheets('GET', `/v4/spreadsheets/${spreadsheetId}`)).status,
    200,
  );
});
