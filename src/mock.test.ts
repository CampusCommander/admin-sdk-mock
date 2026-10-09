import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, directoryError } from './http/errors.ts';
import type { Route } from './http/types.ts';
import { openPipeline } from './pipeline.ts';
import { startHarness } from './testing/harness.ts';

const events: string[] = [];
const route = (overrides: Partial<Route>): Route => ({
  id: 'test.route',
  api: 'oauth',
  hosts: ['oauth2.googleapis.com'],
  methods: ['GET'],
  pattern: /^\/never$/,
  scopes: [],
  admin: false,
  handler: () => ({ status: 200, body: {} }),
  ...overrides,
});
const routes: Route[] = [
  route({
    id: 'test.echo',
    pattern: /^\/echo\/(?<name>[^/]+)$/,
    handler: (call) => {
      events.push('handler');
      return {
        status: 200,
        body: { name: call.params.name, q: call.request.query.get('q') },
      };
    },
  }),
  route({
    id: 'test.protected',
    api: 'directory',
    hosts: ['admin.googleapis.com'],
    pattern: /^\/protected$/,
  }),
  route({
    id: 'test.conflict',
    pattern: /^\/conflict$/,
    handler: () => {
      throw new ApiError(
        directoryError(409, 'duplicate', 'Entity already exists.'),
      );
    },
  }),
  route({
    id: 'test.crash',
    pattern: /^\/crash$/,
    handler: () => {
      throw new Error('boom');
    },
  }),
];

test('the mock routes requests and shapes responses', async (t) => {
  const harness = await startHarness({ routes });
  t.after(() => harness.close());
  const oauth = 'oauth2.googleapis.com';

  const missing = await harness.request({ host: oauth, path: '/nothing' });
  assert.equal(missing.status, 404);
  assert.match(missing.text, /Error 404 \(Not Found\)/);
  assert.match(String(missing.headers['content-type']), /text\/html/);

  const echo = await harness.request({
    host: oauth,
    path: '/echo/a%20b',
    query: { q: '1' },
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(echo.json(), { name: 'a b', q: '1' });
  assert.match(
    echo.text,
    /\n {2}"name"/,
    'Bodies are pretty-printed by default.',
  );
  const compact = await harness.request({
    host: oauth,
    path: '/echo/x',
    query: { prettyPrint: 'false' },
  });
  assert.equal(compact.text, '{"name":"x","q":null}');

  const wrongHost = await harness.request({
    host: 'www.googleapis.com',
    path: '/echo/x',
  });
  assert.equal(wrongHost.status, 404);

  const unauthenticated = await harness.request({
    host: 'admin.googleapis.com',
    path: '/protected',
  });
  assert.equal(unauthenticated.status, 401);

  const conflict = await harness.request({ host: oauth, path: '/conflict' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().error.errors[0].reason, 'duplicate');

  const logged = t.mock.method(console, 'error', () => {});
  const crash = await harness.request({ host: oauth, path: '/crash' });
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(crash.status, 500);
  assert.equal(crash.json().error.errors[0].reason, 'backendError');
});

test('the pipeline runs before, admit, handler, delay, and release in order', async (t) => {
  const harness = await startHarness({ routes });
  t.after(() => harness.close());
  events.length = 0;
  harness.mock.pipeline = {
    before: async () => {
      events.push('before');
      return undefined;
    },
    admit: () => {
      events.push('admit');
      return { ok: true, release: () => events.push('release') };
    },
    delay: async () => {
      events.push('delay');
    },
  };
  await harness.request({ host: 'oauth2.googleapis.com', path: '/echo/x' });
  assert.deepEqual(events, ['before', 'admit', 'handler', 'delay', 'release']);
});

test('a rejected admission skips the handler', async (t) => {
  const harness = await startHarness({ routes });
  t.after(() => harness.close());
  events.length = 0;
  harness.mock.pipeline = {
    ...openPipeline(),
    admit: () => ({
      ok: false,
      response: directoryError(429, 'rateLimitExceeded', 'Rate Limit Exceeded'),
    }),
  };
  const response = await harness.request({
    host: 'oauth2.googleapis.com',
    path: '/echo/x',
  });
  assert.equal(response.status, 429);
  assert.deepEqual(events, []);
});

test('a reset fault closes the connection without a response', async (t) => {
  const harness = await startHarness({ routes });
  t.after(() => harness.close());
  harness.mock.pipeline = { ...openPipeline(), before: async () => 'reset' };
  await assert.rejects(
    harness.request({ host: 'oauth2.googleapis.com', path: '/echo/x' }),
    /socket hang up|ECONNRESET/,
  );
});
