# Admin SDK mock

This service imitates the Google Admin SDK for Campus Commander scale testing.
It answers on the real Google hostnames and serves seeded K-12 domains.

The design is in [docs/specs/2026-10-09-admin-sdk-mock-design.md](docs/specs/2026-10-09-admin-sdk-mock-design.md).
The milestone 2 writes design is in [docs/specs/2026-10-09-milestone-2-writes-design.md](docs/specs/2026-10-09-milestone-2-writes-design.md).
The milestone 3 groups design is in [docs/specs/2026-10-10-milestone-3-groups-design.md](docs/specs/2026-10-10-milestone-3-groups-design.md).

## Develop

Use Node 24.19 and run `npm ci`.
Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run format:check` before each commit.

## Run locally

Start the mock on high ports with data in `./data`:

```sh
MOCK_DATA_DIR=./data MOCK_GOOGLE_PORT=8443 MOCK_CONTROL_PORT=8080 npm start
```

Create a domain and a credential:

```sh
node bin/mockctl.ts domain create --tier small --seed demo
node bin/mockctl.ts credential <customerId> --out ./demo-credential.json
```

The credential grants the read-only milestone 1 scopes. The `--scopes` option replaces that default list.
Pass full `https://www.googleapis.com/auth/...` URLs, one for each read scope and each write scope that you need.
The next command grants the seven read scopes and the four write scopes, including the two group scopes.

```sh
node bin/mockctl.ts credential <customerId> --out ./demo-credential.json --scopes https://www.googleapis.com/auth/admin.directory.customer.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly,https://www.googleapis.com/auth/admin.directory.orgunit.readonly,https://www.googleapis.com/auth/admin.directory.device.chromeos.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/chrome.management.telemetry.readonly,https://www.googleapis.com/auth/admin.directory.device.chromeos,https://www.googleapis.com/auth/admin.directory.user,https://www.googleapis.com/auth/admin.directory.orgunit,https://www.googleapis.com/auth/admin.directory.group
```

Delegate to the `adminEmail` that `domain create` prints.

`mockctl clock --scale 60` compresses every quota window, flag, and delay by 60.
`mockctl clock --delays off` removes all delays.
`mockctl quota <customerId>` shows the quota buckets and the flag state.
`mockctl fault add <customerId> --json '{"kind":"status","status":503,"reason":"backendError","count":3}'` injects faults.

## Writes

The mock accepts the milestone 2 writes for Chrome devices, device commands, users, and OUs.
Every list lags a write by the search delay. A `get` returns the written data at once.
Set `writes.searchDelaySeconds` to 0 to remove the lag.
`mockctl index flush <customerId>` makes every pending write visible at once.
`GET /domains` reports `pendingWrites` for each domain.
A device command follows a computed timeline. Online devices execute it within 60 seconds. Offline devices let it expire.
The time scale divides the search delay, the command timeline, the command expiry, and the undelete window.

## Groups

The mock serves the milestone 3 group methods on `admin.googleapis.com` under `/admin/directory/v1`.
Every method also runs inside the Directory batch. Group routes require a super administrator subject.

- `groups.list`, `groups.get`, `groups.insert`, `groups.update`, `groups.patch`, `groups.delete`
- `groups.aliases.list`, `groups.aliases.insert`, `groups.aliases.delete`
- `members.list`, `members.get`, `members.insert`, `members.update`, `members.patch`, `members.delete`, `members.hasMember`

Group reads accept `admin.directory.group` or `admin.directory.group.readonly`. Group writes need `admin.directory.group`.
Member reads also accept the two `group.member` scopes. Member writes accept `admin.directory.group.member`.

Every seeded domain holds these group families:

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

Five rates tune the scenarios. Pass them as JSON with `mockctl domain create --rates '<json>'`.

| Rate                   | Default | Meaning                               |
| ---------------------- | ------- | ------------------------------------- |
| `sectionsPerStudent`   | 4       | Section groups per student.           |
| `externalMemberGroups` | 0.03    | Share of groups with outside members. |
| `emptyGroups`          | 0.02    | Share of groups without members.      |
| `groupAliases`         | 0.10    | Share of groups with one alias.       |
| `deepGroupChains`      | 1       | Chains of 8 to 10 nested groups.      |

Three timing rules apply to groups. The time scale divides each delay.

- Group, member, and alias lists lag a write by the search delay, 300 seconds. A `get` and `hasMember` read current data.
- A new group link counts for `hasMember` and `includeDerivedMembership` after the nesting delay, 600 seconds.
- `members.insert` into a group younger than the ready delay, 60 seconds, answers `404`.

`mockctl index flush <customerId>` also ends every pending nesting delay and ready delay.
Its response reports `delaysEnded`, the number of group delays that the flush ended.
Set `nestingDelaySeconds` or `groupReadySeconds` to 0 to remove one delay.
`GET /domains` reports the group and membership counts of each domain.

## Faults

Add a fault with `mockctl fault add <customerId> --json '<rule>'`.
List them with `mockctl fault list <customerId>` and remove them with `mockctl fault clear <customerId>`.
A rule is a JSON object with a `kind` and the fields below. Unknown fields are rejected.
The `method` field is optional on the four request kinds. Without it the rule applies to every Directory and Chrome route.
With it, `method` must be one of these route IDs. Any other value, including `oauth.token` and `batch.directory`, is rejected.

- `directory.customers.get`, `directory.domains.list`
- `directory.orgunits.list`, `directory.orgunits.get`
- `directory.chromeosdevices.list`, `directory.chromeosdevices.get`
- `directory.users.list`, `directory.users.get`
- `chrome.telemetry.devices.list`, `chrome.telemetry.devices.get`

| Kind                | Fields                                 | Effect                                                  |
| ------------------- | -------------------------------------- | ------------------------------------------------------- |
| `error-rate`        | `method?`, `rate` (0 to 1)             | Fails that share of calls with a 500 or a 503.          |
| `status`            | `method?`, `status`, `reason`, `count` | Answers the next `count` calls with the given error.    |
| `reset`             | `method?`, `count`                     | Closes the connection on the next `count` calls.        |
| `hang`              | `method?`, `ms`, `count`               | Holds the next `count` calls for `ms` before answering. |
| `revoke-delegation` | `clientId`                             | Fails token exchange for that client.                   |
| `remove-scope`      | `clientId`, `scope`                    | Drops that scope from the client's grant.               |
| `demote-subject`    | `subject`                              | Makes that user lose super administrator access.        |
| `remove-entity`     | `entityId`                             | Hides the device or user with that ID or email.         |

Examples, one per kind:

```json
{ "kind": "error-rate", "method": "directory.users.list", "rate": 0.1 }
{ "kind": "status", "method": "directory.orgunits.list", "status": 503, "reason": "backendError", "count": 3 }
{ "kind": "reset", "count": 2 }
{ "kind": "hang", "method": "chrome.telemetry.devices.list", "ms": 30000, "count": 1 }
{ "kind": "revoke-delegation", "clientId": "100000000000000000001" }
{ "kind": "remove-scope", "clientId": "100000000000000000001", "scope": "https://www.googleapis.com/auth/admin.directory.user.readonly" }
{ "kind": "demote-subject", "subject": "admin@example.test" }
{ "kind": "remove-entity", "entityId": "device-id-or-user-email" }
```

### Settings

`PUT /domains/<customerId>/settings` merges a partial object into the domain settings. These keys exist, with their defaults.

- `quota` and `chromeQuota`: `perMinute` 2400, `ceiling` 1.25, `heavyRatio` 1.125, `overMinutesToFlag` 30, `heavyMinutesToFlag` 10, `flagMinutes` 60, `retryAfter` false.
- `concurrency`: `perMethod` 40, `perCustomer` 120.
- `latency`: `roundTripMedianMs` 80, `roundTripP99Ms` 400, `bytesPerSecond` 8000000, `baseMs` 150, `perItemMs` 3, `scanPer10kRowsMs` 20, `loadThreshold` 20, `loadPercentPerRequest` 2, `batchParallelism` 10, `batchPartMs` 40, `capMs` 2000.
- `telemetry`: `recentReports` 1.
- `writes`: `searchDelaySeconds` 300, `nestingDelaySeconds` 600, `groupReadySeconds` 60, `commandExpirySeconds` 432000, `userCreatesPerSecond` 10, `orgUnitWritesPerSecond` 1. `latency` also holds `writeBaseMs` 250 and `perDeviceWriteMs` 10.

## Control API safety

The control API accepts a `Host` header of `localhost`, `127.0.0.1`, `[::1]`, or `admin-sdk-mock`, each with any port. It answers 403 to any other.
A POST, PUT, or DELETE that carries a body must send `content-type: application/json`, or the API answers 415.
Together these block a web page from driving the mock with a cross-origin `text/plain` post or a rebound DNS name.
`GET /domains` lists each domain with its `counts` of `orgUnits`, `users`, `devices`, and `pendingWrites`.

## Run in Docker

```sh
docker compose -f compose/standalone.yml up --detach --wait --build
docker compose -f compose/standalone.yml exec admin-sdk-mock node bin/mockctl.ts domain create --tier medium --seed demo
```

The control API listens on `127.0.0.1:18080`. The Google listener answers on `127.0.0.1:18443`.

## Use with Campus Commander

Combine the overlay with a rendered Campus Commander all-docker Compose file:

```sh
docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml up --detach --wait
```

The default image is private. It is not published until CI runs on `main`.
Until then, build it locally and point the overlay at it:

```sh
docker build -t admin-sdk-mock:local .
ADMIN_SDK_MOCK_IMAGE=admin-sdk-mock:local docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml up --detach --wait
```

A plain `docker run` needs `--sysctl net.ipv4.ip_unprivileged_port_start=0` to bind port 443.
Seeding an `xlarge` domain blocks the mock for about 26 seconds. Seed before you connect Campus Commander.

The overlay adds no file to Campus Commander. It routes the four Google hostnames to the mock inside the `internal` network.

Outside Docker, run the mock with `MOCK_GOOGLE_PORT=443` as a user that may bind port 443.
Map the four Google hostnames to `127.0.0.1` in `/etc/hosts`.
Start each client with `NODE_EXTRA_CA_CERTS` set to the file that `mockctl ca --out <file>` writes.
The `api` and `workers` containers trust the mock CA through `NODE_EXTRA_CA_CERTS`.
See [docs/campus-commander.md](docs/campus-commander.md) for the full procedure.

## Status

Milestones 1, 2, and 3 are built. The acceptance run against Campus Commander awaits the owner.

- Calibration record: [docs/calibration.md](docs/calibration.md)
- Campus Commander procedure and record: [docs/campus-commander.md](docs/campus-commander.md)

Acceptance items:

| Item                                   | Result                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live parity against the Easton fixture | 19 of 19 match in status. Six have shape notes. Device, user, and telemetry parity awaits scopes.                                                                                                                                                                                               |
| Client library compatibility           | 10 of 10 tests pass through a CONNECT proxy.                                                                                                                                                                                                                                                    |
| Write contract                         | Every milestone 2 response passes discovery schema validation.                                                                                                                                                                                                                                  |
| Write compatibility                    | 15 of 15 client tests pass through a CONNECT proxy, writes included.                                                                                                                                                                                                                            |
| Write scale                            | 60000 devices move in 2037 ms. Lagging pages take 16 ms. The OU rename takes 868 ms.                                                                                                                                                                                                            |
| Scale                                  | The xlarge tier seeds in 14.9 s and serves 400,000 devices in 1,334 pages. With groups it seeds in 26,072 ms and holds 60,301 groups and 1,705,693 memberships in a 1,022 MB database. Mean page times are 6 ms for `groups.list`, 4 ms for member pages, and 31 ms for derived `all-students`. |
| Campus Commander shows 60,000 devices  | Pending owner run: Docker Desktop WSL integration is off.                                                                                                                                                                                                                                       |
| Campus Commander repository unchanged  | Verified. `git status --short` is empty.                                                                                                                                                                                                                                                        |
| Open calibration values                | Seven values remain open or need an owner decision. See the calibration record.                                                                                                                                                                                                                 |
