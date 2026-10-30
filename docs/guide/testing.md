# Testing

This guide shows how a test suite drives the mock: in process with `startMock()`, or as a separate process through the CLI and the control API.

## Start the mock in process

`startMock(options?)` starts the Google listener, the control listener, and the proxy inside the test process. Each listener takes a free port.

| Option    | Default                       | Meaning                                                                                 |
| --------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| `dataDir` | A fresh temporary directory   | The data directory. `close()` removes a temporary one and keeps one that you pass.      |
| `config`  | `{}`                          | A configuration object in the file format. Listener ports default to 0.                 |
| `proxy`   | `{ passthrough: true }`       | The proxy. `false` starts none. Passthrough keeps the test's other HTTPS calls working. |
| `timing`  | `{ scale: 1, delays: false }` | The time scale and the latency switch. Tests run without modeled latency by default.    |
| `log`     | none                          | A function that receives each log event, such as `ready` and `proxy-refused`.           |

The handle has these members:

| Member                                | Meaning                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `googleUrl`, `controlUrl`, `proxyUrl` | The listener URLs. `proxyUrl` is `null` without a proxy.                                                       |
| `caCert`, `caFile`, `caBundleFile`    | The CA certificate PEM, its file, and the bundle file with the public roots.                                   |
| `domains`                             | The domains: `customerId`, `primaryDomain`, `adminEmail`, `action`, and `serviceAccounts`.                     |
| `createDomain(spec, options?)`        | Seed one more domain. `options` takes `settings`, which merge after `defaults.settings`, and `fixtures`.       |
| `credential(customerId, scopes?)`     | Issue a service account and return its key object. `scopes` defaults to `'read-write'`.                        |
| `token(customerId, options?)`         | Mint an access token. `options` takes `subject`, `scopes`, and `ttlSeconds`.                                   |
| `env()`                               | The client environment for a child process.                                                                    |
| `useInProcess()`                      | Trust the mock CA and set `HTTPS_PROXY` and `NO_PROXY` in this process. Returns a function that restores them. |
| `flush(customerId)`                   | End the search lag and the group delays of a domain.                                                           |
| `control(method, path, body?)`        | Any control API call. It returns the parsed JSON body, and it throws on a non-2xx status.                      |
| `close()`                             | Stop the listeners, undo every `useInProcess()`, and remove a temporary data directory.                        |

`useInProcess()` throws when the proxy is off or the mock is closed.
It routes Google's clients, which read `HTTPS_PROXY` on every request. Built-in `fetch` in the test process still skips the proxy.
Node reads `NODE_USE_ENV_PROXY` only at startup, so run a `fetch` client in a child process with `env()`.
`createDomain()` on a domain that exists keeps its data, but resets its settings and removes its faults.

### A complete test

This `node:test` file uses the unmodified `@googleapis/admin` client. Install `@googleapis/admin` and `google-auth-library` beside the mock.

```js
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { admin } from '@googleapis/admin';
import { JWT } from 'google-auth-library';
import { READ_WRITE_SCOPES, startMock } from '@campuscommander/admin-sdk-mock';

const DOMAIN = 'example-district.test';
let mock;
let domain;
let directory;

before(async () => {
  mock = await startMock();
  mock.useInProcess();
  domain = await mock.createDomain(
    { tier: 'empty', seed: 'unit-tests', name: 'Example District' },
    {
      fixtures: {
        users: [
          {
            primaryEmail: `ana.rivera@${DOMAIN}`,
            givenName: 'Ana',
            familyName: 'Rivera',
          },
        ],
      },
    },
  );
  const key = mock.credential(domain.customerId, 'read-write');
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...READ_WRITE_SCOPES],
    subject: domain.adminEmail,
  });
  directory = admin({ version: 'directory_v1', auth });
});

after(() => mock?.close());

const listEmails = async () => {
  const { data } = await directory.users.list({ customer: 'my_customer' });
  return data.users.map((user) => user.primaryEmail);
};

test('the domain holds the fixture user and the administrator', async () => {
  assert.deepEqual(await listEmails(), [
    `admin@${DOMAIN}`,
    `ana.rivera@${DOMAIN}`,
  ]);
});

test('a new user reaches lists after a flush', async () => {
  await directory.users.insert({
    requestBody: {
      primaryEmail: `bo.chen@${DOMAIN}`,
      name: { givenName: 'Bo', familyName: 'Chen' },
      password: 'an-example-password',
    },
  });
  assert.equal((await listEmails()).length, 2);
  await mock.flush(domain.customerId);
  assert.equal((await listEmails()).length, 3);
});

test('a remove-entity fault hides a user', async () => {
  const path = `/domains/${domain.customerId}/faults`;
  await mock.control('POST', path, {
    kind: 'remove-entity',
    entityId: `ana.rivera@${DOMAIN}`,
  });
  await assert.rejects(
    directory.users.get({ userKey: `ana.rivera@${DOMAIN}` }),
    { status: 404 },
  );
  await mock.control('DELETE', path);
});
```

Run it with `node --test`.

- `useInProcess()` makes the unmodified client reach the mock. `close()` undoes it.
- The `empty` tier with a `name` fixes the domain name, so the test can name exact addresses.
- `credential()` issues a real key, and the client runs the full JWT exchange against the mock.
- The second test shows the search lag: the new user stays out of lists until `flush()`.

The [node-in-process example](../../examples/node-in-process) is a second complete suite.

### Child processes

A test that runs its client in a child process passes the client environment:

```js
import { execFile } from 'node:child_process';

execFile('node', ['client.mjs'], { env: { ...process.env, ...mock.env() } });
```

## Fixtures

`createDomain(spec, { fixtures })` takes a fixtures object or a path to a fixtures file. A relative path resolves against the working directory.
A configuration object passed to `startMock({ config })` takes `domains[].fixtures` as a path. There, too, a relative path resolves against the working directory.

```js
const domain = await mock.createDomain(
  { tier: 'empty', seed: 'groups-test', name: 'Example District' },
  { fixtures: './test/fixtures/groups.json' },
);
```

Pair fixtures with the `empty` tier to control every entity. The [configuration guide](configuration.md#fixtures) lists every field and rule.
A fixtures error throws, and the domain is not created.

## Time

`delays: false`, the `startMock()` default, removes the modeled latency of each response.
It leaves the search lag, the nesting delay, the ready delay, and the command timeline in place. The [behavior guide](behavior.md) describes each one.

Remove a delay in one of three ways:

- Call `flush(customerId)` after the writes. It ends every pending lag and group delay at once.
- Set the delay to 0 for the domain: `createDomain(spec, { settings: { writes: { searchDelaySeconds: 0 } } })`.
- Compress time. The time scale divides every quota window, flag, delay, and timeline.

```js
const mock = await startMock({ timing: { scale: 60 } });
await mock.control('PUT', '/clock', { scale: 600, delays: true });
```

At scale 60, the 300-second search lag lasts 5 seconds and one quota minute lasts one second.
The scale applies to the whole mock. A change of scale starts fresh quota buckets.

## Flush

`flush(customerId)` calls `POST /domains/<customerId>/index/flush`. It answers `{ "flushed": <rows>, "delaysEnded": <links> }`.

- Every pending write becomes visible to lists.
- Every device command that is due settles, so lists show its side effects.
- Every pending nesting delay and ready delay ends.

The CLI form is `admin-sdk-mock index flush <customerId>`.

## Faults

Add a fault rule through the control API, and clear the rules when the test ends:

```js
const faults = `/domains/${domain.customerId}/faults`;
await mock.control('POST', faults, {
  kind: 'status',
  method: 'directory.users.list',
  status: 503,
  reason: 'backendError',
  count: 2,
});
// The next two users.list calls answer 503. A client with retries recovers on the third.
await mock.control('DELETE', faults);
```

A quota test lowers the quota instead of sending thousands of calls:

```js
await mock.control('PUT', `/domains/${domain.customerId}/settings`, {
  quota: { perMinute: 10 },
});
```

The [configuration guide](configuration.md#faults) lists every fault kind and field.

## Test tokens

`token(customerId, options?)` mints an access token without the JWT exchange. It suits a test of the client's API calls, not of its sign-in.

```js
const accessToken = await mock.token(domain.customerId, { scopes: 'read' });
```

| Option    | Default                  | Meaning                                            |
| --------- | ------------------------ | -------------------------------------------------- |
| `subject` | `admin@<primary domain>` | The domain user that the token acts for.           |
| `scopes`  | `'read-write'`           | `'read'`, `'read-write'`, or a list of scope URLs. |

The token lives 3600 seconds. The control API and the CLI also accept a lifetime:

```sh
npx admin-sdk-mock token <customerId> --subject teacher@example-district.test --scopes read --ttl 600 --raw
```

`POST /domains/<customerId>/tokens` takes `subject`, `scopes`, and `ttlSeconds` from 1 to 3600, and answers `access_token`, `token_type`, `expires_in`, and `scope`.
A subject that names no user of the domain answers `400`.
Every minted token carries the project `admin-sdk-mock-control`. Its quota bucket is that project and its subject.

A test of the sign-in itself uses `credential()` and a real Google client, as the complete test above does.

## Drive a running mock from the shell

The control commands work against any running mock: the CLI, the image, or a test's `controlUrl` through `--control`.
`mockctl` runs the same commands as `admin-sdk-mock`.

```sh
npx admin-sdk-mock domain create --tier small --seed demo
npx admin-sdk-mock credential <customerId> --scopes read-write --out ./demo-credential.json
npx admin-sdk-mock quota <customerId>
npx admin-sdk-mock clock --scale 60
npx admin-sdk-mock clock --delays off
npx admin-sdk-mock fault add <customerId> --json '{"kind":"status","status":503,"reason":"backendError","count":3}'
npx admin-sdk-mock index flush <customerId>
```

`domain create` prints the `customerId` and the `adminEmail`. Delegate to that `adminEmail`.
`credential` grants the `read` scopes by default. `--scopes` takes `read`, `read-write`, or a comma-separated list of scope URLs.
`quota` shows the quota buckets, the flag state, and the in-flight requests.
`clock --scale 60` compresses every quota window, flag, and delay by 60. `clock --delays off` removes the modeled latency.

The [CLI reference](../reference/cli.md) lists every command and flag.

## The control API

The control listener serves plain HTTP on `127.0.0.1:8080` by default.
Every request and response body is JSON, except `GET /ca.pem`, which returns the CA certificate as PEM.

| Request                                       | Effect                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                 | `503` with `{ "status": "starting" }` until every domain is ready, then `200` with `{ "status": "ok", "domains": <count> }`. |
| `GET /info`                                   | The version, `ready`, the listeners, `caFile`, `caBundleFile`, `dataDir`, and the configured domains.                        |
| `GET /ca.pem`                                 | The CA certificate.                                                                                                          |
| `GET /clock`, `PUT /clock`                    | Show or set `scale` (1 to 100000) and `delays`.                                                                              |
| `GET /domains`                                | Every domain with its `counts`.                                                                                              |
| `POST /domains`                               | Create a domain from a seed specification.                                                                                   |
| `GET /domains/{id}`, `DELETE /domains/{id}`   | Show or delete one domain.                                                                                                   |
| `POST /domains/{id}/reset`                    | Seed the domain again. Every write, before-image, command, and deleted user disappears.                                      |
| `POST /domains/{id}/service-accounts`         | Issue a service account key. The body takes an optional `projectId`.                                                         |
| `PUT /domains/{id}/delegation/{clientId}`     | Set the scopes granted to a client ID: `{ "scopes": [<scope URLs>] }`.                                                       |
| `POST /domains/{id}/tokens`                   | Mint an access token: `subject`, `scopes`, and `ttlSeconds`.                                                                 |
| `PUT /domains/{id}/settings`                  | Merge a settings patch.                                                                                                      |
| `GET /domains/{id}/quota`                     | The quota buckets, the flag state, and the in-flight requests.                                                               |
| `GET`, `POST`, `DELETE /domains/{id}/faults`  | List, add, or clear fault rules.                                                                                             |
| `POST /domains/{id}/index/flush`              | End the search lag and the group delays.                                                                                     |
| `POST /domains/{id}/drive/files`              | Seed a file in the Drive of one subject. `PUT` edits it, and `DELETE` removes it.                                            |
| `POST /domains/{id}/drive/files/{id}/tabs`    | Add a tab to a spreadsheet.                                                                                                  |
| `POST /domains/{id}/drive/files/{id}/grant`   | Grant one subject the files of the file owner, as the Picker grants a picked file.                                           |
| `POST`, `DELETE /domains/{id}/drive/refusals` | Refuse the Drive token of one subject with `invalid_grant` or `unauthorized_client`, or allow it again.                      |

`GET /domains` reports `counts` of `orgUnits`, `users`, `devices`, `groups`, `memberships`, and `pendingWrites` for each domain.
An `/info` domain entry holds `customerId`, `primaryDomain`, `adminEmail`, `action`, and its `serviceAccounts` with their key file paths.

Two guards protect the control API:

- It accepts a `Host` header of `localhost`, `127.0.0.1`, `[::1]`, or `admin-sdk-mock`, each with any port. It answers `403` to any other.
- A `POST`, `PUT`, or `DELETE` that carries a body must send `content-type: application/json`, or the API answers `415`.

Together these block a web page from driving the mock with a cross-origin `text/plain` post or a rebound DNS name.

The Drive and Sheets routes accept a token with the `drive.file` scope.
A token reads only the files that its subject owns, or the files that a control grant names.
The media read of `files.get` carries the route ID `drive.files.get.media`. The metadata read carries `drive.files.get`.
A fault rule names either ID, so a hang on the media read leaves the metadata read free.
