import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import {
  ConfigError,
  findConfigFile,
  loadConfigFile,
  resolveConfig,
  scopesFor,
} from './config.ts';

const errorsOf = (work: () => unknown): string[] => {
  try {
    work();
  } catch (error) {
    if (error instanceof ConfigError) return error.errors;
    throw error;
  }
  return [];
};

test('an empty input resolves to the CLI defaults', () => {
  const config = resolveConfig({ cwd: '/work' });
  assert.deepEqual(config, {
    dataDir: '/work/data',
    listen: {
      google: { host: '127.0.0.1', port: 8443 },
      control: { host: '127.0.0.1', port: 8080 },
      proxy: null,
    },
    timing: { scale: 1, delays: true },
    caFile: '/work/data/ca/ca.pem',
    readyFile: null,
    defaults: { settings: {} },
    domains: [],
  });
});

test('the file overrides defaults, the environment overrides the file, and flags override both', () => {
  const file = {
    dataDir: './state',
    listen: { google: { port: 9443 }, proxy: { port: 3129 } },
    timing: { scale: 5 },
    domains: [{ spec: { tier: 'small', seed: 'a' } }],
  };
  const fromFile = resolveConfig({ file, fileDir: '/conf', cwd: '/work' });
  assert.equal(fromFile.dataDir, '/conf/state');
  assert.deepEqual(fromFile.listen.google, { host: '127.0.0.1', port: 9443 });
  assert.deepEqual(fromFile.listen.proxy, {
    host: '127.0.0.1',
    port: 3129,
    passthrough: false,
  });
  assert.equal(fromFile.timing.scale, 5);
  assert.deepEqual(fromFile.domains[0], {
    spec: { tier: 'small', seed: 'a' },
    onStart: 'keep',
    settings: {},
    fixtures: null,
    serviceAccounts: [],
    faults: [],
  });
  const fromEnv = resolveConfig({
    file,
    fileDir: '/conf',
    cwd: '/work',
    env: {
      MOCK_GOOGLE_PORT: '7443',
      MOCK_DATA_DIR: 'env-data',
      MOCK_TIME_SCALE: '10',
      MOCK_DELAYS: 'off',
      MOCK_PROXY_PASSTHROUGH: 'true',
    },
  });
  assert.equal(fromEnv.listen.google.port, 7443);
  assert.equal(fromEnv.dataDir, '/work/env-data');
  assert.deepEqual(fromEnv.timing, { scale: 10, delays: false });
  assert.equal(fromEnv.listen.proxy?.passthrough, true);
  const fromFlags = resolveConfig({
    file,
    fileDir: '/conf',
    cwd: '/work',
    env: { MOCK_GOOGLE_PORT: '7443' },
    flags: { googlePort: 6443, dataDir: 'flag-data' },
  });
  assert.equal(fromFlags.listen.google.port, 6443);
  assert.equal(fromFlags.dataDir, '/work/flag-data');
});

test('MOCK_PROXY_PORT alone turns the proxy on', () => {
  const config = resolveConfig({ cwd: '/w', env: { MOCK_PROXY_PORT: '3128' } });
  assert.deepEqual(config.listen.proxy, {
    host: '127.0.0.1',
    port: 3128,
    passthrough: false,
  });
});

test('paths in domains resolve against the configuration file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'config-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'fixtures'));
  writeFileSync(join(dir, 'fixtures', 'b.json'), '{}');
  const config = resolveConfig({
    cwd: '/work',
    fileDir: dir,
    file: {
      domains: [
        {
          spec: { tier: 'small', seed: 'b' },
          fixtures: 'fixtures/b.json',
          serviceAccounts: [{ out: 'keys/b.json', scopes: 'read' }],
        },
      ],
      readyFile: 'ready.json',
      caFile: '/abs/ca.pem',
    },
  });
  assert.equal(config.domains[0].fixtures, join(dir, 'fixtures', 'b.json'));
  assert.equal(
    config.domains[0].serviceAccounts[0].out,
    join(dir, 'keys', 'b.json'),
  );
  assert.equal(config.readyFile, join(dir, 'ready.json'));
  assert.equal(config.caFile, '/abs/ca.pem');
});

test('a fixtures file that does not exist is an error', () => {
  assert.deepEqual(
    errorsOf(() =>
      resolveConfig({
        cwd: '/w',
        fileDir: '/conf',
        file: {
          domains: [
            { spec: { tier: 'small', seed: 'f' }, fixtures: 'missing.json' },
          ],
        },
      }),
    ),
    ['domains[0].fixtures: /conf/missing.json does not exist.'],
  );
});

test('one run reports every error with its JSON path', () => {
  assert.deepEqual(
    errorsOf(() =>
      resolveConfig({
        cwd: '/w',
        file: {
          listen: { google: { port: 70000 } },
          domains: [
            { spec: { teir: 'small', seed: 'x' } },
            { spec: { tier: 'huge', seed: 'y' }, onStart: 'always' },
          ],
        },
      }),
    ),
    [
      'listen.google.port must be at most 65535.',
      'domains[0].spec.tier is required.',
      'domains[0].spec.teir is not an allowed key.',
      'domains[1].spec.tier must be one of: small, medium, large, xlarge, empty.',
      'domains[1].onStart must be one of: keep, reset.',
    ],
  );
});

test('semantic checks run after the schema passes', () => {
  assert.deepEqual(
    errorsOf(() =>
      resolveConfig({
        cwd: '/w',
        file: {
          domains: [
            { spec: { tier: 'small', seed: 'bad seed!' } },
            {
              spec: { tier: 'small', seed: 'ok' },
              settings: { quota: { perMinute: 0 } },
            },
            { spec: { tier: 'small', seed: 'dup' } },
            { spec: { tier: 'small', seed: 'dup' } },
          ],
        },
        env: { MOCK_GOOGLE_PORT: 'eighty' },
      }),
    ),
    [
      'MOCK_GOOGLE_PORT must be a whole number from 0 to 65535.',
      'domains[0].spec: seed must be 1 to 64 letters, digits, hyphens, or underscores.',
      'domains[1].settings: settings.quota.perMinute must be 1 or more.',
      'domains[3].spec names the same domain as domains[2].',
    ],
  );
});

test('invalid environment values, flag values, and default settings are errors', () => {
  assert.deepEqual(
    errorsOf(() =>
      resolveConfig({
        cwd: '/w',
        file: { defaults: { settings: { quota: { ceiling: 0 } } } },
        env: {
          MOCK_TIME_SCALE: '0',
          MOCK_DELAYS: 'sometimes',
          MOCK_PROXY_PASSTHROUGH: 'yes',
        },
        flags: { controlPort: 1.5, scale: 200_000 },
      }),
    ),
    [
      'MOCK_PROXY_PASSTHROUGH must be true, false, 1, or 0.',
      'MOCK_TIME_SCALE: The time scale must be from 1 to 100000.',
      'MOCK_DELAYS: The delay switch must be on or off.',
      '--control-port must be a whole number from 0 to 65535.',
      '--scale: The time scale must be from 1 to 100000.',
      'defaults.settings: settings.quota.ceiling must be 1 or more.',
    ],
  );
});

test('scopesFor expands the scope set words', () => {
  assert.deepEqual(scopesFor('read'), [...READ_SCOPES]);
  assert.deepEqual(scopesFor('read-write'), [...READ_WRITE_SCOPES]);
  assert.deepEqual(scopesFor(['x']), ['x']);
});

test('findConfigFile follows the flag, MOCK_CONFIG, then ./admin-sdk-mock.json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'config-find-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(findConfigFile({ cwd: dir, env: {} }), null);
  writeFileSync(join(dir, 'admin-sdk-mock.json'), '{}');
  assert.equal(
    findConfigFile({ cwd: dir, env: {} }),
    join(dir, 'admin-sdk-mock.json'),
  );
  assert.equal(
    findConfigFile({ cwd: dir, env: { MOCK_CONFIG: 'other.json' } }),
    join(dir, 'other.json'),
  );
  assert.equal(
    findConfigFile({
      cwd: dir,
      env: { MOCK_CONFIG: 'other.json' },
      flag: '/x/y.json',
    }),
    '/x/y.json',
  );
});

test('loadConfigFile reports malformed JSON with the file name', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'config-load-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{ "dataDir": ');
  const errors = errorsOf(() => loadConfigFile(file));
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    new RegExp(
      `^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid JSON`,
    ),
  );
  assert.deepEqual(
    errorsOf(() => loadConfigFile(join(dir, 'missing.json'))),
    [`${join(dir, 'missing.json')} does not exist.`],
  );
});
