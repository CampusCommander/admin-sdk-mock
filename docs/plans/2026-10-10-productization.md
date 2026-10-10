# Admin SDK Mock Productization (v1.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mock installable and configurable anywhere the Google Admin SDK, Chrome Management telemetry, and Google OAuth service-account APIs need testing, with documentation and tests that prove it.

**Architecture:** One configuration model (a JSON file described by a JSON Schema that is also the validator's source) feeds one startup module, `startServer()`. The CLI, the Docker image entry point, and the programmatic `startMock()` API all call it. A built-in CONNECT proxy tunnels the four Google hostnames to the Google listener, so any client that honors `HTTPS_PROXY` and a CA bundle reaches the mock without root, hosts files, or port 443. The package ships compiled JavaScript in `dist/` because Node refuses to type-strip files inside `node_modules`.

**Tech Stack:** Node 24 (type stripping in development, `node:test`, `node:sqlite`, `tls.setDefaultCACertificates`), TypeScript 6 (`tsc` emit with `rewriteRelativeImportExtensions` for the package), ESLint, Prettier, Docker, GitHub Actions, Python 3 with `google-api-python-client` (CI and examples only).

**Spec:** `docs/specs/2026-10-10-productization-design.md`. Its parents are `docs/specs/2026-10-09-admin-sdk-mock-design.md` and the milestone specs. Read the productization spec before any task.

## Global Constraints

- Repository: `~/projects/admin-sdk-mock`. Never add files to `~/projects/campus-commander`.
- Node runs `.ts` files directly in development. Never use `enum`, `namespace`, parameter properties, decorators, or `import x = require()`.
- Relative imports end in `.ts`. Type-only imports use `import type`.
- Add no runtime dependency. Add no development dependency. Examples and the package test may install packages into their own temporary directories or virtual environments only.
- Package name `@campuscommander/admin-sdk-mock`, version `1.0.0`, `private: true`, `license: "UNLICENSED"`, `engines.node: ">=24.11"`, ESM only.
- Executables: `admin-sdk-mock` and `mockctl`.
- Configuration precedence, highest first: command-line flags, environment variables, the configuration file, the defaults.
- CLI defaults: data directory `./data`, Google listener `127.0.0.1:8443`, control listener `127.0.0.1:8080`, no proxy. Proxy `passthrough` defaults to false in files and to true in `startMock()`.
- The image sets `MOCK_DATA_DIR=/data`, `MOCK_GOOGLE_PORT=443`, and `MOCK_GOOGLE_HOST`, `MOCK_CONTROL_HOST`, `MOCK_PROXY_HOST` to `0.0.0.0`.
- Exit codes: 0 success, 1 runtime failure, 2 invalid usage or configuration.
- Key files are written with mode 0600. Logs never print private keys.
- The proxy never terminates TLS. It tunnels port 443 of `oauth2.googleapis.com`, `admin.googleapis.com`, `www.googleapis.com`, and `chromemanagement.googleapis.com` to the Google listener, answers `403` to other targets unless `passthrough` is on, and answers `405` to any request that is not `CONNECT`.
- Existing behavior stays: every milestone 1–3 route, the control API guards, `bin/mockctl.ts` commands, the Campus Commander overlay, and every existing test.
- Documentation prose follows the repository writing rules: active voice, no hedging words, no semicolons, no contractions, at most 20 words per instruction sentence.
- Every commit message ends with a `Co-Authored-By` trailer that names the model that wrote the commit.
- Every task ends with `npm test`, `npm run lint`, `npm run typecheck`, and `npm run format:check` passing.

## Review Focus

- A configuration file with a typo in a nested key (for example `domains[0].spec.teir`) must fail before any listener starts, naming the full JSON path. Task 2 pins this.
- Restarting `start` with the same configuration must reuse domains and service-account key files, so client credentials stay valid across restarts. Task 5 pins this.
- A client that sends a non-Google `CONNECT` through the proxy with `passthrough` off must get `403` and leave the mock healthy. Task 3 pins this.
- Two `startMock()` handles in one process must not leak the in-process CA or `HTTPS_PROXY` after both close. Task 7 pins this.
- A fixtures file that names a member group before defining it, or that creates a cycle, must fail with the file and JSON path. Task 4 pins this.

## File Map

| Path | Responsibility | Task |
| --- | --- | --- |
| `tsconfig.build.json`, `package.json`, `.gitignore`, `src/version.ts`, `src/index.ts` (first cut) | Build, package metadata, version | 1 |
| `schema/config.schema.json`, `src/config/json-schema.ts`, `src/config/config.ts` | Configuration schema, validator, resolution | 2 |
| `src/proxy.ts`, `test/compat/run.ts` | CONNECT proxy | 3 |
| `src/seed/spec.ts`, `src/seed/seed.ts`, `src/seed/fixtures.ts`, `src/domains.ts` | `empty` tier and fixtures | 4 |
| `src/server.ts`, `src/startup/ensure-domains.ts`, `src/control/control.ts`, `src/main.ts` | Startup orchestration, `GET /info`, `POST /domains/{id}/tokens` | 5 |
| `src/cli/*.ts`, `bin/admin-sdk-mock.ts`, `bin/mockctl.ts` | The CLI | 6 |
| `src/index.ts` | `startMock()` and `useInProcess()` | 7 |
| `Dockerfile`, `compose/standalone.yml`, `scripts/image-smoke.sh` | Image and Compose | 8 |
| `examples/**`, `test/examples/run.ts`, `test/python/run.ts` | Examples and their runners | 9 |
| `test/package/run.ts` | Package install test | 10 |
| `action.yml`, `examples/github-actions/**` | GitHub Action | 11 |
| `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `package.json` (coverage gate) | CI, release, coverage | 12 |
| `README.md`, `docs/guide/*.md`, `docs/reference/*.md`, `docs/trust.md`, `src/docs/generate.ts`, `scripts/docs.ts`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE.md` | Documentation | 13 |

## Execution Lanes

- Wave 1, in parallel: Task 1, Task 3, and the lane Task 2 then Task 4 (Task 4 uses Task 2's validator).
- Wave 2: Task 5.
- Wave 3, in parallel: Tasks 6, 7, 8.
- Wave 4, in parallel: Tasks 9, 10, 11, 12.
- Wave 5: Task 13.

Task 1 adds every npm script name the later tasks need, so later tasks do not edit `package.json` scripts except Task 12's coverage thresholds.

---

### Task 1: Build and package metadata

**Files:**

- Create: `tsconfig.build.json`, `src/version.ts`, `src/version.test.ts`, `src/index.ts`
- Modify: `package.json`, `.gitignore`, `.prettierignore`, `eslint.config.js`

**Interfaces:**

- Produces:
  - `npm run build` writes `dist/` (compiled `src/` and `bin/`, with `.d.ts` files, without tests or `src/testing/`).
  - `packageRoot(): string` (absolute path of the directory holding this package's `package.json`) and `VERSION: string` in `src/version.ts`.
  - `src/index.ts` exports `VERSION`, `READ_SCOPES`, `READ_WRITE_SCOPES`. Task 7 extends it.
  - npm scripts: `build`, `prepare`, `test`, `test:contract`, `test:compat`, `test:scale`, `test:coverage`, `test:examples`, `test:python`, `test:package`, `docs`, `lint`, `typecheck`, `format`, `format:check`, `start`, `parity`.

- [ ] **Step 1: Write the failing test**

Create `src/version.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { packageRoot, VERSION } from './version.ts';

test('packageRoot finds this package and VERSION matches its package.json', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, '@campuscommander/admin-sdk-mock');
  assert.equal(VERSION, manifest.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/version.test.ts`
Expected: FAIL with a module-not-found error for `./version.ts`.

- [ ] **Step 3: Add the version module and the first package entry**

Create `src/version.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@campuscommander/admin-sdk-mock';

/**
 * The directory that holds this package's package.json. It works from `src/`
 * in development and from `dist/src/` in an installed package.
 */
export function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (manifest.name === NAME) return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find the ${NAME} package.json.`);
    directory = parent;
  }
}

export const VERSION: string = (
  JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version: string }
).version;
```

Create `src/index.ts`:

```ts
/** The programmatic API of the Admin SDK mock. Task 7 adds startMock(). */
export { VERSION } from './version.ts';
export { READ_SCOPES, READ_WRITE_SCOPES } from './auth/scopes.ts';
```

- [ ] **Step 4: Update the package metadata**

Replace the identity and script fields of `package.json` so they read exactly as below. Keep `devDependencies` and `dependencies` unchanged.

```json
{
  "name": "@campuscommander/admin-sdk-mock",
  "version": "1.0.0",
  "private": true,
  "license": "UNLICENSED",
  "description": "A local mock of the Google Admin SDK Directory API, Chrome Management telemetry, and Google OAuth for testing",
  "type": "module",
  "engines": { "node": ">=24.11" },
  "bin": {
    "admin-sdk-mock": "./dist/bin/admin-sdk-mock.js",
    "mockctl": "./dist/bin/mockctl.js"
  },
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    },
    "./config.schema.json": "./schema/config.schema.json",
    "./package.json": "./package.json"
  },
  "files": ["dist/", "schema/", "README.md", "CHANGELOG.md", "LICENSE.md"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "prepare": "npm run build",
    "start": "node src/main.ts",
    "test": "node --test \"src/**/*.test.ts\" \"parity/**/*.test.ts\"",
    "test:contract": "node --test \"test/contract/*.test.ts\"",
    "test:compat": "node test/compat/run.ts",
    "test:scale": "node test/scale/scale.ts",
    "test:coverage": "node --test --experimental-test-coverage --test-coverage-exclude=\"**/*.test.ts\" --test-coverage-exclude=\"src/testing/**\" --test-coverage-exclude=\"parity/**\" \"src/**/*.test.ts\"",
    "test:examples": "npm run build && node test/examples/run.ts",
    "test:python": "node test/python/run.ts",
    "test:package": "node test/package/run.ts",
    "docs": "node scripts/docs.ts",
    "parity": "node parity/live.ts",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

`bin/admin-sdk-mock.ts` does not exist until Task 6. `npm install` tolerates a missing bin target. Task 6 creates it.

Create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "rewriteRelativeImportExtensions": true,
    "sourceMap": false
  },
  "include": ["src", "bin"],
  "exclude": ["src/**/*.test.ts", "src/testing"]
}
```

Add `dist/` to `.gitignore`, `.prettierignore`, and the `ignores` list in `eslint.config.js`.

- [ ] **Step 5: Verify the build and the tests**

Run: `npm run build && node -e "import('./dist/src/index.js').then((m) => console.log(m.VERSION))"`
Expected: prints `1.0.0`. `dist/src/index.d.ts` exists. `dist/src/version.js` imports `./` paths ending in `.js`.

If `tsc` rejects `allowImportingTsExtensions` while emitting, add `"allowImportingTsExtensions": false` to `tsconfig.build.json`'s compiler options and confirm the build. Report which form worked.

Run: `node --test src/version.test.ts && npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build: package the mock as @campuscommander/admin-sdk-mock 1.0.0 with a dist build"
```

---

### Task 2: Configuration schema, validator, and resolution

**Files:**

- Create: `schema/config.schema.json`
- Create: `src/config/json-schema.ts`, `src/config/json-schema.test.ts`
- Create: `src/config/config.ts`, `src/config/config.test.ts`

**Interfaces:**

- Consumes: `resolveSpec()`, `SpecError` (`src/seed/spec.ts`), `parseTiming()` (`src/clock.ts`), `mergeSettings()`, `DEFAULT_SETTINGS`, `SettingsError` (`src/settings.ts`), `validateFault` if exported by `src/faults/faults.ts` (otherwise faults are validated by Task 5 when added), `packageRoot()` (Task 1).
- Produces:
  - `validateSchema(schema, value): string[]` in `src/config/json-schema.ts`. Each string is one error, starting with the JSON path.
  - In `src/config/config.ts`:
    - types `ListenAddress { host: string; port: number }`, `ProxyListen extends ListenAddress { passthrough: boolean }`, `ServiceAccountEntry { out: string; scopes: 'read' | 'read-write' | string[]; projectId?: string }`, `DomainEntry { spec: Record<string, unknown>; onStart: 'keep' | 'reset'; settings: Record<string, unknown>; fixtures: string | null; serviceAccounts: ServiceAccountEntry[]; faults: unknown[] }`, `MockConfig { dataDir: string; listen: { google: ListenAddress; control: ListenAddress; proxy: ProxyListen | null }; timing: { scale: number; delays: boolean }; caFile: string; readyFile: string | null; defaults: { settings: Record<string, unknown> }; domains: DomainEntry[] }`.
    - `class ConfigError extends Error { readonly errors: string[] }`.
    - `loadConfigFile(path: string): unknown` (parse JSON; a parse failure is a `ConfigError` naming the file and the position).
    - `resolveConfig(input: { file?: unknown; fileDir?: string; env?: NodeJS.ProcessEnv; flags?: ConfigFlags; cwd?: string }): MockConfig`. It validates, applies defaults and precedence, and resolves every path to an absolute path. Paths in the file resolve against `fileDir`. Paths from flags and the environment resolve against `cwd`.
    - `type ConfigFlags = { dataDir?: string; googleHost?: string; googlePort?: number; controlHost?: string; controlPort?: number; proxyHost?: string; proxyPort?: number; passthrough?: boolean; scale?: number; delays?: boolean; caFile?: string; readyFile?: string }`.
    - `findConfigFile(input: { flag?: string; env?: NodeJS.ProcessEnv; cwd: string }): string | null` (the spec's lookup order).
    - `CONFIG_SCHEMA: Record<string, unknown>` (the parsed `schema/config.schema.json`).
    - `scopesFor(scopes: ServiceAccountEntry['scopes']): string[]` (`read` → `READ_SCOPES`, `read-write` → `READ_WRITE_SCOPES`, a list → itself).

- [ ] **Step 1: Write the schema**

Create `schema/config.schema.json`. It is JSON Schema draft 2020-12, and the validator in Step 3 supports exactly the keywords used here: `type`, `properties`, `required`, `additionalProperties: false`, `enum`, `minimum`, `maximum`, `items`, `anyOf`, `description`, `default`, `$schema`, `$id`, `title`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/CampusCommander/admin-sdk-mock/schema/config.schema.json",
  "title": "Admin SDK mock configuration",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string", "description": "An editor hint. The mock ignores it." },
    "dataDir": { "type": "string", "description": "The data directory. Relative paths resolve against the configuration file.", "default": "./data" },
    "listen": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "google": { "$ref": "#/$defs/address", "description": "The TLS listener for the Google hostnames.", "default": { "host": "127.0.0.1", "port": 8443 } },
        "control": { "$ref": "#/$defs/address", "description": "The plain HTTP control listener.", "default": { "host": "127.0.0.1", "port": 8080 } },
        "proxy": {
          "anyOf": [
            { "type": "null" },
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "host": { "type": "string", "default": "127.0.0.1" },
                "port": { "type": "integer", "minimum": 0, "maximum": 65535, "default": 3128 },
                "passthrough": { "type": "boolean", "default": false, "description": "Tunnel targets other than the Google hostnames instead of refusing them." }
              }
            }
          ],
          "description": "The CONNECT proxy. null turns it off.",
          "default": null
        }
      }
    },
    "timing": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "scale": { "type": "number", "minimum": 1, "maximum": 100000, "default": 1, "description": "Divides every quota window, delay, and timeline." },
        "delays": { "type": "boolean", "default": true, "description": "Whether modeled latency applies." }
      }
    },
    "caFile": { "type": "string", "description": "Where to write the CA certificate. The default is <dataDir>/ca/ca.pem." },
    "readyFile": { "type": "string", "description": "A file written with the started event once every domain is ready." },
    "defaults": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "settings": { "type": "object", "description": "A settings patch applied to every configured domain before its own settings.", "default": {} }
      }
    },
    "domains": { "type": "array", "items": { "$ref": "#/$defs/domain" }, "default": [] }
  },
  "$defs": {
    "address": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "host": { "type": "string" },
        "port": { "type": "integer", "minimum": 0, "maximum": 65535 }
      }
    },
    "domain": {
      "type": "object",
      "additionalProperties": false,
      "required": ["spec"],
      "properties": {
        "spec": {
          "type": "object",
          "additionalProperties": false,
          "required": ["tier", "seed"],
          "properties": {
            "tier": { "enum": ["small", "medium", "large", "xlarge", "empty"] },
            "seed": { "type": "string" },
            "name": { "type": "string" },
            "layout": { "enum": ["role-first", "school-first"] },
            "counts": { "type": "object" },
            "rates": { "type": "object" }
          },
          "description": "The seed specification. The same specification always yields the same data."
        },
        "onStart": { "enum": ["keep", "reset"], "default": "keep" },
        "settings": { "type": "object", "default": {} },
        "fixtures": { "type": "string", "description": "A fixtures file, relative to the configuration file." },
        "serviceAccounts": {
          "type": "array",
          "default": [],
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["out", "scopes"],
            "properties": {
              "out": { "type": "string", "description": "Where to write the key file, with mode 0600." },
              "scopes": {
                "anyOf": [
                  { "enum": ["read", "read-write"] },
                  { "type": "array", "items": { "type": "string" } }
                ]
              },
              "projectId": { "type": "string" }
            }
          }
        },
        "faults": { "type": "array", "items": { "type": "object" }, "default": [] }
      }
    }
  }
}
```

The validator also supports `$ref` to `#/$defs/<name>`. Add `$ref` to the keyword list above.

- [ ] **Step 2: Write the failing validator and resolution tests**

Create `src/config/json-schema.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSchema } from './json-schema.ts';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string' },
    port: { type: 'integer', minimum: 0, maximum: 10 },
    mode: { enum: ['a', 'b'] },
    list: { type: 'array', items: { $ref: '#/$defs/item' } },
    either: { anyOf: [{ type: 'null' }, { type: 'boolean' }] },
  },
  $defs: { item: { type: 'object', additionalProperties: false, properties: { id: { type: 'number' } } } },
};

test('a valid value has no errors', () => {
  assert.deepEqual(validateSchema(schema, { name: 'x', port: 3, mode: 'a', list: [{ id: 1 }], either: null }), []);
});

test('every error names its JSON path', () => {
  assert.deepEqual(
    validateSchema(schema, { port: 3.5, mode: 'c', list: [{ id: 'z', extra: 1 }], either: 3, unknown: true }),
    [
      'name is required.',
      'port must be an integer.',
      'mode must be one of: a, b.',
      'list[0].id must be a number.',
      'list[0].extra is not an allowed key.',
      'either must match one of the allowed forms.',
      'unknown is not an allowed key.',
    ],
  );
  assert.deepEqual(validateSchema(schema, { name: 'x', port: 11 }), ['port must be at most 10.']);
  assert.deepEqual(validateSchema(schema, 'text'), ['The configuration must be an object.']);
});
```

Create `src/config/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { READ_SCOPES, READ_WRITE_SCOPES } from '../auth/scopes.ts';
import { ConfigError, findConfigFile, loadConfigFile, resolveConfig, scopesFor } from './config.ts';

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
  assert.deepEqual(fromFile.listen.proxy, { host: '127.0.0.1', port: 3129, passthrough: false });
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
    env: { MOCK_GOOGLE_PORT: '7443', MOCK_DATA_DIR: 'env-data', MOCK_TIME_SCALE: '10', MOCK_DELAYS: 'off', MOCK_PROXY_PASSTHROUGH: 'true' },
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
  assert.deepEqual(config.listen.proxy, { host: '127.0.0.1', port: 3128, passthrough: false });
});

test('paths in domains resolve against the configuration file', () => {
  const config = resolveConfig({
    cwd: '/work',
    fileDir: '/conf',
    file: {
      domains: [
        {
          spec: { tier: 'empty', seed: 'b' },
          fixtures: 'fixtures/b.json',
          serviceAccounts: [{ out: 'keys/b.json', scopes: 'read' }],
        },
      ],
      readyFile: 'ready.json',
      caFile: '/abs/ca.pem',
    },
  });
  assert.equal(config.domains[0].fixtures, '/conf/fixtures/b.json');
  assert.equal(config.domains[0].serviceAccounts[0].out, '/conf/keys/b.json');
  assert.equal(config.readyFile, '/conf/ready.json');
  assert.equal(config.caFile, '/abs/ca.pem');
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
            { spec: { tier: 'small', seed: 'ok' }, settings: { quota: { perMinute: 0 } } },
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
  assert.equal(findConfigFile({ cwd: dir, env: {} }), join(dir, 'admin-sdk-mock.json'));
  assert.equal(findConfigFile({ cwd: dir, env: { MOCK_CONFIG: 'other.json' } }), join(dir, 'other.json'));
  assert.equal(findConfigFile({ cwd: dir, env: { MOCK_CONFIG: 'other.json' }, flag: '/x/y.json' }), '/x/y.json');
});

test('loadConfigFile reports malformed JSON with the file name', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'config-load-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'bad.json');
  writeFileSync(file, '{ "dataDir": ');
  const errors = errorsOf(() => loadConfigFile(file));
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid JSON`));
  assert.deepEqual(errorsOf(() => loadConfigFile(join(dir, 'missing.json'))), [`${join(dir, 'missing.json')} does not exist.`]);
});
```

`resolveSpec()`'s seed error text must be checked against `src/seed/spec.ts` before relying on the expected strings above. Adjust only the copied message text if the existing wording differs, and say so in the report.
Add one more test: a `domains[i].fixtures` path that does not exist yields `domains[i].fixtures: <absolute path> does not exist.` Task 4 parses fixtures, so this task only checks existence.

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test src/config/json-schema.test.ts src/config/config.test.ts`
Expected: FAIL with module-not-found errors.

- [ ] **Step 4: Write the validator**

Create `src/config/json-schema.ts`:

```ts
type Schema = Record<string, unknown>;

const describe = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const child = (path: string, key: string | number): string =>
  typeof key === 'number' ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`;

const TYPE_TEST: Readonly<Record<string, (value: unknown) => boolean>> = {
  object: isObject,
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
};

const ARTICLE: Readonly<Record<string, string>> = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  boolean: 'true or false',
  null: 'null',
  number: 'a number',
  integer: 'an integer',
};

/**
 * Validate a value against the JSON Schema subset that schema/config.schema.json uses:
 * type, properties, required, additionalProperties false, enum, minimum, maximum,
 * items, anyOf, and $ref to #/$defs. Errors come in document order, each naming its path.
 */
export function validateSchema(root: Schema, value: unknown): string[] {
  const errors: string[] = [];
  const resolve = (schema: Schema): Schema => {
    const ref = schema.$ref;
    if (typeof ref !== 'string') return schema;
    const name = ref.replace(/^#\/\$defs\//, '');
    const target = (root.$defs as Record<string, Schema> | undefined)?.[name];
    if (!target) throw new Error(`Unknown schema reference ${ref}.`);
    return { ...target, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) };
  };
  const check = (raw: Schema, input: unknown, path: string, out: string[]): void => {
    const schema = resolve(raw);
    const label = path === '' ? 'The configuration' : path;
    if (Array.isArray(schema.anyOf)) {
      const matches = (schema.anyOf as Schema[]).some((option) => {
        const trial: string[] = [];
        check(option, input, path, trial);
        return trial.length === 0;
      });
      if (!matches) out.push(`${label} must match one of the allowed forms.`);
      return;
    }
    if (Array.isArray(schema.enum)) {
      if (!(schema.enum as unknown[]).includes(input))
        out.push(`${label} must be one of: ${(schema.enum as unknown[]).join(', ')}.`);
      return;
    }
    const type = schema.type as string | undefined;
    if (type && !TYPE_TEST[type](input)) {
      out.push(`${label} must be ${ARTICLE[type]}.`);
      return;
    }
    if (typeof input === 'number') {
      if (typeof schema.minimum === 'number' && input < schema.minimum)
        out.push(`${label} must be at least ${schema.minimum}.`);
      if (typeof schema.maximum === 'number' && input > schema.maximum)
        out.push(`${label} must be at most ${schema.maximum}.`);
    }
    if (Array.isArray(input) && isObject(schema.items))
      input.forEach((item, index) => check(schema.items as Schema, item, child(path, index), out));
    if (isObject(input)) {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[])
        if (!Object.hasOwn(input, key)) out.push(`${child(path, key)} is required.`);
      for (const [key, inner] of Object.entries(input)) {
        if (Object.hasOwn(properties, key)) check(properties[key], inner, child(path, key), out);
        else if (schema.additionalProperties === false)
          out.push(`${child(path, key)} is not an allowed key.`);
      }
    }
  };
  check(root, value, '', errors);
  return errors;
}

export { describe };
```

Remove the `describe` helper and its export if lint reports it unused. The tests expect the `required` errors of an object before its key errors, which this order gives.

- [ ] **Step 5: Write the configuration module**

Create `src/config/config.ts` with these parts, in this order:

1. Load `CONFIG_SCHEMA` from `join(packageRoot(), 'schema', 'config.schema.json')` at module load.
2. `class ConfigError extends Error` with `readonly errors: string[]`. Its message joins the errors with newlines.
3. `loadConfigFile(path)`: `existsSync` false → `ConfigError([`${path} does not exist.`])`. `JSON.parse` failure → `ConfigError([`${path} is not valid JSON: ${error.message}`])`.
4. `findConfigFile({ flag, env, cwd })`: return `resolve(cwd, flag)` when given, then `resolve(cwd, env.MOCK_CONFIG)`, then `join(cwd, 'admin-sdk-mock.json')` if it exists, else `null`.
5. `resolveConfig(input)`:
   - Collect `errors: string[]`. Run `validateSchema(CONFIG_SCHEMA, input.file ?? {})` and push its errors.
   - Read environment overrides through one helper per kind: ports (`MOCK_GOOGLE_PORT`, `MOCK_CONTROL_PORT`, `MOCK_PROXY_PORT`) must parse as whole numbers from 0 to 65535, else push `<NAME> must be a whole number from 0 to 65535.`. Hosts and paths are strings. `MOCK_PROXY_PASSTHROUGH` accepts `true`, `false`, `1`, `0`. `MOCK_TIME_SCALE` and `MOCK_DELAYS` go through the existing `parseTiming()`; a `TimingError` message becomes `MOCK_TIME_SCALE: <message>`.
   - If errors exist after these two passes, throw `ConfigError(errors)`. Semantic checks need a schema-valid shape.
   - Build the result from defaults, then the file, then the environment, then the flags, one field at a time. File paths resolve against `input.fileDir ?? cwd`. Environment and flag paths resolve against `cwd`. `caFile` defaults to `join(dataDir, 'ca', 'ca.pem')` after `dataDir` resolves.
   - The proxy is on when the file gives an object, or when `MOCK_PROXY_PORT` or `flags.proxyPort` is set. Its fields default to `{ host: '127.0.0.1', port: 3128, passthrough: false }`.
   - Each domain entry gets its defaults (`onStart: 'keep'`, `settings: {}`, `fixtures: null`, `serviceAccounts: []`, `faults: []`) and resolved paths.
   - Semantic checks, each pushing `domains[i].<key>: <message>` on failure:
     - `resolveSpec(entry.spec)` must not throw a `SpecError`.
     - `mergeSettings(mergeSettings(DEFAULT_SETTINGS, defaults.settings), entry.settings)` must not throw a `SettingsError`. Check `defaults.settings` alone first and report it as `defaults.settings: <message>`.
     - Two entries whose `resolveSpec(...).customerId` is equal: `domains[j].spec names the same domain as domains[i].`
     - A `fixtures` path that does not exist: `domains[i].fixtures: <path> does not exist.`
   - Throw `ConfigError(errors)` if any semantic check failed. Otherwise return the `MockConfig`.
6. `scopesFor(scopes)`.

Export every type and function named in the Interfaces block.

- [ ] **Step 6: Run the checks**

Run: `node --test src/config/json-schema.test.ts src/config/config.test.ts`
Expected: PASS.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add the configuration file, its JSON Schema, and resolution with precedence"
```

---

### Task 3: The CONNECT proxy

**Files:**

- Create: `src/proxy.ts`, `src/proxy.test.ts`
- Modify: `test/compat/run.ts`
- Delete: `test/compat/proxy.ts`

**Interfaces:**

- Produces:
  - `GOOGLE_HOSTS: readonly string[]` (the four hostnames).
  - `startProxy(options: { host: string; port: number; target: { host: string; port: number }; passthrough: boolean; log?: (event: Record<string, unknown>) => void }): Promise<ProxyHandle>`.
  - `interface ProxyHandle { readonly port: number; readonly host: string; readonly url: string; readonly accepted: string[]; readonly refused: string[]; readonly tunneled: string[]; close(): Promise<void> }`. `accepted` holds Google targets, `tunneled` passthrough targets, `refused` refused targets, each as `host:port`.

- [ ] **Step 1: Write the failing tests**

Create `src/proxy.test.ts`:

```ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { GOOGLE_HOSTS, startProxy } from './proxy.ts';

/** A TCP server that answers every connection with one line naming itself. */
async function echoServer(name: string) {
  const server = net.createServer((socket) => socket.end(`${name}\n`));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

/** Send one CONNECT and return the status line plus any tunneled bytes. */
function connect(proxyPort: number, target: string): Promise<{ status: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (text += chunk));
    socket.on('end', () => {
      const [head, ...rest] = text.split('\r\n\r\n');
      resolve({ status: head.split('\r\n')[0], body: rest.join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

test('the proxy tunnels the four Google hostnames on port 443 to the target', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, target: { host: '127.0.0.1', port: google.port }, passthrough: false });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  assert.deepEqual([...GOOGLE_HOSTS].sort(), [
    'admin.googleapis.com',
    'chromemanagement.googleapis.com',
    'oauth2.googleapis.com',
    'www.googleapis.com',
  ]);
  for (const host of GOOGLE_HOSTS) {
    const result = await connect(proxy.port, `${host}:443`);
    assert.equal(result.status, 'HTTP/1.1 200 Connection Established', host);
    assert.equal(result.body, 'google\n');
  }
  assert.equal(proxy.accepted.length, 4);
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('other targets get 403 without passthrough, and the proxy stays healthy', async (t) => {
  const google = await echoServer('google');
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, target: { host: '127.0.0.1', port: google.port }, passthrough: false });
  t.after(async () => {
    await proxy.close();
    google.close();
  });
  for (const target of ['example.com:443', 'admin.googleapis.com:8443', 'evil.googleapis.com:443', 'bad-target'])
    assert.equal((await connect(proxy.port, target)).status, 'HTTP/1.1 403 Forbidden', target);
  assert.equal(proxy.refused.length, 4);
  assert.equal((await connect(proxy.port, 'admin.googleapis.com:443')).body, 'google\n');
});

test('passthrough tunnels other targets to themselves', async (t) => {
  const google = await echoServer('google');
  const other = await echoServer('other');
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, target: { host: '127.0.0.1', port: google.port }, passthrough: true });
  t.after(async () => {
    await proxy.close();
    google.close();
    other.close();
  });
  const result = await connect(proxy.port, `127.0.0.1:${other.port}`);
  assert.equal(result.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(result.body, 'other\n');
  assert.deepEqual(proxy.tunneled, [`127.0.0.1:${other.port}`]);
});

test('a request that is not CONNECT gets 405', async (t) => {
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, target: { host: '127.0.0.1', port: 1 }, passthrough: false });
  t.after(() => proxy.close());
  const response = await new Promise<http.IncomingMessage>((resolve) =>
    http.get({ host: '127.0.0.1', port: proxy.port, path: '/' }, resolve),
  );
  assert.equal(response.statusCode, 405);
  response.resume();
});

test('an unreachable target closes the client socket with 502', async (t) => {
  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const port = (closed.address() as AddressInfo).port;
  closed.close();
  const proxy = await startProxy({ host: '127.0.0.1', port: 0, target: { host: '127.0.0.1', port }, passthrough: false });
  t.after(() => proxy.close());
  assert.equal((await connect(proxy.port, 'admin.googleapis.com:443')).status, 'HTTP/1.1 502 Bad Gateway');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/proxy.test.ts`
Expected: FAIL with a module-not-found error for `./proxy.ts`.

- [ ] **Step 3: Write the proxy**

Create `src/proxy.ts`:

```ts
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';

export const GOOGLE_HOSTS: readonly string[] = [
  'oauth2.googleapis.com',
  'admin.googleapis.com',
  'www.googleapis.com',
  'chromemanagement.googleapis.com',
];

export interface ProxyHandle {
  readonly port: number;
  readonly host: string;
  readonly url: string;
  readonly accepted: string[];
  readonly refused: string[];
  readonly tunneled: string[];
  close(): Promise<void>;
}

/** Split `host:port`, including a bracketed IPv6 host. Returns null for a malformed target. */
function parseTarget(target: string): { host: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65_535) return null;
  return { host: match[1].replace(/^\[|\]$/g, '').toLowerCase(), port };
}

/**
 * A CONNECT proxy. Port 443 of a Google hostname tunnels to the mock's Google
 * listener. Any other target is refused with 403, or tunneled as-is with
 * passthrough. The proxy never terminates TLS.
 */
export async function startProxy(options: {
  host: string;
  port: number;
  target: { host: string; port: number };
  passthrough: boolean;
  log?: (event: Record<string, unknown>) => void;
}): Promise<ProxyHandle> {
  const accepted: string[] = [];
  const refused: string[] = [];
  const tunneled: string[] = [];
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = http.createServer((_request, response) => response.writeHead(405).end());
  server.on('connect', (request: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const raw = request.url ?? '';
    const target = parseTarget(raw);
    const google = target !== null && target.port === 443 && GOOGLE_HOSTS.includes(target.host);
    if (!target || (!google && !options.passthrough)) {
      refused.push(raw);
      options.log?.({ event: 'proxy-refused', target: raw });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    (google ? accepted : tunneled).push(raw);
    const destination = google ? options.target : target;
    const upstream = net.connect(destination.port, destination.host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => {
      if (!client.writableEnded && client.bytesWritten === 0)
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
  });
  server.listen(options.port, options.host);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    host: options.host,
    url: `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${port}`,
    accepted,
    refused,
    tunneled,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: Switch the compat runner to the shipped proxy**

In `test/compat/run.ts`, replace the `startConnectProxy` import with `import { startProxy } from '../../src/proxy.ts';`, and start it with:

```ts
const proxy = await startProxy({
  host: '127.0.0.1',
  port: 0,
  target: { host: '127.0.0.1', port: (google.address() as AddressInfo).port },
  passthrough: false,
});
```

Keep the final `accepted`/`refused` log line and the `proxied` check. Delete `test/compat/proxy.ts`.

- [ ] **Step 5: Run the checks**

Run: `node --test src/proxy.test.ts && npm run test:compat`
Expected: PASS. The compat runner still prints `refused 0`.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: ship the CONNECT proxy that tunnels the Google hostnames to the mock"
```

---

### Task 4: The `empty` tier and fixtures

**Files:**

- Modify: `src/seed/spec.ts`, `src/seed/spec.test.ts`
- Modify: `src/seed/seed.ts`
- Create: `src/seed/fixtures.ts`, `src/seed/fixtures.test.ts`
- Modify: `src/domains.ts`, `src/domains.test.ts`

**Interfaces:**

- Consumes: `validateSchema()` (Task 2, `src/config/json-schema.ts`), `seedDomain()`, `SeedResult`, `resolveSpec()`, `ouId()` (`src/seed/layout.ts`), `newGroupId()`, `outsideMemberId()`, `MODEL_BY_NAME`, `CURRENT_MODELS` (`src/seed/models.ts`), `addressInUse()`, `domainKind()`, `createRandom()`.
- Produces:
  - Tier `empty` in `Tier` and `TIERS`. `resolveSpec({ tier: 'empty', counts | rates })` throws `SpecError('The empty tier takes no counts or rates.')`.
  - `seedDomain()` seeds an `empty` domain as the spec says: the domain rows, the root OU, and one super administrator `admin@<primary>` (given name `Admin`, family name `Account`).
  - In `src/seed/fixtures.ts`: types `Fixtures` (the parsed file), `class FixtureError extends Error { readonly errors: string[] }`, `parseFixtures(value: unknown, file: string): Fixtures` (validates shape, every error formatted `<file>: <json path> <problem>`), `loadFixtures(file: string): Fixtures`, `applyFixtures(db: DatabaseSync, spec: ResolvedSpec, fixtures: Fixtures, seededAt: number, file: string): { orgUnits: number; users: number; devices: number; groups: number }`. `applyFixtures` throws `FixtureError` for reference problems (unknown OU parent handling, unknown member, cycle, collision) and the caller's transaction rolls back.
  - `Domains.create(input, now, options?: { fixtures?: { file: string; data: Fixtures } })` and `Domains.reset(customerId, now)`. The domain database stores the fixtures JSON and file name in `meta` under `fixtures` and `fixturesFile`. `reset()` re-reads them before deleting the file and re-applies them.

- [ ] **Step 1: Write the failing tests**

Append to `src/seed/spec.test.ts`:

```ts
test('the empty tier has zero counts and refuses counts and rates', () => {
  const spec = resolveSpec({ tier: 'empty', seed: 'blank' });
  assert.deepEqual(spec.counts, { schools: 0, students: 0, staff: 0, devices: 0 });
  for (const extra of [{ counts: { students: 5 } }, { rates: { suspended: 0.1 } }])
    assert.throws(
      () => resolveSpec({ tier: 'empty', seed: 'blank', ...extra }),
      (error: unknown) => error instanceof SpecError && error.message === 'The empty tier takes no counts or rates.',
    );
});
```

Create `src/seed/fixtures.test.ts`. Use a helper that seeds an `empty` domain into `openDomainDb(':memory:')` with `seedDomain`, then calls `applyFixtures`. Cover each case with its own `test()`:

1. **Empty seed:** the `empty` domain holds exactly one OU (`/`), one user `admin@<primary>` with `is_admin = 1`, no devices, and no groups.
2. **OUs:** `{ orgUnits: [{ path: '/Schools/North/Grade 5', description: 'Fifth' }] }` creates `/Schools`, `/Schools/North`, and `/Schools/North/Grade 5`, each with `ouId(seed, path)`, correct `parent_path`, `depth`, and the description on the leaf only.
3. **Users:** a user with every field set round-trips through `users.get` semantics (read the row): primary email lower-cased, names, `full_name`, `org_unit_path`, `is_admin`, `suspended` with `suspension_reason` `'ADMIN'`, aliases in `user_aliases`, `external_ids` JSON and `external_id` first value, and `role` `'staff'`. An omitted `id` is `1` plus 20 digits and stable across two runs.
4. **Devices:** `{ devices: [{ serialNumber: 'SN-1', model: '<a CURRENT_MODELS name>', orgUnitPath: '/Carts', annotatedUser: 'cart' }] }` inserts one device whose `serial_number`, `model`, `org_unit_path`, `org_unit_id` (the OU's ID), and `annotated_user` match. `status` defaults to `ACTIVE`. Every other NOT NULL column holds a value. A second run yields the identical row. An unknown model is an error naming `devices[0].model`.
5. **Groups:** a group with `aliases` and `members` naming a fixture user (by email, role `OWNER`), a seeded administrator, a later fixture group (by email), the customer ID (`{ id: customerId }`), and an outside address yields `group_members` rows with types `USER`, `USER`, `GROUP`, `CUSTOMER`, `USER` and `outsideMemberId()` for the outside member. Members may name groups defined later in the file.
6. **Errors**, each asserting the full `errors` array of the thrown `FixtureError`:
   - an address on a domain the customer does not own: `<file>: users[0].primaryEmail must be on one of the customer's domains.`
   - two users with one address: `<file>: users[1].primaryEmail is already in use.`
   - a member that names nothing: `<file>: groups[0].members[0] names no user, group, customer, or outside address.`
   - a cycle `a` contains `b`, `b` contains `a`: `<file>: groups[1].members[0] makes a membership cycle.`
   - a device in an OU that the file does not define and the domain lacks: `<file>: devices[0].orgUnitPath names no OU.`
   - an unknown top-level key: `<file>: things is not an allowed key.`
7. **Generated tiers:** fixtures apply on top of a `small` domain too, and a fixture address that collides with a seeded user fails.

Append to `src/domains.test.ts`:

```ts
test('a domain reset re-applies its stored fixtures', (t) => {
  // Create a domain with fixtures through createDomains(), write a user directly,
  // reset it, and assert the fixture user is back and the direct write is gone.
});
```

Write that test fully in the file's existing style: create the registry and domains the way the file's other tests do, pass `{ fixtures: { file: 'inline.json', data: parseFixtures({ users: [...] }, 'inline.json') } }` to `create`, insert a stray user row, call `reset`, and assert with SQL.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/seed/spec.test.ts src/seed/fixtures.test.ts src/domains.test.ts`
Expected: FAIL. The `empty` tier and `./fixtures.ts` do not exist.

- [ ] **Step 3: Add the `empty` tier**

In `src/seed/spec.ts`, add `'empty'` to `Tier` and `empty: { schools: 0, students: 0, staff: 0, devices: 0 }` to `TIERS`. In `resolveSpec()`, before resolving counts, throw `new SpecError('The empty tier takes no counts or rates.')` when `tier === 'empty'` and `spec.counts` or `spec.rates` is present. Update the tier error message to `tier must be small, medium, large, xlarge, or empty.`

In `src/seed/seed.ts`, branch at the top of the transaction: for an `empty` spec, write the `meta` rows and the three domain rows as today, insert the root OU from `buildLayout(spec).root`, insert one user (`admin@<primary>`, `Admin`, `Account`, OU `/`, `is_admin` 1, role `admin`, creation time `seededAt - 1000 * DAY_MS`, ord 0, ID from `createRandom(`users/${spec.seed}`)` as the generator does), and skip users, devices, and groups. Report the counts from the tables as today.

If `buildLayout()` cannot run with zero schools, build the root OU node directly with `ouId(spec.seed, '/')` and `spec.districtName`.

- [ ] **Step 4: Write the fixtures module**

Create `src/seed/fixtures.ts`:

- `Fixtures` type:

```ts
export interface FixtureOrgUnit { path: string; description?: string }
export interface FixtureUser {
  primaryEmail: string;
  givenName: string;
  familyName: string;
  orgUnitPath?: string;
  isAdmin?: boolean;
  suspended?: boolean;
  aliases?: string[];
  externalIds?: { value: string; type?: string }[];
  id?: string;
}
export interface FixtureDevice {
  serialNumber: string;
  model?: string;
  status?: 'ACTIVE' | 'DISABLED' | 'DEPROVISIONED';
  orgUnitPath?: string;
  annotatedUser?: string;
  annotatedAssetId?: string;
  annotatedLocation?: string;
  notes?: string;
  lastSync?: string;
  deviceId?: string;
}
export interface FixtureMember { email?: string; id?: string; role?: 'OWNER' | 'MANAGER' | 'MEMBER' }
export interface FixtureGroup { email: string; name?: string; description?: string; aliases?: string[]; members?: FixtureMember[] }
export interface Fixtures { orgUnits: FixtureOrgUnit[]; users: FixtureUser[]; devices: FixtureDevice[]; groups: FixtureGroup[] }
```

- `parseFixtures(value, file)` checks the shape with `validateSchema()` from Task 2's `src/config/json-schema.ts` against an inline schema object that mirrors these types (with `additionalProperties: false`, `required` fields, string patterns checked in code), prefixes each error with `${file}: `, and throws `FixtureError` when any error exists. It fills empty arrays for missing sections.
- `applyFixtures(db, spec, fixtures, seededAt, file)` runs in the caller's transaction and inserts, in order:
  1. OUs: each path and its missing ancestors, with `ouId(spec.seed, path)`, `kind` `'container'`, `ord` after the current maximum.
  2. Users: `domainKind(db, email)` must be `'own'`. `addressInUse(db, email)` must be false. `id` defaults to `1` plus `createRandom(`fixture-user/${spec.seed}/${email}`).string(20, '0123456789')`. The OU must exist. Aliases follow the same two checks. `external_id` is the first `externalIds[].value`, `external_ids` the JSON array. `role` `'staff'`. `creation_time` `seededAt - 30 * DAY_MS`. `last_login_time` null.
  3. Devices: the model must be in `MODEL_BY_NAME`, default `CURRENT_MODELS[0].name`. Every other column takes a deterministic value from `createRandom(`fixture-device/${spec.seed}/${serialNumber}`)`, following the value families in `src/seed/devices.ts` (MAC addresses, OS version from `CURRENT_OS`, platform from `PLATFORM_FOR_OS`, firmware, boot mode `Verified`, RAM and storage, `has_battery` 1, license type, category `'one-to-one'`, `misplaced` 0, `aue` from the model). `deviceId` defaults to a UUID from the same random stream. `lastSync` is an ISO time, default `seededAt - DAY_MS`.
  4. Groups: insert every group first (`newGroupId(createRandom(`fixture-group/${spec.seed}/${email}`), taken)`, `admin_created` 1, `created_at` `seededAt - 30 * DAY_MS`), then aliases, then members. A member resolves, in order: a user by email or ID, a group by email, alias, or ID, the customer ID, or an outside address (`domainKind` `'outside'`) with `outsideMemberId()`. `added_at` is the group's `created_at`. After all members exist, reject cycles with a recursive query over `group_members`.
  5. Return the four counts.
- Collect every reference error before throwing, so one run reports them all.

- [ ] **Step 5: Store and re-apply fixtures**

In `src/domains.ts`:

- `create(input, now, options?)`: after `seedDomain()`, when `options?.fixtures` is set, call `applyFixtures(db, spec, options.fixtures.data, now, options.fixtures.file)` inside one transaction with `INSERT INTO meta (key, value) VALUES ('fixtures', ?), ('fixturesFile', ?)`. A `FixtureError` deletes the half-created domain files and registry row, then rethrows.
- `reset(customerId, now)`: before `removeFiles`, read `meta.fixtures` and `meta.fixturesFile` from the open database. After reseeding, re-apply them the same way.
- Add `create`'s new parameter to the `Domains` interface.

- [ ] **Step 6: Run the checks**

Run: `node --test src/seed/spec.test.ts src/seed/fixtures.test.ts src/domains.test.ts`
Expected: PASS.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass. If an existing test lists the tier names or the tier error message, update its expected text.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add the empty tier and declarative fixtures for exact test data"
```

---
### Task 5: Startup orchestration, `GET /info`, and test tokens

One `startServer()` builds the whole running mock from a `MockConfig`. The image entry point uses it now. The CLI and the API use it in Tasks 6 and 7.

**Files:**

- Create: `src/server.ts`, `src/server.test.ts`
- Create: `src/startup/ensure-domains.ts`, `src/startup/ensure-domains.test.ts`
- Modify: `src/control/control.ts`, `src/control/control.test.ts`
- Modify: `src/main.ts`, `src/main.test.ts`

**Interfaces:**

- Consumes: `MockConfig`, `DomainEntry`, `ConfigError`, `resolveConfig()`, `findConfigFile()`, `loadConfigFile()`, `scopesFor()` (Task 2); `startProxy()`, `ProxyHandle` (Task 3); `loadFixtures()`, `FixtureError` (Task 4); `Domains.create(input, now, { fixtures })` (Task 4); `createMock()`, `issueServiceAccount()`, `mergeSettings()`, `DEFAULT_SETTINGS`, `resolveSpec()`, `VERSION` (Task 1).
- Produces:
  - In `src/startup/ensure-domains.ts`:
    - `interface EnsuredServiceAccount { out: string; clientEmail: string; clientId: string; scopes: string[] }`
    - `interface EnsuredDomain { customerId: string; primaryDomain: string; adminEmail: string; action: 'created' | 'kept' | 'reset'; serviceAccounts: EnsuredServiceAccount[] }`
    - `ensureDomain(mock: Mock, entry: DomainEntry, index: number, defaults: Record<string, unknown>, now: number): EnsuredDomain`. Problems throw `ConfigError` with `domains[<index>]`-prefixed messages.
  - In `src/server.ts`:
    - `interface ServerInfo { version: string; ready: boolean; listeners: { google: { host: string; port: number }; control: { host: string; port: number }; proxy: { host: string; port: number; passthrough: boolean } | null }; caFile: string; caBundleFile: string; dataDir: string; domains: EnsuredDomain[] }`
    - `interface ServerHandle { readonly mock: Mock; info(): ServerInfo; readonly controlUrl: string; readonly googleUrl: string; readonly proxy: ProxyHandle | null; close(): Promise<void> }`
    - `startServer(config: MockConfig, options?: { log?: (event: Record<string, unknown>) => void }): Promise<ServerHandle>`
    - `loadStartupConfig(input: { flags?: ConfigFlags; configFlag?: string; env: NodeJS.ProcessEnv; cwd: string }): MockConfig`. It finds the file with `findConfigFile`, falls back to `env.MOCK_CONFIG_DEFAULT` when that file exists, loads it, and resolves with the file's directory as `fileDir`.
    - `clientEnvironment(info: ServerInfo, controlUrl: string): Record<string, string>`. It returns `HTTPS_PROXY` and `https_proxy` (only when the proxy is on), `NO_PROXY` and `no_proxy` = `localhost,127.0.0.1,::1`, `NODE_EXTRA_CA_CERTS` = `caFile`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`, `CURL_CA_BUNDLE` = `caBundleFile`, `ADMIN_SDK_MOCK_CONTROL` = `controlUrl`, and `GOOGLE_APPLICATION_CREDENTIALS` when exactly one service account exists. A listener host of `0.0.0.0` or `::` becomes `127.0.0.1` in URLs.
  - `createControlHandler(mock, options?: { info?: () => ServerInfo })`. New routes: `GET /info` (404 without an `info` provider) and `POST /domains/{id}/tokens`.

- [ ] **Step 1: Write the failing tests**

Create `src/startup/ensure-domains.test.ts`. Build a mock with `createMock({ dataDir: <temp>, timing: { scale: 1, delays: false } })` and `resolveConfig()` entries. Cover each case in its own `test()`:

1. **Create:** an absent domain is created (`action: 'created'`), `adminEmail` is `admin@<primary>`, the merged settings hold `defaults.settings` overridden by `entry.settings`, and the configured faults are present (`mock.faults.list(customerId).length`).
2. **Service accounts:** each `serviceAccounts[j]` writes `out` with mode 0600 (`statSync(out).mode & 0o777` is `0o600`), the file parses as the Google service-account format (`type`, `client_email`, `private_key`, `token_uri`), and `mock.registry.grant(customerId, clientId)` equals `scopesFor(scopes)`.
3. **Keep:** a second `ensureDomain` with the same entry returns `action: 'kept'`, leaves `seededAt` unchanged, reuses the key file (identical bytes), and re-grants the scopes. Changing `scopes` from `read` to `read-write` re-grants without a new key.
4. **Changed spec with keep:** throws `ConfigError` whose single error reads `domains[0].spec changed since the domain was created. Set onStart to reset or delete the data directory.` A changed fixtures file under `keep` throws `domains[0].fixtures changed since the domain was created. Set onStart to reset or delete the data directory.`
5. **Reset:** `onStart: 'reset'` deletes and recreates the domain (`action: 'reset'`, new `seededAt`), applies the current fixtures, and still reuses a key file whose account belongs to the customer. A key file from another customer, or with an unknown `client_email`, is replaced by a newly issued one.
6. **Faults:** a second run replaces the faults with the configured list, so the count does not double. An invalid fault rule throws `ConfigError` naming `domains[0].faults[0]` with the `FaultError` message.

Create `src/server.test.ts`. Use `resolveConfig({ cwd: tmp, file: {...} })` with every listener on port 0. Cover:

1. **Start:** `startServer()` returns a handle whose `info()` has `ready: true`, the real listener ports, `version` equal to `VERSION`, the domains, and `caFile` holding the CA PEM. `caBundleFile` holds the CA PEM followed by every certificate in `tls.rootCertificates`.
2. **Events:** the `log` callback receives `started`, one `domain` event per domain (`customerId`, `action`, `durationMs`), then `ready`, in that order. `readyFile`, when configured, holds the `ready` event JSON.
3. **Control:** `GET /info` on the control listener returns the same object as `info()`. `GET /health` still answers.
4. **Proxy tunnel:** open a CONNECT through `handle.proxy` to `admin.googleapis.com:443`, then `tls.connect({ socket, servername: 'admin.googleapis.com', ca: <caFile contents> })`, send `GET /admin/directory/v1/users?customer=my_customer` with no token, and read a `401` status line. This proves the tunnel and the certificate chain.
5. **Tokens:** `POST /domains/{customerId}/tokens` with `{ "scopes": "read" }` returns `{ access_token, token_type: 'Bearer', expires_in: 3600, scope }`. Using that token over the same tunnel, `GET /admin/directory/v1/users?customer=my_customer&maxResults=1` answers `200`. A `subject` that is not a user of the domain answers `400`. `ttlSeconds` outside 1 to 3600 answers `400`.
6. **Close:** `close()` closes all three listeners. A second `close()` resolves.
7. **clientEnvironment:** with a proxy on host `0.0.0.0` port 3128 and one service account, the map holds `HTTPS_PROXY` `http://127.0.0.1:3128` and the key path in `GOOGLE_APPLICATION_CREDENTIALS`. With no proxy, `HTTPS_PROXY` is absent.
8. **Failure cleanup:** a domain whose fixtures fail makes `startServer()` reject with the `FixtureError` and leaves no listener open (the ports are free again).

Extend `src/main.test.ts` with two spawned-process tests:

- `MOCK_CONFIG` names a file with `{ "domains": [{ "spec": { "tier": "huge", "seed": "x" } }] }`: the process exits with code 2 and its standard error contains `domains[0].spec.tier must be one of:`.
- `MOCK_CONFIG` names a valid file with all ports 0 and one `empty` domain: standard output carries a `started` line then a `ready` line (JSON), and `SIGTERM` ends the process with code 0.

Keep every existing `src/main.test.ts` assertion. If one depends on the old defaults of port 443 or host `0.0.0.0`, pass those values through the environment in that test.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/startup/ensure-domains.test.ts src/server.test.ts src/main.test.ts`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Write `ensureDomain`**

Create `src/startup/ensure-domains.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { issueServiceAccount, type ServiceAccountFile } from '../auth/accounts.ts';
import { ConfigError, scopesFor, type DomainEntry } from '../config/config.ts';
import { FaultError } from '../faults/faults.ts';
import type { Mock } from '../mock.ts';
import { loadFixtures } from '../seed/fixtures.ts';
import { resolveSpec } from '../seed/spec.ts';
import { DEFAULT_SETTINGS, mergeSettings } from '../settings.ts';
import { row } from '../store/sqlite.ts';

export interface EnsuredServiceAccount {
  out: string;
  clientEmail: string;
  clientId: string;
  scopes: string[];
}

export interface EnsuredDomain {
  customerId: string;
  primaryDomain: string;
  adminEmail: string;
  action: 'created' | 'kept' | 'reset';
  serviceAccounts: EnsuredServiceAccount[];
}

const restart = (path: string, what: string) =>
  new ConfigError([`${path}.${what} changed since the domain was created. Set onStart to reset or delete the data directory.`]);

/** Read an existing key file that belongs to this customer, or null. */
function reusableKey(mock: Mock, out: string, customerId: string): ServiceAccountFile | null {
  if (!existsSync(out)) return null;
  try {
    const file = JSON.parse(readFileSync(out, 'utf8')) as ServiceAccountFile;
    const account = mock.registry.serviceAccountByEmail(file.client_email);
    return account && account.customerId === customerId && typeof file.private_key === 'string' ? file : null;
  } catch {
    return null;
  }
}

/** Create, keep, or reset one configured domain, then apply its settings, faults, and service accounts. */
export function ensureDomain(
  mock: Mock,
  entry: DomainEntry,
  index: number,
  defaults: Record<string, unknown>,
  now: number,
): EnsuredDomain {
  const path = `domains[${index}]`;
  const spec = resolveSpec(entry.spec);
  const fixtures = entry.fixtures ? { file: entry.fixtures, data: loadFixtures(entry.fixtures) } : undefined;
  const existing = mock.domains.get(spec.customerId);
  let action: EnsuredDomain['action'] = 'created';
  if (existing) {
    const sameSpec = JSON.stringify(resolveSpec(existing.record.spec)) === JSON.stringify(spec);
    const stored = row<{ value: string }>(existing.db.prepare("SELECT value FROM meta WHERE key = 'fixtures'").get());
    const sameFixtures = (stored?.value ?? null) === (fixtures ? JSON.stringify(fixtures.data) : null);
    if (entry.onStart === 'reset') {
      mock.domains.delete(spec.customerId);
      mock.domains.create(entry.spec, now, { fixtures });
      action = 'reset';
    } else if (!sameSpec) throw restart(path, 'spec');
    else if (!sameFixtures) throw restart(path, 'fixtures');
    else action = 'kept';
  } else mock.domains.create(entry.spec, now, { fixtures });

  mock.domains.updateSettings(
    spec.customerId,
    mergeSettings(mergeSettings(DEFAULT_SETTINGS, defaults), entry.settings),
  );

  mock.faults.clear(spec.customerId);
  entry.faults.forEach((rule, n) => {
    try {
      mock.faults.add(spec.customerId, rule);
    } catch (error) {
      if (error instanceof FaultError) throw new ConfigError([`${path}.faults[${n}]: ${error.message}`]);
      throw error;
    }
  });

  const serviceAccounts = entry.serviceAccounts.map((account) => {
    const scopes = scopesFor(account.scopes);
    const file =
      reusableKey(mock, account.out, spec.customerId) ??
      issueServiceAccount(mock.registry, spec.customerId, account.projectId);
    mock.registry.setGrant(spec.customerId, file.client_id, scopes);
    mkdirSync(dirname(account.out), { recursive: true });
    writeFileSync(account.out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(account.out, 0o600);
    return { out: account.out, clientEmail: file.client_email, clientId: file.client_id, scopes };
  });

  return {
    customerId: spec.customerId,
    primaryDomain: spec.primaryDomain,
    adminEmail: `admin@${spec.primaryDomain}`,
    action,
    serviceAccounts,
  };
}
```

Check two things against the repository before relying on them, and adapt the call shape if they differ: the signature of `registry.setGrant` (Task 1 of milestone 1 defined it), and whether `mock.domains.updateSettings` replaces or merges. The test in case 1 pins the final settings either way. Also confirm `ServiceAccountFile` field names (`client_email`, `client_id`, `private_key`).

- [ ] **Step 4: Write `startServer` and `clientEnvironment`**

Create `src/server.ts`. It holds `ServerInfo`, `ServerHandle`, `startServer`, `loadStartupConfig`, and `clientEnvironment` as named in the Interfaces block. `startServer` runs these steps, closing whatever it opened if a later step throws:

1. `const mock = createMock({ dataDir: config.dataDir, timing: config.timing })`.
2. Write `config.caFile` (directories created, mode 0644) with `mock.certificates.caCert`. Write `caBundleFile` beside it: the same name with `.pem` replaced by `-bundle.pem`, holding the CA PEM, a newline, and `tls.rootCertificates.join('\n')`.
3. `const google = await mock.listenGoogle(config.listen.google.port, config.listen.google.host)`.
4. Start the control server: `http.createServer(createControlHandler(mock, { info }))` on `config.listen.control`.
5. When `config.listen.proxy` is set: `startProxy({ ...config.listen.proxy, target: { host: <google host, with 0.0.0.0 or :: mapped to 127.0.0.1>, port: <google port> }, log })`.
6. Log `{ event: 'started', version, googlePort, controlPort, proxyPort, dataDir, caFile, timing }`. Keep the field names `googlePort`, `controlPort`, `dataDir`, and `timing` that `src/main.ts` logs today.
7. For each domain entry, `ensureDomain(mock, entry, index, config.defaults.settings, mock.clock.now())`, timing each, and log `{ event: 'domain', customerId, primaryDomain, action, durationMs }`.
8. Set `ready = true`. Write `readyFile` when configured. Log `{ event: 'ready', ...info() }`.

`close()` closes the proxy, the control server, the Google server, and the mock, in that order, and resolves once. A second call resolves at once.

`loadStartupConfig()`:

```ts
export function loadStartupConfig(input: {
  flags?: ConfigFlags;
  configFlag?: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): MockConfig {
  let file = findConfigFile({ flag: input.configFlag, env: input.env, cwd: input.cwd });
  if (!file && input.env.MOCK_CONFIG_DEFAULT && existsSync(input.env.MOCK_CONFIG_DEFAULT))
    file = input.env.MOCK_CONFIG_DEFAULT;
  return resolveConfig({
    file: file ? loadConfigFile(file) : undefined,
    fileDir: file ? dirname(file) : undefined,
    env: input.env,
    flags: input.flags,
    cwd: input.cwd,
  });
}
```

- [ ] **Step 5: Add `GET /info` and `POST /domains/{id}/tokens`**

In `src/control/control.ts`:

- Change the signature to `createControlHandler(mock: Mock, options: { info?: () => ServerInfo } = {})`. Import `ServerInfo` as a type from `../server.ts`.
- `GET /info`: send `options.info()`, or `404 Not found.` without a provider.
- `POST /domains/{id}/tokens`: read the body `{ subject?: string; scopes?: 'read' | 'read-write' | string[]; ttlSeconds?: number }`.
  - `subject` defaults to `admin@<primary>`, and must name a user of the domain (`findUser(domain.db, subject)`), else `400 subject must name a user of the domain.`
  - `scopes` defaults to `read-write`. A list must hold strings, else `400`.
  - `ttlSeconds` defaults to 3600 and must be a whole number from 1 to 3600, else `400 ttlSeconds must be a whole number from 1 to 3600.`
  - Save `{ token: 'ya29.mock.' + randomUUID(), clientId: '100000000000000000000', projectId: 'admin-sdk-mock-control', subject, customerId, scopes, expiresAt: mock.clock.now() + ttl * 1000 }` with `mock.registry.saveToken`.
  - Answer `200 { access_token, token_type: 'Bearer', expires_in: ttl, scope: scopes.join(' ') }`.

Add tests for both routes to `src/control/control.test.ts`, using the file's existing setup.

- [ ] **Step 6: Make the entry point use `startServer`**

Replace the body of `src/main.ts`:

```ts
import { ConfigError } from './config/config.ts';
import { FixtureError } from './seed/fixtures.ts';
import { SpecError } from './seed/spec.ts';
import { loadStartupConfig, startServer } from './server.ts';

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));

try {
  const server = await startServer(loadStartupConfig({ env: process.env, cwd: process.cwd() }), { log });
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  if (error instanceof ConfigError || error instanceof FixtureError) {
    for (const line of error.errors) console.error(line);
    process.exit(2);
  }
  if (error instanceof SpecError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
```

The environment keeps every current variable. Defaults now come from `resolveConfig()` (Google `127.0.0.1:8443`). Task 8 sets the image's defaults in the Dockerfile.

- [ ] **Step 7: Run the checks**

Run: `node --test src/startup/ensure-domains.test.ts src/server.test.ts src/main.test.ts src/control/control.test.ts`
Expected: PASS.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check && npm run test:contract && npm run test:compat`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: start the mock from one configuration with ensured domains, keys, info, and test tokens"
```

---

### Task 6: The `admin-sdk-mock` CLI

**Files:**

- Create: `src/cli/main.ts`, `src/cli/help.ts`, `src/cli/control-commands.ts`, `src/cli/env.ts`, `src/cli/init.ts`, `src/cli/doctor.ts`
- Create: `src/cli/cli.test.ts`, `src/cli/env.test.ts`
- Create: `bin/admin-sdk-mock.ts`
- Modify: `bin/mockctl.ts`, `src/control/mockctl.test.ts`

**Interfaces:**

- Consumes: `startServer()`, `loadStartupConfig()`, `clientEnvironment()`, `ServerInfo` (Task 5); `ConfigError`, `resolveConfig()`, `loadConfigFile()`, `ConfigFlags` (Task 2); `FixtureError` (Task 4); `READ_SCOPES`, `READ_WRITE_SCOPES`.
- Produces:
  - `runCli(argv: string[], io?: { stdout?: (text: string) => void; stderr?: (text: string) => void; env?: NodeJS.ProcessEnv; cwd?: string; program?: 'admin-sdk-mock' | 'mockctl' }): Promise<number>`. It returns the exit code and never calls `process.exit`, except that `start` keeps running until a signal.
  - `HELP: Readonly<Record<string, string>>` in `src/cli/help.ts`: the key `''` holds the top-level usage, and each command name holds that command's usage. Task 13 generates `docs/reference/cli.md` from it.
  - `formatEnvironment(vars: Record<string, string>, format: 'sh' | 'dotenv' | 'json' | 'github'): string` in `src/cli/env.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/cli/env.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatEnvironment } from './env.ts';

const vars = { HTTPS_PROXY: 'http://127.0.0.1:3128', SSL_CERT_FILE: "/tmp/it's/ca.pem" };

test('formats the client environment for each target', () => {
  assert.equal(
    formatEnvironment(vars, 'sh'),
    "export HTTPS_PROXY='http://127.0.0.1:3128'\nexport SSL_CERT_FILE='/tmp/it'\\''s/ca.pem'\n",
  );
  assert.equal(formatEnvironment(vars, 'dotenv'), 'HTTPS_PROXY=http://127.0.0.1:3128\nSSL_CERT_FILE="/tmp/it\'s/ca.pem"\n');
  assert.deepEqual(JSON.parse(formatEnvironment(vars, 'json')), vars);
  assert.equal(formatEnvironment(vars, 'github'), "HTTPS_PROXY=http://127.0.0.1:3128\nSSL_CERT_FILE=/tmp/it's/ca.pem\n");
});
```

The `dotenv` format quotes a value with double quotes when it holds a space, a quote, `#`, or `$`, and escapes `"` and `\`. The `github` format rejects a value with a newline by throwing.

Create `src/cli/cli.test.ts`. Run `runCli` in-process with captured `stdout`/`stderr` and a temporary `cwd`, except for `start`, which runs as a child process: `node bin/admin-sdk-mock.ts start ...`. Cover:

1. `--help` and `help` print `HELP['']` and return 0. `<command> --help` prints that command's help. An unknown command prints the usage to standard error and returns 2.
2. `init` writes `admin-sdk-mock.json` with the starter content in Step 3, prints next steps, and returns 0. A second `init` returns 2 with `admin-sdk-mock.json already exists. Pass --force to replace it.` `init --force --out custom.json` writes `custom.json`.
3. `config validate <file>` prints `<file> is valid.` and returns 0 for the starter file, and prints every error and returns 2 for a file with two errors.
4. `start` (child process) with `--config` naming a file with ports 0, an `empty` domain, a proxy, and a service account: prints `started`, `domain`, and `ready` JSON lines. Then `env --control <url> --format json` (in-process) returns the `clientEnvironment()` map, including `HTTPS_PROXY`. `env --format github` with `GITHUB_ENV` set appends the lines to that file. Then `token <customerId> --scopes read` prints a JSON body with `access_token`. Then `SIGTERM` ends the child with code 0.
5. `start` with an invalid configuration exits 2 and prints each error to standard error.
6. `doctor` prints a `PASS` or `FAIL` line for: the Node version (`>=24.11`), the configuration (when a file is found), the data directory (writable), and each configured listener port (free). It returns 1 when any line fails, for example when the configured control port is held by a test server.
7. Every control command that `bin/mockctl.ts` supports today still works through `runCli` against a control server started from a harness, with the same output. `credential <id> --scopes read-write` grants `READ_WRITE_SCOPES`.

In `src/control/mockctl.test.ts`, keep every assertion. It still spawns `bin/mockctl.ts`.

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/cli/env.test.ts src/cli/cli.test.ts`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Write the CLI**

- `src/cli/control-commands.ts`: move the command code of `bin/mockctl.ts` (the `call()` helper, `CliError`, and each case of the switch) into `runControlCommand(argv, io): Promise<number>`. Take the control URL from `--control`, then `MOCK_CONTROL_URL`, then `http://127.0.0.1:8080`. Keep every message. Accept `read` and `read-write` in `credential --scopes`. Add `token <customerId> [--subject <email>] [--scopes <read|read-write|a,b>] [--ttl <seconds>] [--raw]`, which posts to `/domains/{id}/tokens` and prints the JSON body, or only the token with `--raw`.
- `src/cli/env.ts`: `formatEnvironment()`, and `runEnv(argv, io)`: resolve the control URL (`--control`, `MOCK_CONTROL_URL`, the found configuration's control listener, then the default), `GET <url>/info`, build `clientEnvironment(info, url)`, and print it in `--format` (default `sh`). For `github`, append to the file named by `GITHUB_ENV`, or return 2 with `GITHUB_ENV is not set.` When the proxy is off, write `The proxy is off. Set listen.proxy in the configuration to route clients through it.` to standard error and still print the other variables. A failed fetch returns 1 with `No mock answers at <url>.`
- `src/cli/init.ts`: write this starter to `--out` (default `admin-sdk-mock.json`):

```json
{
  "$schema": "./node_modules/@campuscommander/admin-sdk-mock/schema/config.schema.json",
  "dataDir": "./.admin-sdk-mock/data",
  "listen": { "proxy": { "port": 3128 } },
  "domains": [
    {
      "spec": { "tier": "small", "seed": "demo" },
      "serviceAccounts": [
        { "out": "./.admin-sdk-mock/credentials/demo.json", "scopes": "read-write" }
      ]
    }
  ]
}
```

  Then print the next steps: `npx admin-sdk-mock start`, then `eval "$(npx admin-sdk-mock env)"` in the client's shell, then the key file path and the subject `admin@<primary>` from `resolveSpec({ tier: 'small', seed: 'demo' })`. Remind the user to add `.admin-sdk-mock/` to `.gitignore`.
- `src/cli/doctor.ts`: the four checks named in Step 1. A port check binds and releases a server on the configured host and port. Port 0 always passes.
- `src/cli/help.ts`: `HELP` with one entry per command: `''`, `start`, `init`, `env`, `doctor`, `config`, `token`, `domain`, `credential`, `settings`, `quota`, `fault`, `index`, `clock`, `ca`. Each lists its flags with one line of description.
- `src/cli/main.ts`: `runCli()` dispatches by the first positional. `start` parses its flags with `parseArgs` (`--config`, `--data-dir`, `--google-host`, `--google-port`, `--control-host`, `--control-port`, `--proxy-host`, `--proxy-port`, `--passthrough`, `--scale`, `--delays on|off`, `--ca-file`, `--ready-file`), calls `loadStartupConfig()` and `startServer()` with a JSON-line logger, and waits for `SIGTERM` or `SIGINT`. Configuration, fixture, and spec errors print each line to standard error and return 2. Other errors print the message and return 1.

Create `bin/admin-sdk-mock.ts`:

```ts
#!/usr/bin/env node
import { runCli } from '../src/cli/main.ts';

process.exitCode = await runCli(process.argv.slice(2));
```

Replace `bin/mockctl.ts` with the same two lines, passing `{ program: 'mockctl' }`.

- [ ] **Step 4: Run the checks**

Run: `node --test src/cli/env.test.ts src/cli/cli.test.ts src/control/mockctl.test.ts`
Expected: PASS.

Run: `npm run build && node dist/bin/admin-sdk-mock.js --help`
Expected: prints the top-level usage.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add the admin-sdk-mock CLI with start, init, env, doctor, config validate, and token"
```

---

### Task 7: The programmatic API

**Files:**

- Modify: `src/index.ts`
- Create: `src/index.test.ts`

**Interfaces:**

- Consumes: `startServer()`, `ServerHandle`, `ServerInfo`, `clientEnvironment()` (Task 5); `resolveConfig()` (Task 2); `parseFixtures()`, `Fixtures` (Task 4); `EnsuredDomain` (Task 5); `issueServiceAccount()`; `scopesFor()`.
- Produces, exported from the package root:
  - `startMock(options?: MockOptions): Promise<MockHandle>`
  - `interface MockOptions { dataDir?: string; config?: Record<string, unknown>; proxy?: false | { passthrough?: boolean }; timing?: { scale?: number; delays?: boolean }; log?: (event: Record<string, unknown>) => void }`
  - `interface MockHandle { readonly googleUrl: string; readonly controlUrl: string; readonly proxyUrl: string | null; readonly caCert: string; readonly caFile: string; readonly caBundleFile: string; readonly domains: readonly EnsuredDomain[]; createDomain(spec: Record<string, unknown>, options?: { settings?: Record<string, unknown>; fixtures?: string | Record<string, unknown> }): Promise<EnsuredDomain>; credential(customerId: string, scopes?: 'read' | 'read-write' | string[]): Record<string, string>; token(customerId: string, options?: { subject?: string; scopes?: 'read' | 'read-write' | string[] }): Promise<string>; env(): Record<string, string>; useInProcess(): () => void; flush(customerId: string): Promise<unknown>; control(method: string, path: string, body?: unknown): Promise<unknown>; close(): Promise<void> }`
  - Re-exports: `VERSION`, `READ_SCOPES`, `READ_WRITE_SCOPES`, and the types `MockConfig`, `EnsuredDomain`, `ServerInfo`, `Fixtures`.

- [ ] **Step 1: Write the failing tests**

Create `src/index.test.ts`:

```ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import tls from 'node:tls';
import test from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_SCOPES, READ_WRITE_SCOPES, startMock } from './index.ts';
import { resolveSpec } from './seed/spec.ts';

test('the unmodified Google client reaches an in-process mock', async (t) => {
  const mock = await startMock({
    config: { domains: [{ spec: { tier: 'small', seed: 'api', counts: { schools: 1, students: 20, staff: 5, devices: 10 } } }] },
  });
  t.after(() => mock.close());
  const [domain] = mock.domains;
  const key = mock.credential(domain.customerId, 'read-write');
  const restore = mock.useInProcess();
  t.after(restore);
  const directory = admin({
    version: 'directory_v1',
    auth: new JWT({ email: key.client_email, key: key.private_key, subject: domain.adminEmail, scopes: [...READ_WRITE_SCOPES] }),
  });
  const users = await directory.users.list({ customer: 'my_customer', maxResults: 5 });
  assert.equal(users.data.users?.length, 5);
  const groups = await directory.groups.list({ customer: 'my_customer', maxResults: 5 });
  assert.ok((groups.data.groups?.length ?? 0) > 0);
});

test('useInProcess restores the CA set and HTTPS_PROXY, in any close order', async () => {
  const baseline = { ca: tls.getCACertificates('default').length, proxy: process.env.HTTPS_PROXY };
  const a = await startMock();
  const b = await startMock();
  a.useInProcess();
  b.useInProcess();
  const defaults = tls.getCACertificates('default');
  assert.ok(defaults.includes(a.caCert) && defaults.includes(b.caCert));
  assert.equal(process.env.HTTPS_PROXY, b.proxyUrl);
  await a.close();
  assert.ok(!tls.getCACertificates('default').includes(a.caCert));
  assert.ok(tls.getCACertificates('default').includes(b.caCert));
  assert.equal(process.env.HTTPS_PROXY, b.proxyUrl);
  await b.close();
  assert.equal(tls.getCACertificates('default').length, baseline.ca);
  assert.equal(process.env.HTTPS_PROXY, baseline.proxy);
});

test('createDomain applies inline fixtures, and token, env, flush, and close work', async () => {
  const mock = await startMock();
  const primary = resolveSpec({ tier: 'empty', seed: 'api-fixtures' }).primaryDomain;
  const domain = await mock.createDomain(
    { tier: 'empty', seed: 'api-fixtures' },
    { fixtures: { users: [{ primaryEmail: `x.y@${primary}`, givenName: 'X', familyName: 'Y' }] } },
  );
  const key = mock.credential(domain.customerId, 'read');
  const restore = mock.useInProcess();
  try {
    const directory = admin({
      version: 'directory_v1',
      auth: new JWT({ email: key.client_email, key: key.private_key, subject: domain.adminEmail, scopes: [...READ_SCOPES] }),
    });
    const users = await directory.users.list({ customer: 'my_customer' });
    assert.deepEqual(users.data.users?.map((user) => user.primaryEmail).sort(), [`admin@${primary}`, `x.y@${primary}`]);
  } finally {
    restore();
  }
  assert.match(await mock.token(domain.customerId), /^ya29\.mock\./);
  assert.equal(mock.env().HTTPS_PROXY, mock.proxyUrl);
  assert.ok(await mock.flush(domain.customerId));
  const caFile = mock.caFile;
  await mock.close();
  assert.equal(existsSync(caFile), false);
});

test('proxy false starts no proxy, and useInProcess then throws', async () => {
  const mock = await startMock({ proxy: false });
  assert.equal(mock.proxyUrl, null);
  assert.throws(() => mock.useInProcess(), /The proxy is off/);
  await mock.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test src/index.test.ts`
Expected: FAIL. `startMock` is not exported.

- [ ] **Step 3: Write the API**

Extend `src/index.ts`:

- `startMock(options)`:
  - `dataDir` defaults to `mkdtempSync(join(tmpdir(), 'admin-sdk-mock-'))`, removed by `close()` only when the API created it.
  - Build the file-format object: `{ ...options.config, dataDir, listen: { google: { host: '127.0.0.1', port: 0 }, control: { host: '127.0.0.1', port: 0 }, proxy: options.proxy === false ? null : { host: '127.0.0.1', port: 0, passthrough: options.proxy?.passthrough ?? true }, ...(options.config?.listen as object) }, timing: { scale: 1, delays: false, ...(options.config?.timing as object), ...options.timing } }`.
  - Resolve it with `resolveConfig({ file, fileDir: process.cwd(), env: {}, cwd: process.cwd() })`. The empty `env` keeps a developer's `MOCK_*` variables out of tests.
  - `startServer(config, { log: options.log })`.
- `createDomain(spec, options)`: resolve `fixtures` (a path through `loadFixtures`, or an object through `parseFixtures(value, 'inline fixtures')`), then call `ensureDomain(server.mock, <entry>, server.info().domains.length, {}, now)` with `onStart: 'keep'`, and append the result to the handle's domain list and to `info().domains`.
- `credential(customerId, scopes = 'read-write')`: `issueServiceAccount` plus `setGrant`. It returns the key object without writing a file.
- `token(customerId, options)`: `POST /domains/{id}/tokens` through `control()`.
- `env()`: `clientEnvironment(server.info(), server.controlUrl)`.
- `useInProcess()`: throw `Error('The proxy is off. Start the mock with a proxy to use it in process.')` when the proxy is off. Otherwise register the handle in a module-level list of active handles and recompute: `tls.setDefaultCACertificates([...baseline.ca, ...active.map((h) => h.caCert)])`, and `HTTPS_PROXY` and `https_proxy` set to the last active handle's proxy URL, or restored to the baseline values when no handle is active. Capture the baseline when the list goes from empty to one. Return an idempotent restore function that removes the handle and recomputes.
- `flush(customerId)`: `POST /domains/{id}/index/flush`.
- `control(method, path, body)`: `fetch` against `controlUrl` with JSON. A non-2xx status throws an `Error` holding the status and body.
- `close()`: run the restore, `server.close()`, and remove a temporary data directory. Resolves once.

Re-export the types named in the Interfaces block.

- [ ] **Step 4: Run the checks**

Run: `node --test src/index.test.ts`
Expected: PASS.

Run: `npm run build && node -e "import('./dist/src/index.js').then(async (m) => { const h = await m.startMock(); console.log(typeof h.useInProcess); await h.close(); })"`
Expected: prints `function`.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add startMock() and useInProcess() for in-process tests"
```

---
### Task 8: Image and Compose

**Files:**

- Modify: `Dockerfile`, `.dockerignore`
- Modify: `compose/standalone.yml`
- Create: `compose/with-config.yml`
- Create: `scripts/image-smoke.sh`, `scripts/smoke-config.json`

**Interfaces:**

- Consumes: `bin/admin-sdk-mock.ts start` (Task 6), `MOCK_CONFIG_DEFAULT` (Task 5), `MOCK_PROXY_PORT`, `MOCK_READY_FILE`, `MOCK_CA_EXPORT` (Task 2), `token --raw` (Task 6), `GET /info` (Task 5).
- Produces:
  - The image runs `admin-sdk-mock start`, reads `/config/admin-sdk-mock.json` when mounted, listens on 443, 8080, and 3128 (the proxy port only when the configuration or `MOCK_PROXY_PORT` turns it on), and has `admin-sdk-mock` and `mockctl` on the path.
  - `scripts/image-smoke.sh <image>`: exits 0 when the image starts from a mounted configuration and serves a Google call through its proxy. CI runs it in Task 12.

There is no Docker daemon in the development environment. Write these files carefully; CI runs them. Validate the shell script with `bash -n scripts/image-smoke.sh`.

- [ ] **Step 1: Update the Dockerfile**

Make these changes and keep everything else:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the prepare script builds dist/ with TypeScript, a dev dependency. The image runs the .ts sources directly.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY bin ./bin
COPY schema ./schema
RUN printf '#!/bin/sh\nexec node /app/bin/admin-sdk-mock.ts "$@"\n' > /usr/local/bin/admin-sdk-mock \
 && printf '#!/bin/sh\nexec node /app/bin/mockctl.ts "$@"\n' > /usr/local/bin/mockctl \
 && chmod 755 /usr/local/bin/admin-sdk-mock /usr/local/bin/mockctl
ENV NODE_ENV=production \
    MOCK_DATA_DIR=/data \
    MOCK_GOOGLE_HOST=0.0.0.0 \
    MOCK_GOOGLE_PORT=443 \
    MOCK_CONTROL_PORT=8080 \
    MOCK_CONTROL_HOST=0.0.0.0 \
    MOCK_PROXY_HOST=0.0.0.0 \
    MOCK_CONFIG_DEFAULT=/config/admin-sdk-mock.json
RUN mkdir -p /data /ca-public /config && chown node:node /data /ca-public
USER node
VOLUME ["/data"]
EXPOSE 443 3128 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "bin/admin-sdk-mock.ts", "start"]
```

Add `dist`, `examples`, `docs`, and `test` to `.dockerignore` if they are missing.

The existing CI smoke runs `node bin/mockctl.ts domain create ...` inside the container. That still works.

- [ ] **Step 2: Update Compose**

In `compose/standalone.yml`, add `MOCK_PROXY_PORT: ${MOCK_PROXY_PORT:-3128}` to `environment` and `'127.0.0.1:13128:3128'` to `ports`.

Create `compose/with-config.yml`:

```yaml
# Mount a configuration directory that holds admin-sdk-mock.json:
#   ADMIN_SDK_MOCK_CONFIG_DIR=./my-config docker compose -f compose/standalone.yml -f compose/with-config.yml up --detach --wait
services:
  admin-sdk-mock:
    volumes:
      - ${ADMIN_SDK_MOCK_CONFIG_DIR:?Set ADMIN_SDK_MOCK_CONFIG_DIR to a directory that holds admin-sdk-mock.json}:/config:ro
```

- [ ] **Step 3: Write the image smoke**

Create `scripts/smoke-config.json`:

```json
{
  "domains": [
    {
      "spec": { "tier": "empty", "seed": "image-smoke" },
      "serviceAccounts": [{ "out": "/out/credentials/smoke.json", "scopes": "read" }]
    }
  ]
}
```

Create `scripts/image-smoke.sh`:

```bash
#!/usr/bin/env bash
# Start the image from a mounted configuration and call the Directory API through its proxy.
set -euo pipefail
image="${1:?Usage: scripts/image-smoke.sh <image>}"
work="$(mktemp -d)"
name="admin-sdk-mock-smoke-$$"
cleanup() {
  docker logs "$name" > "$work/container.log" 2>&1 || true
  docker rm -f "$name" > /dev/null 2>&1 || true
}
trap cleanup EXIT
mkdir -p "$work/data" "$work/out"
docker run --detach --name "$name" \
  --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:18081:8080 -p 127.0.0.1:13129:3128 \
  -v "$work/data:/data" -v "$work/out:/out" \
  -v "$(pwd)/scripts/smoke-config.json:/config/admin-sdk-mock.json:ro" \
  -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128 \
  -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json \
  "$image" > /dev/null
for _ in $(seq 1 120); do
  [ -f "$work/out/ready.json" ] && break
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    docker logs "$name"
    exit 1
  fi
  sleep 1
done
[ -f "$work/out/ready.json" ] || { echo "The mock did not become ready."; docker logs "$name"; exit 1; }
customer="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$work/out/ready.json','utf8')).domains[0].customerId)")"
token="$(docker exec "$name" admin-sdk-mock token "$customer" --scopes read --raw)"
status="$(curl --silent --output "$work/users.json" --write-out '%{http_code}' \
  --proxy http://127.0.0.1:13129 --cacert "$work/out/ca.pem" \
  -H "Authorization: Bearer $token" \
  "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer")"
[ "$status" = "200" ] || { echo "users.list answered $status"; cat "$work/users.json"; exit 1; }
grep -q '"primaryEmail"' "$work/users.json"
refused="$(curl --silent --output /dev/null --write-out '%{http_code}' --proxy http://127.0.0.1:13129 https://example.com/ || true)"
[ -f "$work/out/credentials/smoke.json" ] || { echo "The key file is missing."; exit 1; }
echo "image smoke passed (users.list 200, key file written, non-Google CONNECT gave ${refused})"
```

The ready file is the `ready` event, which holds `domains[0].customerId` (Task 5). The last `curl` checks that the proxy refuses a non-Google target. curl reports the CONNECT refusal as status `000` or `403` depending on its version, so the script prints it and does not fail on it.

Make the script executable: `chmod 755 scripts/image-smoke.sh`.

- [ ] **Step 4: Run the local checks and commit**

Run: `bash -n scripts/image-smoke.sh && npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass. Report in the task report that the image and the smoke script run only in CI.

```bash
git add -A
git commit -m "feat: run the image from a mounted configuration with the proxy and the new CLI"
```

---

### Task 9: Examples and their runners

**Files:**

- Create: `examples/README.md`
- Create: `examples/node-in-process/README.md`, `examples/node-in-process/directory.test.mjs`
- Create: `examples/node-cli/README.md`, `examples/node-cli/admin-sdk-mock.json`, `examples/node-cli/list-users.mjs`
- Create: `examples/python/README.md`, `examples/python/requirements.txt`, `examples/python/list_users.py`
- Create: `examples/curl/README.md`, `examples/curl/list-users.sh`
- Create: `examples/fixtures/README.md`, `examples/fixtures/fixtures.json`, `examples/fixtures/fixtures.test.mjs`
- Create: `test/examples/run.ts`, `test/python/run.ts`

**Interfaces:**

- Consumes: the built package (`npm run build`) resolved by its own name `@campuscommander/admin-sdk-mock` through `exports`; `startMock()`, `useInProcess()` (Task 7); `dist/bin/admin-sdk-mock.js` (`start`, `env`, `token`) (Task 6); `startServer()`, `clientEnvironment()` (Task 5).
- Produces: `npm run test:examples` runs the node-in-process, node-cli, curl, and fixtures examples. `npm run test:python` runs the Python example.

Examples import the package by name, as a consumer would. Node resolves a package's own name through its `exports` from inside the repository, so `npm run build` is the only setup.

- [ ] **Step 1: Write the examples**

`examples/node-in-process/directory.test.mjs` is a complete `node:test` file that:
- starts `startMock({ config: { domains: [{ spec: { tier: 'small', seed: 'example', counts: { schools: 1, students: 30, staff: 5, devices: 10 } } }] } })`,
- calls `useInProcess()`,
- builds the `@googleapis/admin` client with a `google-auth-library` `JWT` from `mock.credential(customerId, 'read-write')` and the domain's `adminEmail`,
- lists users, Chrome devices, and groups, and asserts each list is non-empty,
- inserts a group and reads it back with `groups.get`,
- closes the mock in `after()`.

`examples/node-cli/admin-sdk-mock.json`:

```json
{
  "$schema": "../../schema/config.schema.json",
  "dataDir": "./.admin-sdk-mock/data",
  "listen": { "proxy": { "port": 3128 } },
  "domains": [
    {
      "spec": { "tier": "small", "seed": "example" },
      "serviceAccounts": [{ "out": "./.admin-sdk-mock/credentials/example.json", "scopes": "read" }]
    }
  ]
}
```

`examples/node-cli/list-users.mjs` reads the key file from `GOOGLE_APPLICATION_CREDENTIALS` and the subject from `ADMIN_SUBJECT`, lists 5 users with the unmodified client, and prints one primary email per line. It exits 1 with a clear message when either variable is missing.

`examples/python/requirements.txt`:

```text
google-api-python-client>=2.150
google-auth>=2.35
google-auth-httplib2>=0.2
PySocks>=1.7
```

PySocks is required: `httplib2` tunnels through an HTTP proxy only with it.

`examples/python/list_users.py` reads `GOOGLE_APPLICATION_CREDENTIALS` and `ADMIN_SUBJECT`, builds `service_account.Credentials.from_service_account_file(path, scopes=["https://www.googleapis.com/auth/admin.directory.user.readonly"], subject=subject)`, calls `build("admin", "directory_v1", credentials=credentials, static_discovery=True).users().list(customer="my_customer", maxResults=5).execute()`, and prints one primary email per line.

`examples/curl/list-users.sh` takes the customer ID as its argument, gets a token with `admin-sdk-mock token "$1" --scopes read --raw`, and calls `users.list` with `curl --proxy "$HTTPS_PROXY" --cacert "$NODE_EXTRA_CA_CERTS"`, printing the response. It uses `set -euo pipefail`. Make it executable.

`examples/fixtures/fixtures.json` declares two OUs, three users (one admin, one suspended), two devices, and two groups with members, on the primary domain of `{ "tier": "empty", "seed": "fixtures-example" }`. Compute that domain once with `resolveSpec()` and write it literally into the file. `examples/fixtures/fixtures.test.mjs` starts `startMock({ config: { domains: [{ spec: { tier: 'empty', seed: 'fixtures-example' }, fixtures: 'examples/fixtures/fixtures.json' }] } })` and asserts the exact users, devices, and group members through the Google client.

Each README states: what the example shows, the prerequisites, the exact commands, and the expected output. Follow the writing rules.

- [ ] **Step 2: Write the runners**

`test/examples/run.ts`:
1. Run `node --test examples/node-in-process/directory.test.mjs examples/fixtures/fixtures.test.mjs` and require exit code 0.
2. node-cli: spawn `node dist/bin/admin-sdk-mock.js start --config examples/node-cli/admin-sdk-mock.json --data-dir <tmp> --google-port 0 --control-port 0 --proxy-port 0`, wait for the `ready` line on standard output, read the control port from it, get the environment with `node dist/bin/admin-sdk-mock.js env --control http://127.0.0.1:<port> --format json`, then run `node examples/node-cli/list-users.mjs` with that environment plus `GOOGLE_APPLICATION_CREDENTIALS` (the key file in the ready event) and `ADMIN_SUBJECT`. Require 5 printed emails. `--data-dir` overrides the file's data directory, but the key path in the file still resolves against the file, so write the key under the example directory and remove `examples/node-cli/.admin-sdk-mock/` afterwards.
3. curl: with the same running mock and environment, run `bash examples/curl/list-users.sh <customerId>` with `PATH` extended by a directory holding an `admin-sdk-mock` wrapper script that runs `node dist/bin/admin-sdk-mock.js "$@"` with `MOCK_CONTROL_URL` set. Require `"primaryEmail"` in the output. Skip this step with a printed notice when `curl` is not on the path.
4. Stop the mock with `SIGTERM`. Print one summary line per example and exit 1 if any failed.

`test/python/run.ts`:
1. Check `${PYTHON ?? 'python3'} -c "import googleapiclient, google.oauth2, google_auth_httplib2, socks"`. On failure, print `Install examples/python/requirements.txt into the active Python first.` and exit 1.
2. Start the mock in-process with `startServer(resolveConfig({ cwd: <tmp>, file: { dataDir: '<tmp>/data', listen: { google: { port: 0 }, control: { port: 0 }, proxy: { port: 0 } }, domains: [{ spec: { tier: 'small', seed: 'python', counts: { schools: 1, students: 20, staff: 5, devices: 5 } }, serviceAccounts: [{ out: '<tmp>/key.json', scopes: 'read' }] }] } }))`.
3. Run `python examples/python/list_users.py` with `clientEnvironment(info, controlUrl)`, `GOOGLE_APPLICATION_CREDENTIALS`, and `ADMIN_SUBJECT`.
4. Require exit code 0 and 5 printed emails, and require that the proxy accepted at least one CONNECT and refused none. Close the server and exit with the result.

- [ ] **Step 3: Run them**

Run: `npm run test:examples`
Expected: every example passes.

Run: `python3 -m venv /tmp/claude-1000/-home-seaston-projects-campus-commander/95116797-5b92-4993-90bb-de626b405fa6/scratchpad/venv && /tmp/claude-1000/-home-seaston-projects-campus-commander/95116797-5b92-4993-90bb-de626b405fa6/scratchpad/venv/bin/pip install -r examples/python/requirements.txt && PYTHON=/tmp/claude-1000/-home-seaston-projects-campus-commander/95116797-5b92-4993-90bb-de626b405fa6/scratchpad/venv/bin/python npm run test:python`
Expected: PASS. If PyPI is unreachable, report it and rely on CI.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass. ESLint covers the `.mjs` examples.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add runnable Node, Python, curl, and fixtures examples with runners"
```

---

### Task 10: The package install test

**Files:**

- Create: `test/package/run.ts`

**Interfaces:**

- Consumes: `npm pack` (which runs `prepare`, so `dist/` builds), the CLI (Task 6), the API (Task 7).
- Produces: `npm run test:package` exits 0 when the packed tarball installs into an empty project and works.

- [ ] **Step 1: Write the test**

`test/package/run.ts` runs these steps in a temporary directory, printing one line per step and exiting 1 at the first failure (with the failing command's output):

1. `npm pack --pack-destination <tmp>` in the repository. Record the tarball path.
2. In `<tmp>/consumer`: write `{ "name": "consumer", "private": true, "type": "module" }` to `package.json`, then `npm install <tarball> @googleapis/admin@<version from the repo's package.json> google-auth-library@<version> @types/node@<version> typescript@<version> --no-audit --no-fund`.
3. Assert `node_modules/@campuscommander/admin-sdk-mock/` holds `dist/src/index.js`, `dist/src/index.d.ts`, `dist/bin/admin-sdk-mock.js`, `schema/config.schema.json`, `README.md`, and `CHANGELOG.md`, and holds no `src/` directory, no `test/` directory, and no `*.test.js` file.
4. `npx admin-sdk-mock --help` and `npx mockctl --help` exit 0.
5. Write a configuration (ports 0, a proxy, one small domain, one read key) and run `npx admin-sdk-mock config validate admin-sdk-mock.json`: exit 0.
6. Spawn `npx admin-sdk-mock start --config admin-sdk-mock.json`, wait for the `ready` line, get the environment with `npx admin-sdk-mock env --control <url> --format json`, and run a `cli-client.mjs` that lists users with `@googleapis/admin` through that environment. Stop the mock.
7. Run an `api-client.mjs` that imports `startMock` from `@campuscommander/admin-sdk-mock`, calls `useInProcess()`, and lists users.
8. Write `consumer.ts`:

```ts
import { startMock, type MockHandle, type MockOptions } from '@campuscommander/admin-sdk-mock';

const options: MockOptions = { proxy: { passthrough: true } };
const handle: MockHandle = await startMock(options);
const restore: () => void = handle.useInProcess();
restore();
await handle.close();
```

  and run `npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2024 --types node consumer.ts`: exit 0.
9. Remove the temporary directory.

Add `Task 10 note:` comments in the file for the one path it cannot test: installing from the private Git repository needs repository access, so the test packs the same files instead.

- [ ] **Step 2: Run it**

Run: `npm run test:package`
Expected: every step passes. It needs the npm registry for the consumer's dependencies.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: prove the packed package installs, runs its CLI, and types its API"
```

---

### Task 11: The GitHub Action

**Files:**

- Create: `action.yml`
- Create: `examples/github-actions/README.md`, `examples/github-actions/admin-sdk-mock.json`, `examples/github-actions/workflow.yml`

**Interfaces:**

- Consumes: the image behavior of Task 8.
- Produces: a composite action with inputs `config`, `image`, `workdir`, `control-port`, `proxy-port`, and outputs `workdir`, `ca-file`, `ca-bundle-file`, `proxy-url`, `control-url`. Task 12's `action` job uses it with `uses: ./`.

- [ ] **Step 1: Write the action**

Create `action.yml`:

```yaml
name: Admin SDK mock
description: Start the Admin SDK mock and export a client environment that routes Google API calls to it.
inputs:
  config:
    description: Path to an admin-sdk-mock.json file in the repository. Write key file paths under /out, for example /out/credentials/ci.json.
    required: false
    default: ''
  image:
    description: The image to run. A private image needs docker login first.
    required: false
    default: ghcr.io/campuscommander/admin-sdk-mock:main
  workdir:
    description: The host directory for data and output files.
    required: false
    default: ''
  control-port:
    description: The host port for the control API.
    required: false
    default: '18080'
  proxy-port:
    description: The host port for the proxy.
    required: false
    default: '13128'
outputs:
  workdir:
    description: The host directory. Files written under /out in the container land in <workdir>/out.
    value: ${{ steps.start.outputs.workdir }}
  ca-file:
    description: The mock CA certificate.
    value: ${{ steps.start.outputs.ca-file }}
  ca-bundle-file:
    description: The mock CA followed by the public roots.
    value: ${{ steps.start.outputs.ca-bundle-file }}
  proxy-url:
    description: The proxy URL.
    value: ${{ steps.start.outputs.proxy-url }}
  control-url:
    description: The control API URL.
    value: ${{ steps.start.outputs.control-url }}
runs:
  using: composite
  steps:
    - id: start
      shell: bash
      env:
        INPUT_CONFIG: ${{ inputs.config }}
        INPUT_IMAGE: ${{ inputs.image }}
        INPUT_WORKDIR: ${{ inputs.workdir }}
        CONTROL_PORT: ${{ inputs.control-port }}
        PROXY_PORT: ${{ inputs.proxy-port }}
      run: |
        set -euo pipefail
        workdir="${INPUT_WORKDIR:-$RUNNER_TEMP/admin-sdk-mock}"
        mkdir -p "$workdir/data" "$workdir/out"
        args=(--detach --name admin-sdk-mock --user "$(id -u):$(id -g)"
          -p "127.0.0.1:${CONTROL_PORT}:8080" -p "127.0.0.1:${PROXY_PORT}:3128"
          -v "$workdir/data:/data" -v "$workdir/out:/out"
          -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128
          -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json)
        if [ -n "$INPUT_CONFIG" ]; then
          args+=(-v "$(realpath "$INPUT_CONFIG"):/config/admin-sdk-mock.json:ro")
        fi
        docker run "${args[@]}" "$INPUT_IMAGE" > /dev/null
        for _ in $(seq 1 600); do
          [ -f "$workdir/out/ready.json" ] && break
          if [ "$(docker inspect -f '{{.State.Running}}' admin-sdk-mock)" != "true" ]; then
            docker logs admin-sdk-mock
            exit 1
          fi
          sleep 1
        done
        if [ ! -f "$workdir/out/ready.json" ]; then
          echo "::error::The Admin SDK mock did not become ready."
          docker logs admin-sdk-mock
          exit 1
        fi
        proxy="http://127.0.0.1:${PROXY_PORT}"
        control="http://127.0.0.1:${CONTROL_PORT}"
        {
          echo "HTTPS_PROXY=$proxy"
          echo "https_proxy=$proxy"
          echo "NO_PROXY=localhost,127.0.0.1,::1"
          echo "no_proxy=localhost,127.0.0.1,::1"
          echo "NODE_EXTRA_CA_CERTS=$workdir/out/ca.pem"
          echo "SSL_CERT_FILE=$workdir/out/ca-bundle.pem"
          echo "REQUESTS_CA_BUNDLE=$workdir/out/ca-bundle.pem"
          echo "HTTPLIB2_CA_CERTS=$workdir/out/ca-bundle.pem"
          echo "CURL_CA_BUNDLE=$workdir/out/ca-bundle.pem"
          echo "ADMIN_SDK_MOCK_CONTROL=$control"
        } >> "$GITHUB_ENV"
        {
          echo "workdir=$workdir"
          echo "ca-file=$workdir/out/ca.pem"
          echo "ca-bundle-file=$workdir/out/ca-bundle.pem"
          echo "proxy-url=$proxy"
          echo "control-url=$control"
        } >> "$GITHUB_OUTPUT"
```

The bundle file is `ca-bundle.pem` beside `MOCK_CA_EXPORT`, as Task 5 writes it.

- [ ] **Step 2: Write the example workflow**

`examples/github-actions/admin-sdk-mock.json` declares one small domain with a read-write key at `/out/credentials/ci.json`.
`examples/github-actions/workflow.yml` is a complete consumer workflow:
- checkout,
- `docker/login-action@v3` to `ghcr.io` with `GITHUB_TOKEN` (the image is private),
- `uses: CampusCommander/admin-sdk-mock@v1.0.0` with `id: mock` and the configuration,
- a test step that reads `${{ steps.mock.outputs.workdir }}/out/credentials/ci.json` and runs the application's tests.
`examples/github-actions/README.md` explains the inputs, the outputs, the `/out` path rule, the private-image login, and the `uses: ./` form for this repository.

- [ ] **Step 3: Check and commit**

There is no runner here. Check the YAML parses: `node -e "JSON.stringify(require('node:fs').readFileSync('action.yml','utf8'))"` is not a parser, so review the indentation by eye and rely on Task 12's `action` job.

Run: `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass. Prettier formats YAML. Run `npm run format` first.

```bash
git add -A
git commit -m "feat: add a GitHub composite action that starts the mock and exports the client environment"
```

---

### Task 12: CI, release, and the coverage gate

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Modify: `package.json` (the `test:coverage` thresholds only)

**Interfaces:**

- Consumes: every npm script from Task 1, `scripts/image-smoke.sh` (Task 8), `action.yml` (Task 11), `examples/github-actions/admin-sdk-mock.json` and `examples/node-cli/list-users.mjs` (Tasks 9 and 11).
- Produces: CI jobs `check`, `python`, `package`, `image`, `action`, `scale`. A tag-triggered `release` workflow.

- [ ] **Step 1: Measure and set the coverage gate**

Run: `npm run test:coverage 2>&1 | tail -40`
Read the `all files` row: line, branch, and function percentages. Set each threshold to the measured value rounded down to a whole percent. The line threshold must be at least 85. If it is below 85, stop and report the measured values instead of lowering the gate.
Append to the `test:coverage` script: `--test-coverage-lines=<L> --test-coverage-branches=<B> --test-coverage-functions=<F>`.
Run it again and confirm it passes.

- [ ] **Step 2: Update CI**

In `.github/workflows/ci.yml`:

- `check`: replace `- run: npm test` with `- run: npm run test:coverage`, and add `- run: npm run test:examples` after `test:compat`.
- Add a `python` job (`needs: [check]`): checkout, setup-node from `.nvmrc` with npm cache, `npm ci`, `actions/setup-python@v6` with `python-version: '3.12'`, `python -m pip install -r examples/python/requirements.txt`, `npm run test:python`.
- Add a `package` job (`needs: [check]`): checkout, setup-node, `npm ci`, `npm run test:package`.
- `image`: after the existing overlay smoke, add `- name: Smoke-test a mounted configuration and the proxy` running `bash scripts/image-smoke.sh admin-sdk-mock:ci`.
- Add an `action` job (`needs: [check]`): checkout, `docker build -t admin-sdk-mock:ci .`, `uses: ./` with `id: mock`, `image: admin-sdk-mock:ci`, and `config: examples/github-actions/admin-sdk-mock.json`, then setup-node and `npm ci`, then run `node examples/node-cli/list-users.mjs` with `GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.mock.outputs.workdir }}/out/credentials/ci.json` and `ADMIN_SUBJECT` set to `admin@` plus the primary domain of the example's seed specification. Compute that domain once with `resolveSpec()` and write it literally. Finish with `docker logs admin-sdk-mock` on failure.

Keep every existing step, the concurrency block, and the permissions.

- [ ] **Step 3: Write the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: release

on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run format:check
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:coverage
      - run: npm run test:contract
      - run: npm run test:compat
      - run: npm run test:package
      - name: The tag matches package.json
        run: test "v$(node -p "require('./package.json').version")" = "${GITHUB_REF_NAME}"
  publish:
    runs-on: ubuntu-24.04
    needs: [verify]
    permissions:
      contents: write
      packages: write
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm pack
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build and push the versioned image
        run: |
          set -euo pipefail
          version="${GITHUB_REF_NAME#v}"
          docker build -t admin-sdk-mock:release .
          for tag in "$version" "${version%.*}"; do
            docker tag admin-sdk-mock:release "ghcr.io/campuscommander/admin-sdk-mock:${tag}"
            docker push "ghcr.io/campuscommander/admin-sdk-mock:${tag}"
          done
      - name: Create the GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          version="${GITHUB_REF_NAME#v}"
          awk -v v="$version" '$0 ~ "^## \\[" v "\\]" {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md > release-notes.md
          gh release create "$GITHUB_REF_NAME" campuscommander-admin-sdk-mock-*.tgz --title "$GITHUB_REF_NAME" --notes-file release-notes.md
```

No tag is pushed by this plan. The owner tags a release.

- [ ] **Step 4: Check and commit**

Run: `npm run format && npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass.

```bash
git add -A
git commit -m "ci: gate coverage, run examples, Python, package, image, and action jobs, and add the release workflow"
```

---

### Task 13: Documentation

**Files:**

- Create: `src/docs/generate.ts`, `src/docs/generate.test.ts`, `scripts/docs.ts`
- Create: `docs/reference/configuration.md`, `docs/reference/cli.md`, `docs/reference/api-coverage.md`
- Create: `docs/guide/installation.md`, `docs/guide/configuration.md`, `docs/guide/clients.md`, `docs/guide/testing.md`, `docs/guide/ci.md`, `docs/guide/behavior.md`, `docs/guide/troubleshooting.md`
- Create: `docs/trust.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE.md`
- Modify: `README.md`, `docs/specs/2026-10-10-productization-design.md` (status line only)

**Interfaces:**

- Consumes: `CONFIG_SCHEMA` (Task 2), `HELP` (Task 6), `buildRoutes()` (`src/routes.ts`), every earlier task's behavior.
- Produces:
  - `renderConfigReference(schema): string`, `renderCliReference(help): string`, `renderApiCoverage(routes): string`, and `replaceGenerated(markdown: string, name: string, content: string): string` in `src/docs/generate.ts`.
  - `npm run docs` rewrites the three generated sections.

- [ ] **Step 1: Write the generator and its sync test**

`src/docs/generate.ts`:
- `renderConfigReference(schema)` walks the schema, including `$defs` reached through `$ref`, and emits one Markdown table row per key path (`dataDir`, `listen.google.host`, `domains[].spec.tier`, `domains[].serviceAccounts[].scopes`, and so on) with the columns Key, Type, Default, and Description. A type column reads `string`, `integer 0–65535`, `one of: keep, reset`, `null or object`, and so on.
- `renderCliReference(help)` emits one `## <command>` section per `HELP` key (the top-level usage first), each with its usage in a `text` code block.
- `renderApiCoverage(routes)` emits one row per route: the route ID (for example `directory.groups.list`), the HTTP methods, the host or hosts, and the path pattern with named groups shown as `{name}`. Derive the path from the route's `pattern.source`: strip `^` and `$`, replace `(?<name>...)` groups with `{name}`, and unescape `\/` and `\.`. Sort by route ID.
- `replaceGenerated(markdown, name, content)` replaces the text between `<!-- generated:start <name> -->` and `<!-- generated:end <name> -->`. It throws when the markers are missing.

`scripts/docs.ts` writes the three sections into `docs/reference/configuration.md` (name `configuration`), `docs/reference/cli.md` (name `cli`), and `docs/reference/api-coverage.md` (name `api-coverage`), then runs Prettier on those files through `node_modules/.bin/prettier --write`.

`src/docs/generate.test.ts` asserts, for each of the three files, that `replaceGenerated(file, name, render(...))` piped through Prettier's API equals the file on disk. Import Prettier from `prettier` (a dev dependency already). It also asserts that every route ID from `buildRoutes()` appears in `docs/reference/api-coverage.md`.

- [ ] **Step 2: Write the reference pages**

Each reference page has a short introduction above its markers and nothing generated outside them. `docs/reference/api-coverage.md` also has, below its generated table, a hand-written section per resource that lists the supported parameters and links to the rulings in `docs/calibration.md`.

Run `npm run docs` to fill the generated sections.

- [ ] **Step 3: Write the guides and the repository documents**

Write each file with the content the spec's Documentation table assigns to it. Required content:

- `README.md`: one paragraph on what the mock is, then three quickstarts that work as written:
  - npm: `npm install --save-dev github:CampusCommander/admin-sdk-mock#v1.0.0`, `npx admin-sdk-mock init`, `npx admin-sdk-mock start`, then in another shell `eval "$(npx admin-sdk-mock env)"` and a client command.
  - Docker: `docker run` with the proxy port, a mounted configuration, and `/out`, then the client environment.
  - GitHub Actions: the `uses:` block.
  Then the documentation map, the supported API surface in one sentence each, the status line (milestones 1–3 and v1.0), and the Campus Commander link. Keep the existing Campus Commander and Control API safety content, moved into the guides where they fit.
- `docs/guide/installation.md`: prerequisites (Node 24.11 or later, or Docker), the three install paths, private repository access (`gh auth setup-git` or a deploy token), upgrades by tag, and uninstalling.
- `docs/guide/configuration.md`: the file, the lookup order, precedence with a worked example, domains (`keep` and `reset`), settings, service accounts and the `read`/`read-write` words, faults, fixtures (with a complete example), and the environment variables.
- `docs/guide/clients.md`: how a client reaches the mock (proxy plus CA), the variable each client stack reads (`NODE_EXTRA_CA_CERTS` for Node, `REQUESTS_CA_BUNDLE` and `HTTPLIB2_CA_CERTS` and PySocks for Python, `SSL_CERT_FILE` for OpenSSL clients, `CURL_CA_BUNDLE` for curl, a Java truststore import, `SSL_CERT_FILE` for Go), why the bundle file holds the public roots too, `NO_PROXY`, and the hosts-file alternative with port 443.
- `docs/guide/testing.md`: `startMock()` and `useInProcess()` with a complete `node:test` example, fixtures, `delays: false` and the time scale, `flush()` for the search delay, faults, and test tokens.
- `docs/guide/ci.md`: the action and its inputs and outputs, other CI systems through `docker run` with the same flags the action uses, and caching nothing (seeds are deterministic).
- `docs/guide/behavior.md`: quota and flags, latency, the search lag, the nesting and ready delays, write limits, and the link to every ruling in `docs/calibration.md`.
- `docs/guide/troubleshooting.md`: at least these symptoms with cause and fix: certificate errors, `403` from the proxy, connection refused, `401 unauthorized_client`, `403 Not Authorized`, a list missing a recent write, a port in use, a `keep` restart error, and a slow `xlarge` seed.
- `docs/trust.md`: the spec's test-layer table with the command for each, then a requirement map: one row per acceptance item of every spec (milestones 1–3 and productization) naming the test files that prove it. Name only files that exist.
- `CHANGELOG.md`: Keep a Changelog format with a `## [1.0.0] - 2026-10-10` entry (Added: configuration, proxy, CLI, API, fixtures, the `empty` tier, image configuration, the action, examples, documentation, the package and coverage tests), and a history line for milestones 1 to 3.
- `CONTRIBUTING.md`: the development commands, the test layers, the writing rules, the commit trailer, and that `main` takes merges directly.
- `SECURITY.md`: the security section of the spec, and reporting to the repository owner.
- `LICENSE.md`: `Copyright 2026 CampusCommander. All rights reserved.` and one sentence that the software is internal test infrastructure licensed for use by CampusCommander only.

Change the productization spec's status line to `Status: written under the owner's autonomy grant of 2026-10-10 and implemented as version 1.0.0. Awaiting owner review.`

- [ ] **Step 4: Run the checks and commit**

Run: `npm run docs && npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: all pass, including `src/docs/generate.test.ts`.

```bash
git add -A
git commit -m "docs: write the guides, generated references, trust map, changelog, and repository documents"
```
