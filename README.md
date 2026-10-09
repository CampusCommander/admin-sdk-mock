# Admin SDK mock

This service imitates the Google Admin SDK for Campus Commander scale testing.
It answers on the real Google hostnames and serves seeded K-12 domains.

The design is in [docs/specs/2026-10-09-admin-sdk-mock-design.md](docs/specs/2026-10-09-admin-sdk-mock-design.md).

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

The credential grants the read-only milestone 1 scopes. Pass `--scopes` to grant a different list.
Delegate to the `adminEmail` that `domain create` prints.

`mockctl clock --scale 60` compresses every quota window, flag, and delay by 60.
`mockctl clock --delays off` removes all delays.
`mockctl quota <customerId>` shows the quota buckets and the flag state.
`mockctl fault add <customerId> --json '{"kind":"status","status":503,"reason":"backendError","count":3}'` injects faults.

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

The overlay adds no file to Campus Commander. It routes the four Google hostnames to the mock inside the `internal` network.

Outside Docker, run the mock with `MOCK_GOOGLE_PORT=443` as a user that may bind port 443.
Map the four Google hostnames to `127.0.0.1` in `/etc/hosts`.
Start each client with `NODE_EXTRA_CA_CERTS` set to the file that `mockctl ca --out <file>` writes.
The `api` and `workers` containers trust the mock CA through `NODE_EXTRA_CA_CERTS`.
See [docs/campus-commander.md](docs/campus-commander.md) for the full procedure.

## Status

Milestone 1 is built. The acceptance run against Campus Commander awaits the owner.

- Calibration record: [docs/calibration.md](docs/calibration.md)
- Campus Commander procedure and record: [docs/campus-commander.md](docs/campus-commander.md)

Acceptance items:

| Item                                   | Result                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Live parity against the Easton fixture | 19 of 19 match in status. Six have shape notes. Device, user, and telemetry parity awaits scopes. |
| Client library compatibility           | 10 of 10 tests pass through a CONNECT proxy.                                                      |
| Scale                                  | The xlarge tier seeds in 14.9 s and serves 400,000 devices in 1,334 pages.                        |
| Campus Commander shows 60,000 devices  | Pending owner run: Docker Desktop WSL integration is off.                                         |
| Campus Commander repository unchanged  | Verified. `git status --short` is empty.                                                          |
| Open calibration values                | Seven values remain open or need an owner decision. See the calibration record.                   |
