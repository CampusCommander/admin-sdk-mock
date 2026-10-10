import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { format, resolveConfig } from 'prettier';
import type { Route } from '../http/types.ts';
import type { Mock } from '../mock.ts';
import { buildRoutes } from '../routes.ts';
import { packageRoot } from '../version.ts';
import {
  generatedSections,
  renderApiCoverage,
  renderCliReference,
  renderConfigReference,
  replaceGenerated,
  routePath,
} from './generate.ts';

test('renderConfigReference emits one row per key path, through $ref, anyOf, and arrays', () => {
  const schema = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        default: './data',
        description: 'A | B in <dir>.',
      },
      port: { type: 'integer', minimum: 0, maximum: 65535 },
      size: { type: 'number', minimum: 1 },
      mode: { enum: ['keep', 'reset'], default: 'keep' },
      anything: {},
      tags: { type: 'array' },
      proxy: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            properties: { open: { type: 'boolean', default: false } },
          },
        ],
        default: null,
      },
      items: {
        type: 'array',
        default: [],
        items: { $ref: '#/$defs/item' },
      },
      at: { $ref: '#/$defs/item', description: 'Own words.' },
    },
    $defs: {
      item: {
        type: 'object',
        required: ['id'],
        description: 'An item.',
        properties: {
          id: { type: 'string' },
          scopes: {
            anyOf: [
              { enum: ['read', 'read-write'] },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
    },
  };
  assert.equal(
    renderConfigReference(schema),
    [
      '| Key | Type | Default | Description |',
      '| --- | --- | --- | --- |',
      '| `name` | string | `./data` | A \\| B in \\<dir>. |',
      '| `port` | integer 0–65535 | none |  |',
      '| `size` | number | none |  |',
      '| `mode` | one of: keep, reset | `keep` |  |',
      '| `anything` | any | none |  |',
      '| `tags` | array of any | none |  |',
      '| `proxy` | null or object | `null` |  |',
      '| `proxy.open` | boolean | `false` |  |',
      '| `items` | array of object | `[]` |  |',
      '| `items[].id` | string | required |  |',
      '| `items[].scopes` | one of: read, read-write or array of string | none |  |',
      '| `at` | object | none | Own words. |',
      '| `at.id` | string | required |  |',
      '| `at.scopes` | one of: read, read-write or array of string | none |  |',
    ].join('\n'),
  );
});

test('renderCliReference puts the top-level usage first, then one section per command', () => {
  assert.equal(
    renderCliReference({
      start: 'Usage: tool start',
      '': 'Usage: tool <command>',
      env: 'Usage: tool env',
    }),
    [
      '## admin-sdk-mock',
      '',
      '```text',
      'Usage: tool <command>',
      '```',
      '',
      '## start',
      '',
      '```text',
      'Usage: tool start',
      '```',
      '',
      '## env',
      '',
      '```text',
      'Usage: tool env',
      '```',
    ].join('\n'),
  );
});

test('routePath shows named groups as {name} and keeps the readable form of other groups', () => {
  assert.equal(
    routePath(/^\/admin\/directory\/v1\/users\/(?<userKey>[^/]+)$/),
    '/admin/directory/v1/users/{userKey}',
  );
  assert.equal(
    routePath(
      /^\/admin\/directory\/v1\/customer\/(?<customerId>[^/]+)\/devices\/chromeos\/(?<deviceId>[^/:]+?)(?::|%3[Aa])issueCommand$/,
    ),
    '/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}:issueCommand',
  );
  assert.equal(
    routePath(/^\/batch(?:\/admin\/directory_v1)?$/),
    '/batch[/admin/directory_v1]',
  );
  assert.equal(routePath(/^\/a\.b$/), '/a.b');
});

test('routePath throws when regex syntax would remain in the path', () => {
  for (const pattern of [
    /^\/a\/[a-z]+$/,
    /^\/a(b)$/,
    /^\/a\d$/,
    /^\/a(?<id>(x))$/,
    /^\/a(?:b(?:c)?)$/,
    /^\/a.*$/,
  ])
    assert.throws(
      () => routePath(pattern),
      /cannot render the route pattern/,
      pattern.source,
    );
});

test('renderApiCoverage emits one row per route, sorted by route ID, with its scopes', () => {
  const route = (
    id: string,
    methods: string[],
    hosts: string[],
    pattern: RegExp,
    scopes: string[],
    admin: boolean,
  ) =>
    ({ id, methods, hosts, pattern, scopes, admin }) as Pick<
      Route,
      'id' | 'methods' | 'hosts' | 'pattern' | 'scopes' | 'admin'
    >;
  const auth = 'https://www.googleapis.com/auth/';
  assert.equal(
    renderApiCoverage([
      route(
        'oauth.token',
        ['POST'],
        ['oauth2.googleapis.com'],
        /^\/token$/,
        [],
        false,
      ),
      route(
        'directory.members.list',
        ['GET'],
        ['admin.googleapis.com'],
        /^\/members$/,
        [`${auth}admin.directory.group`, `${auth}admin.directory.group.member`],
        true,
      ),
      route(
        'batch.directory',
        ['POST'],
        ['www.googleapis.com', 'admin.googleapis.com'],
        /^\/batch$/,
        ['https://example.test/other-scope'],
        false,
      ),
    ]),
    [
      '| Route | Methods | Hosts | Path | Scopes | Super admin |',
      '| --- | --- | --- | --- | --- | --- |',
      '| `batch.directory` | POST | `www.googleapis.com`, `admin.googleapis.com` | `/batch` | `https://example.test/other-scope` | no |',
      '| `directory.members.list` | GET | `admin.googleapis.com` | `/members` | `admin.directory.group`, `admin.directory.group.member` | yes |',
      '| `oauth.token` | POST | `oauth2.googleapis.com` | `/token` | none | no |',
    ].join('\n'),
  );
});

test('replaceGenerated replaces the text between the named markers', () => {
  const page = [
    'Intro.',
    '<!-- generated:start x -->',
    'old',
    '<!-- generated:end x -->',
    'Outro.',
  ].join('\n');
  assert.equal(
    replaceGenerated(page, 'x', '\nnew\n'),
    [
      'Intro.',
      '<!-- generated:start x -->',
      '',
      'new',
      '',
      '<!-- generated:end x -->',
      'Outro.',
    ].join('\n'),
  );
  assert.throws(
    () => replaceGenerated(page, 'y', 'new'),
    /no generated:start y and generated:end y markers/,
  );
  assert.throws(
    () => replaceGenerated('<!-- generated:start x -->', 'x', 'new'),
    /no generated:start x and generated:end x markers/,
  );
  assert.throws(
    () =>
      replaceGenerated(
        '<!-- generated:end x -->\n<!-- generated:start x -->',
        'x',
        'new',
      ),
    /no generated:start x and generated:end x markers/,
  );
});

test('every generated reference matches its source', async () => {
  const sections = generatedSections();
  assert.deepEqual(
    sections.map(({ file, name }) => [file, name]),
    [
      ['docs/reference/configuration.md', 'configuration'],
      ['docs/reference/cli.md', 'cli'],
      ['docs/reference/api-coverage.md', 'api-coverage'],
    ],
  );
  for (const { file, name, content } of sections) {
    const path = join(packageRoot(), file);
    const page = readFileSync(path, 'utf8');
    const expected = await format(replaceGenerated(page, name, content), {
      ...(await resolveConfig(path)),
      filepath: path,
    });
    assert.equal(page, expected, `${file} is out of date. Run npm run docs.`);
  }
});

test('the API coverage table names every route', () => {
  const page = readFileSync(
    join(packageRoot(), 'docs/reference/api-coverage.md'),
    'utf8',
  );
  const table = page.slice(
    page.indexOf('<!-- generated:start api-coverage -->'),
    page.indexOf('<!-- generated:end api-coverage -->'),
  );
  const rows = new Set(
    [...table.matchAll(/^\| `([^`]+)` +\|/gm)].map((match) => match[1]),
  );
  // buildRoutes reads the mock only inside route handlers, and this test calls none.
  for (const { id } of buildRoutes(undefined as unknown as Mock))
    assert.ok(rows.has(id), `${id} is missing from the API coverage table.`);
});
