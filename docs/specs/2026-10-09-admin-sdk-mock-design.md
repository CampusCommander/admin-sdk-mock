# Admin SDK mock: design

Status: design approved by the owner on 2026-10-09. Written spec awaits owner review.
Source: owner interview with Claude on 2026-10-09.
Repository: `CampusCommander/admin-sdk-mock`. Local path: `~/projects/admin-sdk-mock`.

## Purpose

Campus Commander needs Google Workspace domains with large device and user counts.
No real test domain at that size is available.
This service imitates the Google Admin SDK so that Campus Commander runs against seeded domains.
Domain sizes range from one school to Chicago Public Schools.

The mock answers on the real Google hostnames with the real request and response formats.
It reproduces Google quota behavior, network delay, and processing cost.
The mock is test infrastructure. It never ships to customers.

## Owner decisions

| ID  | Decision                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| D1  | The mock lives in a separate repository in the CampusCommander organization. No mock code enters `campus-commander`.      |
| D2  | Campus Commander reaches the mock through the real Google hostnames. Campus Commander code does not change.               |
| D3  | The store is writable from the first milestone. Milestone 1 adds reads. Milestone 2 adds writes. Milestone 3 adds groups. |
| D4  | Quota overage rules follow the owner field observation, with the overage percentages halved.                              |
| D5  | OU layouts differ per domain. Users and devices sit in separate OU subtrees.                                              |
| D6  | Seeds include the realism scenarios in [Scenario rates](#scenario-rates).                                                 |
| D7  | One full page takes 1 to 2 seconds at most.                                                                               |
| D8  | Approach A: Node 24, TypeScript through type stripping, and SQLite through `node:sqlite`.                                 |

### Owner field observation behind D4

The owner has observed this Google behavior at large districts:

- 15–25% over quota for 5–10 minutes, once or twice an hour, causes no errors.
- 15–20% over quota for 30 minutes or more flags the user. A hard quota cap then applies for one hour.
- 50% over quota for a few minutes causes no errors.
- 50% over quota for about 10 minutes flags the user. A hard quota cap then applies for one hour.

The owner directed a stricter mock: "cut those percentage of overage in half." Durations stay unchanged.

## Exclusions

- No production use and no customer distribution.
- No Google APIs beyond the APIs in [API surface](#api-surface).
  Reports, Licensing, Chrome Policy, Groups Settings, Gmail, Drive, and Classroom are out of scope.
- No mobile devices.
- No administration console user interface.
- No real Google credentials inside the mock.
- No changes to `campus-commander`. Its in-process test simulator `api-e2e/google-connection-preload.cjs` stays unchanged.
- Admin privilege is binary: super administrator or not an administrator. Custom admin roles are out of scope.

## Architecture

### Process

One Node 24 process runs two listeners.

The Google listener serves HTTPS on port 443. It answers for these hostnames and routes by the `Host` header:

- `oauth2.googleapis.com`
- `admin.googleapis.com`
- `www.googleapis.com`
- `chromemanagement.googleapis.com`

On first start, the mock creates its own certificate authority.
The CA issues one server certificate for the four hostnames.
The CA certificate is available at the control endpoint `GET /ca.pem` and in the data volume.

The control listener serves plain HTTP on port 8080. Campus Commander never calls it.
It creates, seeds, resets, and deletes domains. It also issues service-account files, changes settings, and injects faults.
The `mockctl` command-line tool wraps the control listener.

### Storage

One data volume holds all state:

| Path                          | Content                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `ca/`                         | The CA key and certificate, and the server key and certificate.            |
| `registry.sqlite`             | Domains, service accounts, delegation grants, settings, and issued tokens. |
| `domains/<customerId>.sqlite` | The seeded data for one domain.                                            |

Each domain has its own SQLite file. Deleting a domain deletes its file.
SQLite allows one writer per file. One writer per domain is sufficient for a mock.

### Code layout

| Folder     | Responsibility                                                              |
| ---------- | --------------------------------------------------------------------------- |
| `google/`  | Routers for OAuth, Directory, Chrome Management, and batch requests.        |
| `auth/`    | Assertion verification, delegation grants, access tokens, and scope checks. |
| `store/`   | SQLite schema, queries, paging, and the `fields` selector.                  |
| `seed/`    | Deterministic generation of domains, OUs, users, devices, and telemetry.    |
| `quota/`   | Quota buckets, overage classification, flags, and concurrency caps.         |
| `latency/` | The delay model and the time scale.                                         |
| `control/` | The control listener, fault injection, and `mockctl`.                       |

### Toolchain

- Node 24 runs TypeScript directly through type stripping. No build step exists.
- Type-stripped files contain no decorators, enums, or parameter properties.
- Tests use `node:test`. Lint uses ESLint. Formatting uses Prettier. `tsc --noEmit` checks types.
- The repository is a plain npm project without Nx.

## Domains and seed data

### Domain

A domain is one seeded Google customer. It has:

- a customer ID in Google format: `C` followed by 8 letters and digits;
- a primary domain under the reserved `.test` top-level domain, for example `lakeview-sd.test`;
- secondary domains and domain aliases;
- a `my_customer` record;
- one or more super administrator users that serve as delegated subjects.

### Seed specification

A seed specification has a tier, a seed number, and optional overrides.
Overrides change counts, the OU layout family, and scenario rates.
The same specification always produces identical data, including every ID and timestamp offset.
A test failure therefore reproduces exactly.

| Tier     | Schools | Students | Staff  | Chrome devices |
| -------- | ------- | -------- | ------ | -------------- |
| `small`  | 1       | 500      | 60     | 600            |
| `medium` | 12      | 6,000    | 700    | 7,000          |
| `large`  | 60      | 50,000   | 6,000  | 60,000         |
| `xlarge` | 640     | 320,000  | 45,000 | 400,000        |

### OU layouts

The generator builds each domain from a family of layout patterns:

- Role first: `/Students/<School>/<Graduation year>`, `/Staff/<School>`, `/Devices/<School>/<Category>`.
- School first: `/<School>/Students/<Grade>`, `/<School>/Staff`, `/<School>/Devices/<Category>`.
- An `xlarge` domain adds a region layer above schools.

Each domain varies the names, for example `Students` or `Learners`, and grades or graduation years.
Each domain also varies the depth. A few branches nest 8 to 12 levels deep.
Device categories include one-to-one, carts, staff, and kiosk.

Users and devices sit in separate OU subtrees. The misplaced-device scenario is the only exception.
Google limits hold: 35 levels at most and 40,000 OUs at most per customer. An `xlarge` domain has about 13,000 OUs.

### Users

Users are students and staff. Each user has:

- a generated name from public first-name and surname frequency lists;
- a primary email on the domain, and aliases on some accounts;
- a student or employee ID in `externalIds`;
- creation and last-login times;
- an OU in the user subtree.

Each domain has a few super administrators.

### Devices

Each device carries the full Chrome device resource. This includes:

- a model from a catalog of common K-12 ChromeOS models, with each model's published auto-update expiration date;
- serial number, OS version, firmware version, platform version, boot mode, and MAC addresses;
- assigned user, asset ID, location, and notes;
- enrollment time and last-sync time;
- recent users, active time ranges, and CPU, disk, and memory reports.

### Telemetry

Devices with a battery carry telemetry for the Chrome Management API.
Telemetry includes battery design capacity and a battery status report history with full-charge capacity and battery health.
These are the telemetry fields that Campus Commander reads today.

### Scenario rates

Each rate is a per-domain default and accepts an override.

| Scenario                               | Default rate |
| -------------------------------------- | ------------ |
| Disabled devices                       | 2%           |
| Deprovisioned devices                  | 5%           |
| Devices in a user OU                   | 2%           |
| Devices with no assigned user          | 15%          |
| Devices past auto-update expiration    | 15%          |
| Suspended users                        | 4%           |
| OU branches nested 8 to 12 levels deep | 3 per domain |

### Size control

Queryable fields are indexed SQLite columns.
Report arrays are not stored. The mock computes them from the seed and the device ID on each read.
The same device therefore returns identical reports on every read.
This keeps an `xlarge` domain at hundreds of megabytes instead of several gigabytes.
Milestone 2 writes change stored fields only.

### Timestamps

Seeded timestamps are offsets from the seeding time.
Last-sync and last-login times therefore look current after each seed or reset.

## API surface

### Milestone 1: reads

| Host                                         | Method                                            | Path                                                              |
| -------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| `oauth2.googleapis.com`                      | Token exchange                                    | `POST /token`                                                     |
| `oauth2.googleapis.com`                      | Token information                                 | `GET` or `POST /tokeninfo`                                        |
| `admin.googleapis.com`                       | `customers.get`                                   | `/admin/directory/v1/customers/{customerKey}`                     |
| `admin.googleapis.com`                       | `domains.list`                                    | `/admin/directory/v1/customer/{customer}/domains`                 |
| `admin.googleapis.com`                       | `orgunits.list`, `orgunits.get`                   | `/admin/directory/v1/customer/{customer}/orgunits[/{path}]`       |
| `admin.googleapis.com`                       | `chromeosdevices.list`, `chromeosdevices.get`     | `/admin/directory/v1/customer/{customer}/devices/chromeos[/{id}]` |
| `admin.googleapis.com`                       | `users.list`, `users.get`                         | `/admin/directory/v1/users[/{userKey}]`                           |
| `www.googleapis.com`, `admin.googleapis.com` | Directory batch                                   | `POST /batch/admin/directory_v1`                                  |
| `chromemanagement.googleapis.com`            | `telemetry.devices.list`, `telemetry.devices.get` | `/v1/customers/{customer}/telemetry/devices[/{id}]`               |

Every customer path accepts `my_customer`.

### Token exchange

`POST /token` accepts the JWT bearer grant that `google-auth-library` sends. The mock checks:

1. The RS256 signature matches the public key of an issued service account.
2. `aud` is `https://oauth2.googleapis.com/token`.
3. `iat` and `exp` are valid, and the lifetime is one hour or less.
4. The delegated subject `sub` exists in a domain.
5. That domain's delegation grant for the client ID includes every requested scope.

A failed check returns Google's response: `401` with `error: unauthorized_client` or `400` with `error: invalid_grant`.
A success returns an opaque access token with `expires_in: 3599`.
The token records its client ID, subject, scopes, and expiry.
Google issues tokens to subjects that are not administrators. The administrator check happens on each API call.

`/tokeninfo` returns the exact scope list of the token. Campus Commander compares that list with its requested scopes.

### Method parameters

| Method                   | Parameters                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `chromeosdevices.list`   | `maxResults` up to 300, `pageToken`, `orderBy`, `sortOrder`, `orgUnitPath`, `includeChildOrgunits`, `query`, `projection` |
| `chromeosdevices.get`    | `projection`                                                                                                              |
| `users.list`             | `customer` or `domain`, `maxResults` up to 500, `pageToken`, `orderBy`, `sortOrder`, `query`, `projection`, `viewType`    |
| `users.get`              | user key as primary email, alias, or user ID, `projection`, `viewType`                                                    |
| `orgunits.list`          | `orgUnitPath`, `type` (`all`, `children`, `allIncludingParent`)                                                           |
| `telemetry.devices.list` | `pageSize` up to 1,000 with a default of 100, `pageToken`, required `readMask`, `filter`                                  |
| `telemetry.devices.get`  | required `readMask`                                                                                                       |

Google's limits page states a Chrome device page maximum of 100.
The `chromeosdevices.list` reference states 300. Campus Commander requests 300.
The mock follows the method reference. The live parity check verifies the maximum.

### Search

`chromeosdevices.list` supports these documented `query` operators in milestone 1:
`id`, `asset_id`, `user`, `recent_user`, `location`, `note`, `status`, `public_model_name`, `wifi_mac`, `ethernet_mac`,
`boot_mode`, `register`, `sync`, `last_user_activity`, `aue`, and `chrome_version`.
Date operators support the `..` range forms.

`users.list` supports these documented `query` fields in milestone 1:
no field, `name`, `email`, `givenName`, `familyName`, `isAdmin`, `isSuspended`, `externalId`, and `orgUnitPath`.
The operators are `=`, `:`, and `:PREFIX*`. Clauses combine with an implicit `AND`.

`telemetry.devices.list` supports the documented `filter` fields:
`orgUnitId`, `serialNumber`, `deviceId`, and `reports_timestamp`.

The response to an unsupported operator matches Google's response.
The live parity check records Google's response before implementation of that case.

### Common behavior

- `fields` partial responses support Google's syntax: comma lists, `a/b` paths, `a(b,c)` groups, and `*`.
  Trimmed responses cost less transfer time.
- Page tokens are opaque and bound to their query. Paging uses keys, so concurrent writes do not skip or repeat items.
  A page token from a different query returns Google's `400` error.
- Directory errors use the Directory envelope: `{"error":{"code","message","errors":[{"domain","reason","message"}]}}`.
- Chrome Management errors use the Google RPC envelope: `{"error":{"code","message","status","details"}}`.
- A token without a required scope receives `403` with the message "Request had insufficient authentication scopes."
- A subject that is not a super administrator receives `403` with the message "Not Authorized to access this resource/api".
- A request for another customer receives the status and reason that Google returns for that case.
- `alt=json` and `prettyPrint` are accepted.

### Batch

- One batch request holds 1,000 parts at most.
- Each part passes quota admission separately. A rejected part receives `403` inside the batch. Other parts continue.
- The response echoes each `Content-ID` with a `response-` prefix.
- Each part carries its own HTTP status and body.

### Milestone 2: writes

| Resource | Methods                                                                                   |
| -------- | ----------------------------------------------------------------------------------------- |
| Devices  | `update`, `patch`, `moveDevicesToOu`, `batchChangeStatus`, `issueCommand`, `commands.get` |
| Users    | `insert`, `update`, `patch`, `delete`, `undelete`, `makeAdmin`                            |
| OUs      | `insert`, `update`, `patch`, `delete`                                                     |

Writes enforce the documented limits:

- 10 user creations per second per domain.
- 1 OU creation or update per second per customer.
- Device `annotatedLocation` 200 characters, `notes` 500 characters, `annotatedUser` 100 characters.

Google documents a search-index delay. Most updates appear in search within one hour, and some take up to 36 hours.
The mock delays search visibility of written data by a per-domain setting. The default is 5 minutes.
A `get` request returns written data at once.

### Milestone 3: groups

| Resource      | Methods                                                  |
| ------------- | -------------------------------------------------------- |
| Groups        | `list`, `get`, `insert`, `update`, `patch`, `delete`     |
| Members       | `list`, `get`, `insert`, `update`, `delete`, `hasMember` |
| Group aliases | `list`, `insert`, `delete`                               |

Group and member pages hold 200 items at most. Group membership cycles are rejected.
Milestone 3 needs its own seed rules for groups. They are decided before milestone 3 starts.

## Quota model

### Directory quota buckets

One bucket exists for each pair of service-account project and delegated subject.
The nominal quota Q is 2,400 requests per minute.
One plain call counts as 1. One batch part counts as 1.
Rejected requests do not count.

Each bucket keeps one record for each of the last 60 minutes. Minutes are fixed windows.

| State     | Admission                                        |
| --------- | ------------------------------------------------ |
| Unflagged | Admit while the minute count is below 125% of Q. |
| Flagged   | Admit while the minute count is below 100% of Q. |

At the end of each minute, the mock classifies the minute by its admitted count:

| Class  | Admitted count                                                |
| ------ | ------------------------------------------------------------- |
| Normal | 100% of Q or less                                             |
| Over   | more than 100% of Q                                           |
| Heavy  | more than 112.5% of Q. A heavy minute is also an over minute. |

The mock flags the bucket when the last 60 minutes hold 30 or more over minutes, or 10 or more heavy minutes.
A flag lasts 60 minutes. Then the bucket returns to the unflagged state.

A rejected request receives `403` with reason `userRateLimitExceeded`.
Google does not send `Retry-After`. The mock sends it only when the domain setting enables it.

### Concurrency caps

Google limits concurrent requests per Workspace account and does not publish the number.

| Cap                                        | Default | Error                                 |
| ------------------------------------------ | ------- | ------------------------------------- |
| In-flight requests per customer per method | 40      | `403` with reason `quotaExceeded`     |
| In-flight requests per customer            | 120     | `429` with reason `rateLimitExceeded` |

### Chrome Management quota

Chrome Management uses its own buckets with the same overage rules.
Google publishes no quota for this API. The default Q is 2,400 requests per minute.
A rejected request receives `429` with status `RESOURCE_EXHAUSTED`.

### Settings

Every value in this section is a per-domain setting.
A test can therefore compare the owner observation, the halved defaults, and a raised quota.

## Latency model

The delay of one response is the sum of four parts:

| Part       | Model                                                                                  | Initial default                      |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------ |
| Round trip | Log-normal delay                                                                       | Median 80 ms, 99th percentile 400 ms |
| Transfer   | Response bytes divided by bandwidth                                                    | 8 MB per second                      |
| Compute    | Base cost per method, plus cost per returned item, plus scan cost for filtered queries | 150 ms base, 3 ms per item           |
| Load       | Surcharge per in-flight request above a threshold for the customer                     | 2% per request above 20              |

Calibration targets:

- A full 300-device page with `projection=FULL` takes 1 to 2 seconds.
- A single `get` takes 150 to 300 ms.
- A response without load surcharge or fault takes 2 seconds at most.

Batch parts run 10 at a time inside one batch request. The batch response returns after the last part.
Milestone 1 calibrates the per-part cost against the live Easton batch measurement.
That measurement recorded 736 ms for a 3-part batch on 2026-10-07.

### Time scale

One time-scale factor divides every quota window, flag duration, penalty, and delay.
At a factor of 60, one quota minute lasts one second and one flag lasts one minute.
The ratios between quota and delay stay constant.
A separate switch disables all delays for fast functional tests.

## Faults

The control listener injects faults. A fault applies to a domain, a method, or one entity.

| Fault              | Effect                                                              |
| ------------------ | ------------------------------------------------------------------- |
| Error rate         | A raised rate of `500` and `503 backendError` responses.            |
| Fixed status       | A chosen status and reason for the next N matching requests.        |
| Connection reset   | The mock destroys the socket without a response.                    |
| Hang               | The mock holds the response for a chosen duration.                  |
| Delegation revoked | The token endpoint returns `unauthorized_client` for the client ID. |
| Scope removed      | The delegation grant loses a scope.                                 |
| Subject demoted    | The delegated subject loses super administrator status.             |
| Entity removed     | A device or user disappears. Later requests for it return `404`.    |

These faults cover every fault mode of the Campus Commander in-process simulator.

## Control listener

| Request                                   | Effect                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| `POST /domains`                           | Create and seed a domain from a seed specification.             |
| `GET /domains`                            | List domains with tier, seed, and counts.                       |
| `POST /domains/{id}/reset`                | Discard writes and reseed from the same specification.          |
| `DELETE /domains/{id}`                    | Delete the domain and its file.                                 |
| `POST /domains/{id}/service-accounts`     | Issue a service-account JSON file.                              |
| `PUT /domains/{id}/delegation/{clientId}` | Set the scopes granted to a client ID.                          |
| `PUT /domains/{id}/settings`              | Change quota, latency, scenario, and search-delay settings.     |
| `GET /domains/{id}/quota`                 | Report bucket minute history, flag state, and in-flight counts. |
| `POST /domains/{id}/faults`               | Add a fault.                                                    |
| `DELETE /domains/{id}/faults`             | Remove all faults.                                              |
| `PUT /clock`                              | Set the time scale and the delay switch.                        |
| `GET /ca.pem`                             | Return the CA certificate.                                      |
| `GET /health`                             | Report readiness.                                               |

An issued service-account file passes the Campus Commander credential check:

- `type` is `service_account`, and `client_id` is numeric.
- `client_email` ends in `.iam.gserviceaccount.com`.
- `private_key` is a 2048-bit RSA key, and `private_key_id` is present.
- `token_uri` is exactly `https://oauth2.googleapis.com/token`.

The control listener has no authentication. It binds to the container network and the host loopback interface only.

## Wiring into Campus Commander

The mock repository ships a Docker Compose overlay. The operator combines it with the Campus Commander Compose file.
The overlay does these things:

1. It adds the mock container to the network of the Campus Commander services that call Google.
2. It gives the mock container the four Google hostnames as network aliases.
3. It mounts the mock CA certificate into the `api` and `workers` containers.
4. It sets `NODE_EXTRA_CA_CERTS` in those containers to the mounted certificate.

Docker resolves the aliases inside the network. Requests to the Google hostnames therefore reach the mock.
The overlay adds no files to `campus-commander`. The plan verifies the exact service and network names.

Outside Docker, a developer adds the four hostnames to `/etc/hosts` and sets `NODE_EXTRA_CA_CERTS`.

To connect Campus Commander, the operator follows these steps:

1. Create and seed a domain with `mockctl`.
2. Issue a service-account file and grant its client ID the Campus Commander scopes.
3. Import the file in Campus Commander with a seeded super administrator as the delegated subject.

## Testing

### Unit tests

Unit tests use `node:test` and a fake clock. They cover:

- the `fields` parser, both query languages, the telemetry filter, and page tokens;
- quota admission, minute classification, both flag rules, the penalty, and flag expiry;
- the latency model;
- seed determinism: one specification always produces the same database hash;
- OU invariants: depth, count, separate subtrees, and the misplaced-device rate.

### Contract tests

The repository stores Google's published discovery documents for Directory v1 and Chrome Management v1 as fixtures.
Each mock response is validated against the discovery schema of its method.

### Client compatibility tests

Google's `googleapis` and `google-auth-library` npm packages call the mock without modification.
The test resolves the Google hostnames to the mock and trusts the mock CA.

### Live parity check

The standing read-only Easton authorization covers this check. It does not mutate Google data.
The same read calls run against real Google and against a small seeded domain. The check compares:

- response shapes for each milestone 1 method;
- header behavior;
- the error envelopes for a bad page token, an unknown customer, an oversized `maxResults`, and an unsupported query operator.

The credential stays at its protected path outside the repository. Recorded results contain no credential material.

### Scale test

The scale test seeds an `xlarge` domain. It enumerates every device, user, OU, and telemetry record through the Google client at a compressed time scale.
It checks the counts and the timing bounds.

## CI and image

- Every pull request runs lint, type checks, unit tests, and contract tests.
- Compatibility and scale tests run in Docker.
- Each push to `main` publishes `ghcr.io/campuscommander/admin-sdk-mock`. The overlay references the image by digest.

## Milestone 1 acceptance

Milestone 1 is complete when all of these hold:

1. `mockctl` creates and seeds an `xlarge` domain. The same seed specification reproduces it exactly.
2. The Google client lists and gets every milestone 1 resource without modification, through plain calls and batches.
3. Every milestone 1 response passes discovery schema validation.
4. A sustained load at 110% of Q receives a flag after 30 scaled minutes. The penalty lasts 60 scaled minutes. Admission then recovers.
5. The live parity check matches the Easton response shapes.
6. Campus Commander, with only the Compose overlay added, connects through an issued service-account file.
   It completes a full device sync against a `large` domain of 60,000 devices. The device grid shows those devices.
   No file in `campus-commander` changes.

## Defaults to calibrate in milestone 1

These values have defaults in this spec. Milestone 1 measures or verifies them:

- latency constants and the batch per-part cost;
- concurrency cap defaults;
- the Chrome Management quota default;
- the Chrome device page maximum;
- Google's response to an unsupported query operator.
