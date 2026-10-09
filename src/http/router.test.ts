import assert from 'node:assert/strict';
import test from 'node:test';
import { matchRoute } from './router.ts';
import type { ApiRequest, Route } from './types.ts';

const route = (id: string, pattern: RegExp, methods = ['GET']): Route => ({
  id,
  api: 'directory',
  hosts: ['admin.googleapis.com'],
  methods,
  pattern,
  scopes: [],
  admin: false,
  handler: () => ({ status: 200 }),
});

const request = (
  path: string,
  method = 'GET',
  host = 'admin.googleapis.com',
): ApiRequest => ({
  method,
  host,
  path,
  query: new URLSearchParams(),
  headers: {},
  body: '',
});

const routes = [
  route('get', /^\/items\/(?<id>[^/]+)$/),
  route('nested', /^\/tree\/(?<path>.+)$/),
  route('post', /^\/items$/, ['POST']),
];

test('a route matches on host, method, and path, and decodes parameters', () => {
  const match = matchRoute(routes, request('/items/a%20b'));
  assert.equal(match?.route.id, 'get');
  assert.deepEqual(match?.params, { id: 'a b' });
  assert.deepEqual(
    matchRoute(routes, request('/tree/Students/Lincoln%20Elementary'))?.params,
    { path: 'Students/Lincoln Elementary' },
  );
  assert.equal(matchRoute(routes, request('/items', 'POST'))?.route.id, 'post');
});

test('a wrong host, method, or path matches nothing', () => {
  assert.equal(
    matchRoute(routes, request('/items/x', 'GET', 'www.googleapis.com')),
    undefined,
  );
  assert.equal(matchRoute(routes, request('/items', 'GET')), undefined);
  assert.equal(matchRoute(routes, request('/other')), undefined);
});

test('a malformed percent sequence matches nothing', () => {
  assert.equal(matchRoute(routes, request('/items/%E0%A4%A')), undefined);
});
