# Admin SDK mock: milestone 2 writes design

Status: design and written spec approved by the owner on 2026-10-09.
Source: owner interview with Claude on 2026-10-09.
Parent: [Admin SDK mock design](2026-10-09-admin-sdk-mock-design.md). Every rule of the parent spec still applies unless this spec changes it.

## Purpose

Milestone 2 adds the writes that decision D3 of the parent spec assigns to it.
The Campus Commander development order puts device edits and device actions next, then users and OUs.
The Easton test authorization excludes Google data mutations. The mock is therefore the only place where those flows run, at any domain size.

Live parity evidence for writes does not exist. Write behavior follows Google's reference documentation and discovery documents.
Each rule without a documented source is marked **Ruling**. A later live write check can replace a ruling with evidence.

## Owner decisions

| ID    | Decision                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------ |
| M2-D1 | Every list call lags writes by the search delay. A `get` request returns written data at once.         |
| M2-D2 | The lagging lists read through before-images. A write saves the prior state of each row it changes.    |
| M2-D3 | The device, command, user, OU, limit, and testing rules below are approved as presented on 2026-10-09. |

## Exclusions

- User aliases methods, `countChromeOsDevices`, and the deprecated `chromeosdevices.action`.
- Custom user schemas and `customFieldMask`.
- Group writes. Milestone 3 adds groups.
- Live write parity. The Easton authorization does not permit mutations.
- New fault types. Existing faults cover write methods.

## API surface

All paths are on `admin.googleapis.com` under `/admin/directory/v1`. Every customer path accepts `my_customer`.

| Method                            | HTTP     | Path                                                                    |
| --------------------------------- | -------- | ----------------------------------------------------------------------- |
| `chromeosdevices.update`          | `PUT`    | `/customer/{customer}/devices/chromeos/{deviceId}`                      |
| `chromeosdevices.patch`           | `PATCH`  | `/customer/{customer}/devices/chromeos/{deviceId}`                      |
| `chromeosdevices.moveDevicesToOu` | `POST`   | `/customer/{customer}/devices/chromeos/moveDevicesToOu`                 |
| `chromeos.batchChangeStatus`      | `POST`   | `/customer/{customer}/devices/chromeos:batchChangeStatus`               |
| `chromeos.issueCommand`           | `POST`   | `/customer/{customer}/devices/chromeos/{deviceId}:issueCommand`         |
| `chromeos.commands.get`           | `GET`    | `/customer/{customer}/devices/chromeos/{deviceId}/commands/{commandId}` |
| `users.insert`                    | `POST`   | `/users`                                                                |
| `users.update`                    | `PUT`    | `/users/{userKey}`                                                      |
| `users.patch`                     | `PATCH`  | `/users/{userKey}`                                                      |
| `users.delete`                    | `DELETE` | `/users/{userKey}`                                                      |
| `users.undelete`                  | `POST`   | `/users/{userKey}/undelete`                                             |
| `users.makeAdmin`                 | `POST`   | `/users/{userKey}/makeAdmin`                                            |
| `orgunits.insert`                 | `POST`   | `/customer/{customer}/orgunits`                                         |
| `orgunits.update`                 | `PUT`    | `/customer/{customer}/orgunits/{orgUnitPath}`                           |
| `orgunits.patch`                  | `PATCH`  | `/customer/{customer}/orgunits/{orgUnitPath}`                           |
| `orgunits.delete`                 | `DELETE` | `/customer/{customer}/orgunits/{orgUnitPath}`                           |

`users.list` gains the `showDeleted` parameter.

**Ruling:** a method without a response schema returns `204` with an empty body.

## Search delay

### Contract

A list at time _t_ shows each entity as it was at time _t_ − _D_, where _D_ is the domain's search delay.
The default _D_ is 300 seconds. The time scale divides _D_ like every other duration. A _D_ of 0 disables the lag.

The lag applies to `chromeosdevices.list`, `users.list`, `orgunits.list`, and `telemetry.devices.list`.
It applies to list membership, filters, `query` matching, sort keys, and the returned bodies.
A `get` request, a write, and a write's response use the current data.

Examples:

- A device moved to `/B` appears under `/A` in lists for _D_ seconds. `chromeosdevices.get` shows `/B` at once.
- A new user is missing from lists for _D_ seconds.
- A deleted user still appears in lists for _D_ seconds. `users.get` returns `404` at once.
- Two writes 3 minutes apart each surface _D_ seconds after they happened.

### Before-images

Each write saves the prior state of every row it changes, with the write time.
An insert saves an absent marker. A delete saves the deleted row.
Each write keeps its own before-image.

Lists read through one view per resource.
The view shows the earliest before-image whose write time is later than _t_ − _D_. Otherwise it shows the current row.
An absent marker hides the entity.

Before each list, the mock deletes the before-images whose write time is at or before _t_ − _D_.
A domain without recent writes therefore has no before-images, and its lists read the current tables at the milestone 1 cost.

### Paging

Device and telemetry lists page by keys that writes never change. Their default order therefore neither skips nor repeats a device during writes.
Users page by `primaryEmail` by default. A `primaryEmail` change can move a user between pages, like a sort by any other written field.
**Ruling:** this matches Google's search index.

### Cascades

An OU rename or move changes the path of every descendant OU, user, and device. Each changed row receives a before-image.
A rename near the top of an `xlarge` domain therefore writes up to 400,000 before-images. The scale test records its duration.

## Devices

### `update` and `patch`

Both methods change only the fields present in the body:

| Field                      | Limit                                                |
| -------------------------- | ---------------------------------------------------- |
| `annotatedUser`            | 100 characters                                       |
| `annotatedLocation`        | 200 characters                                       |
| `annotatedAssetId`         | none                                                 |
| `notes`                    | 500 characters                                       |
| `orgUnitPath`, `orgUnitId` | must name an existing OU. A change moves the device. |

A value over its limit or an unknown OU returns `400` with reason `invalid`.
**Ruling:** read-only fields in the body are ignored.
The response is the device in the requested `projection`, with a new `etag`.
**Ruling:** updates apply to devices of every status.

### `moveDevicesToOu`

The required `orgUnitPath` query parameter names the target OU by path or by `id:` identifier.
The body lists up to 50 device IDs. More than 50 returns `400`.
**Ruling:** one unknown device ID fails the whole request with `400`, and no device moves.

### `batchChangeStatus`

The body lists up to 50 device IDs and one action. The response holds one result per device, in request order.

| Action      | Allowed from         | Result status   | Other effect                                                                     |
| ----------- | -------------------- | --------------- | -------------------------------------------------------------------------------- |
| Disable     | `ACTIVE`             | `DISABLED`      | none                                                                             |
| Re-enable   | `DISABLED`           | `ACTIVE`        | none                                                                             |
| Deprovision | `ACTIVE`, `DISABLED` | `DEPROVISIONED` | Requires `deprovisionReason`. Records `lastDeprovisionTimestamp` and the reason. |

A device in any other status receives an error result with code `FAILED_PRECONDITION`.
An unknown device ID receives an error result with code `NOT_FOUND`. The other devices proceed.
A deprovision without `deprovisionReason`, or more than 50 IDs, fails the whole request with `400`.

## Device commands

### `issueCommand`

The request names a `commandType` and an optional `payload`.
Only an `ACTIVE` device accepts a command. Any other status returns `400` with reason `failedPrecondition`.
`SET_VOLUME` requires the payload `{"volume": N}` with an integer N from 0 to 100. Any other payload returns `400`.
The response holds a new numeric `commandId`.

### Lifecycle

`commands.get` computes the state from the time since issue. No background timer runs.
The domain seed and the command ID decide every random choice, so one command always follows the same path.
The time scale divides every duration in this section.

**Ruling:** a device whose last sync is within the last 24 hours behaves as online.

| Device  | Time since issue          | State                                       |
| ------- | ------------------------- | ------------------------------------------- |
| Online  | under 2 seconds           | `PENDING`                                   |
| Online  | 2 to 5 seconds            | `SENT_TO_CLIENT`                            |
| Online  | 5 seconds until execution | `ACKED_BY_CLIENT`                           |
| Online  | after 10 to 60 seconds    | `EXECUTED_BY_CLIENT` with a `commandResult` |
| Offline | before expiry             | `PENDING`                                   |
| Offline | at `commandExpireTime`    | `EXPIRED`                                   |

The execution time is chosen per command between 10 and 60 seconds.
**Ruling:** 95% of executed commands report `SUCCESS`. The rest report `FAILURE` with an `errorMessage`.
**Ruling:** `commandExpireTime` is 5 days after issue. It is a per-domain setting.

Side effects apply at the execution time:

| Command            | Side effect                                                           |
| ------------------ | --------------------------------------------------------------------- |
| `REBOOT`           | The device's last sync moves to the execution time.                   |
| `WIPE_USERS`       | Recent users before the execution time are cleared.                   |
| `REMOTE_POWERWASH` | Recent users before the execution time are cleared. Enrollment stays. |
| Any other command  | none                                                                  |

A side effect is a write. It receives a before-image and the search delay.
An unknown command ID, or a command of another device, returns `404`.

## Users

### `insert`

The body requires `primaryEmail`, `name.givenName`, `name.familyName`, and `password`.

| Condition                                              | Response                      |
| ------------------------------------------------------ | ----------------------------- |
| A required field is missing.                           | `400` with reason `invalid`   |
| The email domain is not one of the customer's domains. | `400` with reason `invalid`   |
| The address is already a primary email or an alias.    | `409` with reason `duplicate` |
| `orgUnitPath` names no existing OU.                    | `400` with reason `invalid`   |

`orgUnitPath` defaults to `/`.
The response is the user with a new 21-digit numeric ID and the current creation time. No response contains a password.

### `update` and `patch`

Google documents patch semantics for `users.update`. Both methods therefore merge:
fields absent from the body stay unchanged, fields set to `null` are cleared, and arrays are replaced whole.

Writable fields: `name`, `orgUnitPath`, `suspended`, `externalIds`, `password`, `changePasswordAtNextLogin`, and `primaryEmail`.
A `primaryEmail` change keeps the old address as an alias. A new address already in use returns `409`.
A user suspended through the API receives `suspensionReason` `ADMIN`.
`isAdmin` in the body is ignored. Only `makeAdmin` changes administrator status.

### `delete` and `undelete`

`delete` removes the user from `get` at once. `users.get` then returns `404`.
Lists keep showing the user for the search delay.
`users.list` with `showDeleted=true` lists deleted users instead of active users.
That list lags too: a user enters it _D_ seconds after the delete.
A deleted user stays recoverable for 20 days. The time scale divides this window.

`undelete` restores the user into the OU named by `orgUnitPath` in the body. **Ruling:** a missing `orgUnitPath` means `/`.
An unknown user, or a user past the window, returns `404`. **Ruling:** an active user returns `400` with reason `invalid`.
A primary email reused by another user since the delete returns `409`.

Deleting the delegated administrator fails that subject's next API call through the existing per-call administrator check.

### `makeAdmin`

The body `{"status": true}` or `{"status": false}` sets super administrator status.
The change applies to the subject's next API call.

## OUs

### `insert`

The body requires `name` and either `parentOrgUnitPath` or `parentOrgUnitId`.
An unknown parent returns `400`.
**Ruling:** a name already used under the same parent returns `400` with reason `invalid`.
The response is the OU with a new `id:` identifier.

### `update` and `patch`

Both methods change only the fields present in the body. They can rename an OU, move it under a new parent, or both.
A path change cascades to every descendant OU, user, and device. See [Cascades](#cascades).
Moving the root, or moving an OU into its own subtree, returns `400`.

### `delete`

Only an OU without child OUs, users, or devices can be deleted. Otherwise the request returns `400`.
The root OU cannot be deleted.

## Identifiers and ETags

New identifiers follow Google's formats: 21-digit numeric user IDs, `id:` OU identifiers, and numeric command IDs.
Every write changes the `etag` of each entity it changes.

## Limits and quota

Each write call or batch part counts 1 against the parent spec's Directory bucket. The concurrency caps apply unchanged.

| Limit                                           | Value | Response when exceeded                |
| ----------------------------------------------- | ----- | ------------------------------------- |
| User creations per second per domain            | 10    | `403` with reason `rateLimitExceeded` |
| OU creations or updates per second per customer | 1     | `403` with reason `rateLimitExceeded` |

**Ruling:** the response reason for both limits is `rateLimitExceeded`. A rejected write does not count.

Writes require the read-write scopes:
`admin.directory.device.chromeos`, `admin.directory.user`, and `admin.directory.orgunit`.
A token with only the read-only scope receives `403` with the message "Request had insufficient authentication scopes."

## Latency

Writes use the parent spec's latency model with write compute costs.

| Cost                                                    | Default                                               |
| ------------------------------------------------------- | ----------------------------------------------------- |
| Base compute per write                                  | 250 ms                                                |
| Per device in `moveDevicesToOu` and `batchChangeStatus` | 10 ms                                                 |
| Cascaded rows                                           | 20 ms per 10,000 rows, the existing scan-cost setting |

A 50-device move therefore takes about 750 ms. The parent spec's 2-second cap still applies.
**Ruling:** these costs are defaults without live calibration.

## Batch

Write methods run inside the Directory multipart batch without change.
Each part passes quota admission and the write limits separately.

## Faults

Every existing fault applies to write methods. Fault method IDs include the new methods.
An entity removed by a fault makes later writes to it return `404`.

## Control listener and settings

| Request                          | Effect                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| `POST /domains/{id}/index/flush` | Delete every before-image. Lists show current data at once. |

`mockctl index flush` calls this request.
`POST /domains/{id}/reset` discards every write, before-image, command, and deleted user.
`GET /domains` reports the pending before-image count of each domain.

New per-domain settings:

| Setting               | Default     |
| --------------------- | ----------- |
| Search delay          | 300 seconds |
| Command expiry        | 5 days      |
| Write base compute    | 250 ms      |
| Per-device write cost | 10 ms       |

## CI

The workflow moves `actions/checkout` and `actions/setup-node` to v5. This removes the Node 20 deprecation warning.

## Testing

### Unit tests

- every write handler, including each `400`, `404`, and `409` case above;
- the lagging view with a fake clock: one write, two writes 3 minutes apart, inserts, deletes, cleanup, flush, and a delay of 0;
- default-order paging during writes;
- the command lifecycle for online and offline devices, its determinism, and its side effects;
- both write limits;
- OU cascades.

### Contract tests

Every milestone 2 response is validated against the discovery schema of its method.

### Client compatibility tests

Google's `googleapis` client performs every milestone 2 method through the proxy, as plain calls and inside a batch.

### Scale test

On an `xlarge` domain at a compressed time scale, the scale test:

1. moves 60,000 devices with 1,200 `moveDevicesToOu` parts in batches;
2. pages through all devices while those 60,000 before-images are pending, and checks the milestone 1 bound: the mean server time per page is at most 250 ms above the scaled 2-second cap;
3. records the duration of a top-level OU rename.

### Calibration record

`docs/calibration.md` lists every ruling of this spec as unverified against live Google.

## Milestone 2 acceptance

Milestone 2 is complete when all of these hold:

1. The Google client performs every milestone 2 method without modification, through plain calls and batches.
2. Every milestone 2 response passes discovery schema validation.
3. Lists lag writes by the search delay, and `get` returns written data at once. Flush and a delay of 0 both remove the lag.
4. Both write limits return their specified errors.
5. A domain reset discards every write.
6. The scale test passes.
7. CI passes on `main` and publishes the image.
