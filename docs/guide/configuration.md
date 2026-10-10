# Configuration

One JSON file configures the mock: its listeners, its timing, and the domains it ensures at startup.
The [configuration reference](../reference/configuration.md) lists every key. This guide explains how the keys work together.

## The file

`npx admin-sdk-mock init` writes a starter file, `admin-sdk-mock.json`:

```json
{
  "$schema": "./node_modules/@campuscommander/admin-sdk-mock/schema/config.schema.json",
  "dataDir": "./.admin-sdk-mock/data",
  "listen": { "proxy": { "port": 3128 } },
  "domains": [
    {
      "spec": { "tier": "small", "seed": "demo" },
      "serviceAccounts": [
        {
          "out": "./.admin-sdk-mock/credentials/demo.json",
          "scopes": "read-write"
        }
      ]
    }
  ]
}
```

The `$schema` key gives editors completion and checks. The mock ignores it.
`npx admin-sdk-mock config validate admin-sdk-mock.json` checks a file and its fixtures files without starting anything.
Validation reports every error at once, each with its JSON path, for example `domains[1].spec.tier must be one of: small, medium, large, xlarge, empty.`
Unknown keys are errors. `start` and `config validate` exit with code 2 for an invalid file, and `start` exits before any listener starts.
`env` exits with code 2 too when it reads the file, that is, when no control URL is given.
`doctor` prints each error as a `FAIL` line and exits with code 1.

## Lookup order

`start`, `doctor`, and `env` look for the file in this order:

1. The `--config <file>` flag.
2. The `MOCK_CONFIG` variable.
3. `./admin-sdk-mock.json` in the working directory, when it exists.
4. The `MOCK_CONFIG_DEFAULT` variable, when that file exists. The image sets it to `/config/admin-sdk-mock.json`.

A file that `--config` or `MOCK_CONFIG` names must exist. A missing named file makes `start` exit with code 2, and `env` too when it reads the file.
`doctor` prints a `FAIL` line for the missing file and exits with code 1.
Without any file, the defaults apply, and the mock starts with no domains.
`config validate <file>` reads only the file it names, and it ignores every `MOCK_*` variable.

## Precedence

Each value resolves in this order, highest first: command-line flags, environment variables, the file, the defaults.
Each listener field resolves on its own, so a port flag leaves the file's host in place.

Take this file:

```json
{
  "listen": {
    "google": { "host": "localhost", "port": 9443 },
    "proxy": { "port": 3128 }
  },
  "timing": { "scale": 60 }
}
```

Start it with one variable set and one flag:

```sh
MOCK_PROXY_PASSTHROUGH=true npx admin-sdk-mock start --google-port 11443
```

| Value             | Winner       | Result                            |
| ----------------- | ------------ | --------------------------------- |
| Google port       | The flag     | `11443`                           |
| Google host       | The file     | `localhost`                       |
| Proxy port        | The file     | `3128`                            |
| Proxy passthrough | The variable | `true`                            |
| Time scale        | The file     | `60`                              |
| Control listener  | The defaults | `127.0.0.1:8080`                  |
| Data directory    | The defaults | `./data` in the working directory |

A path in the file resolves against the file's directory. A path in a flag or a variable resolves against the working directory.
A file without `dataDir` uses `./data` in the working directory, not beside the file.

## Environment variables

| Variable                 | Sets                       | Values                                         |
| ------------------------ | -------------------------- | ---------------------------------------------- |
| `MOCK_CONFIG`            | The configuration file     | A path.                                        |
| `MOCK_CONFIG_DEFAULT`    | The fallback file          | A path. The mock reads it only when it exists. |
| `MOCK_DATA_DIR`          | `dataDir`                  | A path.                                        |
| `MOCK_GOOGLE_HOST`       | `listen.google.host`       | A host.                                        |
| `MOCK_GOOGLE_PORT`       | `listen.google.port`       | 0 to 65535.                                    |
| `MOCK_CONTROL_HOST`      | `listen.control.host`      | A host.                                        |
| `MOCK_CONTROL_PORT`      | `listen.control.port`      | 0 to 65535.                                    |
| `MOCK_PROXY_HOST`        | `listen.proxy.host`        | A host. It does not turn the proxy on.         |
| `MOCK_PROXY_PORT`        | `listen.proxy.port`        | 0 to 65535. It turns the proxy on.             |
| `MOCK_PROXY_PASSTHROUGH` | `listen.proxy.passthrough` | `true`, `false`, `1`, or `0`.                  |
| `MOCK_TIME_SCALE`        | `timing.scale`             | 1 to 100000.                                   |
| `MOCK_DELAYS`            | `timing.delays`            | `on`, `off`, `true`, `false`, `1`, or `0`.     |
| `MOCK_CA_EXPORT`         | `caFile`                   | A path.                                        |
| `MOCK_READY_FILE`        | `readyFile`                | A path.                                        |

An empty variable counts as unset. An invalid value is a configuration error with exit code 2.
Every variable except `MOCK_CONFIG_DEFAULT` has a matching `start` flag. The [CLI reference](../reference/cli.md#start) lists the flags.

The control commands find a running mock through `--control`, then `MOCK_CONTROL_URL`, then `ADMIN_SDK_MOCK_CONTROL`.
Without any of them, `env` reads the control listener from the configuration, and the other commands use `http://127.0.0.1:8080`.
A control URL that is not an `http` or `https` URL exits with code 2.

## Listeners

| Listener | Default          | Protocol                                          |
| -------- | ---------------- | ------------------------------------------------- |
| Google   | `127.0.0.1:8443` | TLS, with a certificate for the four Google hosts |
| Control  | `127.0.0.1:8080` | Plain HTTP                                        |
| Proxy    | Off              | HTTP `CONNECT`                                    |

`"listen": { "proxy": {} }` turns the proxy on at `127.0.0.1:3128` with `passthrough` off.
Port 0 picks a free port. The `ready` event and `GET /info` report the ports in use.
The image overrides every host to `0.0.0.0`, so other containers reach the listeners.

`start` writes the CA certificate to `caFile`, `<dataDir>/ca/ca.pem` by default.
It writes a bundle beside it, `ca-bundle.pem`, that holds the mock CA followed by the public roots.
With `readyFile` set, `start` writes the `ready` event there once every domain is ready.

## Domains

Each entry of `domains` names a seed specification and what to do with the domain at startup.

```json
{
  "domains": [
    {
      "spec": {
        "tier": "medium",
        "seed": "district-a",
        "layout": "school-first"
      },
      "onStart": "keep",
      "settings": { "quota": { "perMinute": 600 } },
      "serviceAccounts": [
        { "out": "./keys/district-a.json", "scopes": "read" }
      ],
      "faults": [
        { "kind": "error-rate", "method": "directory.users.list", "rate": 0.05 }
      ]
    }
  ]
}
```

### The seed specification

The same specification always yields the same domain: the same customer ID, names, IDs, and timestamps relative to the seed time.

| Key      | Meaning                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `tier`   | `small`, `medium`, `large`, `xlarge`, or `empty`.                                                      |
| `seed`   | 1 to 64 letters, digits, hyphens, or underscores. It decides the customer ID.                          |
| `name`   | The district name, 1 to 60 characters. It decides the primary domain, such as `example-district.test`. |
| `layout` | `role-first` or `school-first`. The default derives from the seed.                                     |
| `counts` | Overrides of `schools` (up to 2,000), `students`, `staff`, and `devices`, each 1 to 2,000,000.         |
| `rates`  | Overrides of the scenario rates below.                                                                 |

| Tier     | Schools | Students | Staff  | Devices | Groups      |
| -------- | ------- | -------- | ------ | ------- | ----------- |
| `empty`  | 0       | 0        | 0      | 0       | 0           |
| `small`  | 1       | 500      | 60     | 600     | 106         |
| `medium` | 12      | 6,000    | 700    | 7,000   | 1,159       |
| `large`  | 60      | 50,000   | 6,000  | 60,000  | about 8,700 |
| `xlarge` | 640     | 320,000  | 45,000 | 400,000 | 60,301      |

The group counts come from seed runs at each tier. The `large` count is the milestone 3 estimate.

The `empty` tier holds the primary domain, the student domain when the seed gives it a separate one, the alias domain, the root OU, and one super administrator, `admin@<primary domain>`.
It takes no `counts` or `rates`. It exists for [fixtures](#fixtures).
Every other tier also seeds `admin@<primary domain>` as a super administrator. The `ready` event and `GET /info` report it as `adminEmail`.

| Rate                   | Default | Range    | Meaning                                       |
| ---------------------- | ------- | -------- | --------------------------------------------- |
| `disabled`             | 0.02    | 0 to 1   | Share of devices with status `DISABLED`.      |
| `deprovisioned`        | 0.05    | 0 to 1   | Share of devices with status `DEPROVISIONED`. |
| `misplaced`            | 0.02    | 0 to 1   | Share of devices in a user OU.                |
| `unassigned`           | 0.15    | 0 to 1   | Share of devices with no assigned user.       |
| `expired`              | 0.15    | 0 to 1   | Share of devices past their auto-update date. |
| `suspended`            | 0.04    | 0 to 1   | Share of suspended users.                     |
| `deepBranches`         | 3       | 0 to 20  | OU branches nested 8 to 12 levels deep.       |
| `sectionsPerStudent`   | 4       | 0 to 10  | Section groups per student.                   |
| `externalMemberGroups` | 0.03    | 0 to 1   | Share of groups with outside members.         |
| `emptyGroups`          | 0.02    | 0 to 0.5 | Share of groups without members.              |
| `groupAliases`         | 0.10    | 0 to 1   | Share of groups with one alias.               |
| `deepGroupChains`      | 1       | 0 to 10  | Chains of 8 to 10 nested groups.              |

`disabled` plus `deprovisioned` must be 1 or less. `deepBranches`, `sectionsPerStudent`, and `deepGroupChains` take whole numbers.

Every tier except `empty` holds these group families:

| Family      | Address                                         | Direct members                                                 |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Staff       | `<school>-staff@<primary domain>`               | The school staff, with one owner.                              |
| Grade       | `<school>-<grade>@<student domain>`             | The students of one student OU.                                |
| Students    | `<school>-students@<student domain>`            | The school grade groups.                                       |
| School-wide | `<school>-all@<primary domain>`                 | The staff group and the students group.                        |
| Parent      | `<school>-parents@<primary domain>`             | The staff owner and 3 to 12 outside members.                   |
| Club        | `<club>-<school>@<student domain>`              | A staff owner, other staff, and students.                      |
| Section     | `<course>-p<period>-<teacher>@<student domain>` | A teacher as owner and about 25 students of one grade.         |
| District    | `all-staff`, `all-students`, `everyone`, others | School groups, a `CUSTOMER` member, administrators, and board. |
| Deep chains | Chains of 8 to 10 nested groups                 | The last group holds 3 staff members.                          |

### keep and reset

`onStart` decides what happens to a domain that already exists in the data directory.

| `onStart`       | Existing domain                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- |
| `keep`, default | The mock reuses it, with every earlier write, when its specification and fixtures match. |
| `reset`         | The mock seeds it again on every start. Every earlier write disappears.                  |

Under `keep`, a changed specification or fixtures file stops the start with exit code 2:

```text
domains[0].spec changed since the domain was created. Set onStart to reset or delete the data directory.
```

`reset` keeps each key file that still belongs to the domain, so clients keep working across restarts.
Two entries with the same seed name the same customer and fail validation.

### What every start reapplies

Every start, `keep` included, reapplies three things to each domain:

- The settings: the defaults, then `defaults.settings`, then the entry's `settings`.
- The faults: the entry's `faults` replace every fault rule of the domain.
- The service accounts: the mock writes each key file again and sets its grant to the entry's scopes.

## Settings

Settings are per domain. `defaults.settings` applies to every configured domain, then each entry's `settings` merges on top.
A running mock takes a patch through `admin-sdk-mock settings <customerId> --json '<patch>'` or `PUT /domains/<customerId>/settings`.
A patch merges into the current settings. An unknown key or a negative number is an error.

| Group                  | Keys and defaults                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quota`, `chromeQuota` | `perMinute` 2400, `ceiling` 1.25, `heavyRatio` 1.125, `overMinutesToFlag` 30, `heavyMinutesToFlag` 10, `flagMinutes` 60, `retryAfter` false.                                                                                                                                |
| `concurrency`          | `perMethod` 40, `perCustomer` 120.                                                                                                                                                                                                                                          |
| `latency`              | `roundTripMedianMs` 80, `roundTripP99Ms` 400, `bytesPerSecond` 8000000, `baseMs` 150, `perItemMs` 3, `scanPer10kRowsMs` 20, `loadThreshold` 20, `loadPercentPerRequest` 2, `batchParallelism` 10, `batchPartMs` 40, `capMs` 2000, `writeBaseMs` 250, `perDeviceWriteMs` 10. |
| `telemetry`            | `recentReports` 1.                                                                                                                                                                                                                                                          |
| `writes`               | `searchDelaySeconds` 300, `nestingDelaySeconds` 600, `groupReadySeconds` 60, `commandExpirySeconds` 432000, `userCreatesPerSecond` 10, `orgUnitWritesPerSecond` 1.                                                                                                          |

The [behavior guide](behavior.md) explains what each group controls.

## Service accounts

Each `serviceAccounts` entry issues a service account in the domain, grants it domain-wide delegation, and writes its key file.

```json
{ "out": "./keys/reader.json", "scopes": "read", "projectId": "reader-project" }
```

The key file holds the Google service-account JSON format, with mode 0600. Google client libraries load it unchanged.
A client signs its token request with this key and names a domain user as the subject, such as the administrator `admin@<primary domain>`.
With exactly one service account in the configuration, `env` also exports `GOOGLE_APPLICATION_CREDENTIALS` with its path.

`scopes` takes a list of scope URLs, or one of two words:

| Word         | Scopes                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`       | `admin.directory.customer.readonly`, `admin.directory.domain.readonly`, `admin.directory.orgunit.readonly`, `admin.directory.device.chromeos.readonly`, `admin.directory.user.readonly`, `admin.directory.group.readonly`, `chrome.management.telemetry.readonly` |
| `read-write` | Every `read` scope, plus `admin.directory.device.chromeos`, `admin.directory.user`, `admin.directory.orgunit`, and `admin.directory.group`                                                                                                                        |

Each name stands for `https://www.googleapis.com/auth/<name>`. The package exports both lists as `READ_SCOPES` and `READ_WRITE_SCOPES`.
A token request for a scope outside the grant answers `401 unauthorized_client`, as Google does.

A running mock issues more keys with `admin-sdk-mock credential <customerId> --scopes read-write --out <file>`.
`credential` grants `read` when `--scopes` is absent.

## Faults

A fault rule makes the mock fail on purpose. Add rules at startup through `domains[].faults`, or at run time:

```sh
npx admin-sdk-mock fault add <customerId> --json '{"kind":"status","status":503,"reason":"backendError","count":3}'
npx admin-sdk-mock fault list <customerId>
npx admin-sdk-mock fault clear <customerId>
```

A rule is a JSON object with a `kind` and the fields below. Unknown fields are errors.

| Kind                | Fields                                 | Effect                                                  |
| ------------------- | -------------------------------------- | ------------------------------------------------------- |
| `error-rate`        | `method?`, `rate` (0 to 1)             | Fails that share of calls with a 500 or a 503.          |
| `status`            | `method?`, `status`, `reason`, `count` | Answers the next `count` calls with the given error.    |
| `reset`             | `method?`, `count`                     | Closes the connection on the next `count` calls.        |
| `hang`              | `method?`, `ms`, `count`               | Holds the next `count` calls for `ms` before answering. |
| `revoke-delegation` | `clientId`                             | Fails token exchange for that client.                   |
| `remove-scope`      | `clientId`, `scope`                    | Drops that scope from the client's grant.               |
| `demote-subject`    | `subject`                              | Makes that user lose super administrator access.        |
| `remove-entity`     | `entityId`                             | Hides the device, user, or group with that ID or email. |

`method` is optional on the four request kinds. Without it, the rule applies to every Directory and Chrome Management route.
With it, `method` must name a Directory or Chrome Management route ID from the [API coverage reference](../reference/api-coverage.md).
`oauth.token`, `oauth.tokeninfo`, and `batch.directory` are not valid `method` values.

| Field      | Range                                          |
| ---------- | ---------------------------------------------- |
| `count`    | 1 to 1,000,000.                                |
| `status`   | 400 to 599.                                    |
| `reason`   | 1 to 64 characters, such as `backendError`.    |
| `ms`       | 1 to 600,000. The time scale divides it.       |
| `clientId` | The numeric client ID of a service account.    |
| `scope`    | A full `https://www.googleapis.com/auth/` URL. |

A hidden group drops out of group lists, gets, and member lists. Derived lists and `hasMember` do not follow a hidden group.

```json
{ "kind": "error-rate", "method": "directory.users.list", "rate": 0.1 }
{ "kind": "status", "method": "directory.orgunits.list", "status": 503, "reason": "backendError", "count": 3 }
{ "kind": "reset", "count": 2 }
{ "kind": "hang", "method": "chrome.telemetry.devices.list", "ms": 30000, "count": 1 }
{ "kind": "revoke-delegation", "clientId": "100000000000000000001" }
{ "kind": "remove-scope", "clientId": "100000000000000000001", "scope": "https://www.googleapis.com/auth/admin.directory.user.readonly" }
{ "kind": "demote-subject", "subject": "admin@example.test" }
{ "kind": "remove-entity", "entityId": "device-id-or-user-or-group-email" }
```

## Fixtures

A fixtures file declares exact OUs, users, devices, and groups for one domain.
Pair it with the `empty` tier to control every entity, or with a generated tier to add known entities to realistic data.

### A complete example

`admin-sdk-mock.json`:

```json
{
  "listen": { "proxy": { "port": 3128 } },
  "domains": [
    {
      "spec": {
        "tier": "empty",
        "seed": "fixtures-demo",
        "name": "Example District"
      },
      "onStart": "reset",
      "fixtures": "./fixtures.json",
      "serviceAccounts": [
        {
          "out": "./.admin-sdk-mock/credentials/fixtures.json",
          "scopes": "read"
        }
      ]
    }
  ]
}
```

This specification yields the primary domain `example-district.test` and the student domain `students.example-district.test`.

`fixtures.json`, beside the configuration file:

```json
{
  "orgUnits": [
    { "path": "/Schools/North", "description": "North campus" },
    { "path": "/Staff" }
  ],
  "users": [
    {
      "primaryEmail": "ana.rivera@example-district.test",
      "givenName": "Ana",
      "familyName": "Rivera",
      "orgUnitPath": "/Staff",
      "aliases": ["arivera@example-district.test"],
      "externalIds": [{ "value": "T-1001", "type": "organization" }]
    },
    {
      "primaryEmail": "sam.lee@students.example-district.test",
      "givenName": "Sam",
      "familyName": "Lee",
      "orgUnitPath": "/Schools/North",
      "suspended": true
    }
  ],
  "devices": [
    {
      "serialNumber": "EXAMPLE-0001",
      "orgUnitPath": "/Schools/North",
      "annotatedUser": "sam.lee@students.example-district.test",
      "notes": "Cart 3"
    },
    {
      "serialNumber": "EXAMPLE-0002",
      "status": "DISABLED",
      "lastSync": "2026-09-01T12:00:00Z"
    }
  ],
  "groups": [
    {
      "email": "north-staff@example-district.test",
      "name": "North staff",
      "aliases": ["north-teachers@example-district.test"],
      "members": [
        { "email": "ana.rivera@example-district.test", "role": "OWNER" },
        { "email": "guardian@family.test" }
      ]
    },
    {
      "email": "north-all@example-district.test",
      "members": [
        { "email": "north-staff@example-district.test", "type": "GROUP" },
        { "email": "sam.lee@students.example-district.test" }
      ]
    }
  ]
}
```

The domain then holds three users: `admin@example-district.test` and the two fixture users.
Both devices take the default model, `Lenovo 100e Chromebook Gen 4`. `EXAMPLE-0002` sits in `/`.
`north-all` reaches Ana Rivera and the outside member `guardian@family.test` through `north-staff`.
The [fixtures example](../../examples/fixtures) asserts a domain like this one through the Google client.

### Fields

| Section    | Fields                                                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgUnits` | `path` (required), `description`. The mock creates missing parent OUs.                                                                                                                                                      |
| `users`    | `primaryEmail`, `givenName`, `familyName` (all required), `orgUnitPath` (default `/`), `isAdmin`, `suspended`, `aliases`, `externalIds` (`{ "value", "type" }`), `id`.                                                      |
| `devices`  | `serialNumber` (required), `model` (from the model catalog), `status` (`ACTIVE`, `DISABLED`, or `DEPROVISIONED`), `orgUnitPath`, `annotatedUser`, `annotatedAssetId`, `annotatedLocation`, `notes`, `lastSync`, `deviceId`. |
| `groups`   | `email` (required), `name` (default: the local part), `description`, `aliases`, `members`.                                                                                                                                  |

A member names its key with exactly one of `email` and `id`. `role` is `OWNER`, `MANAGER`, or `MEMBER`, the default.
An optional `type` (`USER`, `GROUP`, or `CUSTOMER`) must match the kind of entity that the key names.

### Rules

- Every address sits on one of the domain's own domains and collides with no address already in the domain.
- An omitted ID derives from the seed and the entry, so one fixtures file always yields the same IDs.
- An omitted device field takes a fixed default: the model `Lenovo 100e Chromebook Gen 4`, the status `ACTIVE`, and the OU `/`.
  The last sync falls one day before the seed time, and the device has no assigned user, asset ID, location, or notes.
- The seed and the serial number decide every other device field, such as the device ID, the MAC addresses, the versions, and the enrollment time.
  Telemetry follows the device, as it does for seeded devices.
- A member names a fixture or seeded user or group, the customer ID, or an outside address. A cycle is an error.
- Fixture groups and memberships carry old creation times, so no ready or nesting delay applies to them.
- The fixtures apply in their own transaction right after the seed. A failure removes the whole domain.
- Each error names the file, the JSON path, and the problem. A fixtures error fails the start with exit code 2.
- `keep` compares the fixtures content. A changed fixtures file under `keep` stops the start.

`startMock().createDomain()` also takes fixtures, as a file path or as an object. See the [testing guide](testing.md#fixtures).
