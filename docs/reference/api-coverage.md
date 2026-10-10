# API coverage reference

This page lists every Google method that the mock serves.
The table comes from the route table in [src/routes.ts](../../src/routes.ts), and `npm run docs` regenerates it.
A test fails when a route is missing from this page or when the table differs from the route table.

A path shows each path parameter as `{name}`. Brackets mark an optional part.
The Scopes column names each scope without its prefix, `https://www.googleapis.com/auth/`. A token needs at least one of the listed scopes.
`none` means the route checks no scope itself. A batch checks each part against that part's route.
Super admin `yes` means the delegated subject must be a super administrator.
Every customer parameter accepts `my_customer` or the token's own customer ID.
The route ID is also the `method` name that a fault rule takes. See [Faults](../guide/configuration.md#faults).

<!-- generated:start api-coverage -->

| Route                                       | Methods   | Hosts                                        | Path                                                                                         | Scopes                                                                                                                             | Super admin |
| ------------------------------------------- | --------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `batch.directory`                           | POST      | `www.googleapis.com`, `admin.googleapis.com` | `/batch[/admin/directory_v1]`                                                                | none                                                                                                                               | no          |
| `chrome.telemetry.devices.get`              | GET       | `chromemanagement.googleapis.com`            | `/v1/customers/{customer}/telemetry/devices/{deviceId}`                                      | `chrome.management.telemetry.readonly`                                                                                             | yes         |
| `chrome.telemetry.devices.list`             | GET       | `chromemanagement.googleapis.com`            | `/v1/customers/{customer}/telemetry/devices`                                                 | `chrome.management.telemetry.readonly`                                                                                             | yes         |
| `directory.chromeos.batchChangeStatus`      | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos:batchChangeStatus`               | `admin.directory.device.chromeos`                                                                                                  | yes         |
| `directory.chromeos.commands.get`           | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}/commands/{commandId}` | `admin.directory.device.chromeos`, `admin.directory.device.chromeos.readonly`                                                      | yes         |
| `directory.chromeos.issueCommand`           | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}:issueCommand`         | `admin.directory.device.chromeos`                                                                                                  | yes         |
| `directory.chromeosdevices.get`             | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}`                      | `admin.directory.device.chromeos`, `admin.directory.device.chromeos.readonly`                                                      | yes         |
| `directory.chromeosdevices.list`            | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos`                                 | `admin.directory.device.chromeos`, `admin.directory.device.chromeos.readonly`                                                      | yes         |
| `directory.chromeosdevices.moveDevicesToOu` | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/moveDevicesToOu`                 | `admin.directory.device.chromeos`                                                                                                  | yes         |
| `directory.chromeosdevices.patch`           | PATCH     | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}`                      | `admin.directory.device.chromeos`                                                                                                  | yes         |
| `directory.chromeosdevices.update`          | PUT       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/devices/chromeos/{deviceId}`                      | `admin.directory.device.chromeos`                                                                                                  | yes         |
| `directory.customers.get`                   | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customers/{customerKey}`                                                | `admin.directory.customer`, `admin.directory.customer.readonly`                                                                    | yes         |
| `directory.domains.list`                    | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customer}/domains`                                            | `admin.directory.domain`, `admin.directory.domain.readonly`                                                                        | yes         |
| `directory.groups.aliases.delete`           | DELETE    | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/aliases/{alias}`                                      | `admin.directory.group`                                                                                                            | yes         |
| `directory.groups.aliases.insert`           | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/aliases`                                              | `admin.directory.group`                                                                                                            | yes         |
| `directory.groups.aliases.list`             | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/aliases`                                              | `admin.directory.group`, `admin.directory.group.readonly`                                                                          | yes         |
| `directory.groups.delete`                   | DELETE    | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}`                                                      | `admin.directory.group`                                                                                                            | yes         |
| `directory.groups.get`                      | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}`                                                      | `admin.directory.group`, `admin.directory.group.readonly`                                                                          | yes         |
| `directory.groups.insert`                   | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/groups`                                                                 | `admin.directory.group`                                                                                                            | yes         |
| `directory.groups.list`                     | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups`                                                                 | `admin.directory.group`, `admin.directory.group.readonly`                                                                          | yes         |
| `directory.groups.patch`                    | PATCH     | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}`                                                      | `admin.directory.group`                                                                                                            | yes         |
| `directory.groups.update`                   | PUT       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}`                                                      | `admin.directory.group`                                                                                                            | yes         |
| `directory.members.delete`                  | DELETE    | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members/{memberKey}`                                  | `admin.directory.group`, `admin.directory.group.member`                                                                            | yes         |
| `directory.members.get`                     | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members/{memberKey}`                                  | `admin.directory.group`, `admin.directory.group.readonly`, `admin.directory.group.member`, `admin.directory.group.member.readonly` | yes         |
| `directory.members.hasMember`               | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/hasMember/{memberKey}`                                | `admin.directory.group`, `admin.directory.group.readonly`, `admin.directory.group.member`, `admin.directory.group.member.readonly` | yes         |
| `directory.members.insert`                  | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members`                                              | `admin.directory.group`, `admin.directory.group.member`                                                                            | yes         |
| `directory.members.list`                    | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members`                                              | `admin.directory.group`, `admin.directory.group.readonly`, `admin.directory.group.member`, `admin.directory.group.member.readonly` | yes         |
| `directory.members.patch`                   | PATCH     | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members/{memberKey}`                                  | `admin.directory.group`, `admin.directory.group.member`                                                                            | yes         |
| `directory.members.update`                  | PUT       | `admin.googleapis.com`                       | `/admin/directory/v1/groups/{groupKey}/members/{memberKey}`                                  | `admin.directory.group`, `admin.directory.group.member`                                                                            | yes         |
| `directory.orgunits.delete`                 | DELETE    | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits/{orgUnitPath}`                           | `admin.directory.orgunit`                                                                                                          | yes         |
| `directory.orgunits.get`                    | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits/{orgUnitPath}`                           | `admin.directory.orgunit`, `admin.directory.orgunit.readonly`                                                                      | yes         |
| `directory.orgunits.insert`                 | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits`                                         | `admin.directory.orgunit`                                                                                                          | yes         |
| `directory.orgunits.list`                   | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits`                                         | `admin.directory.orgunit`, `admin.directory.orgunit.readonly`                                                                      | yes         |
| `directory.orgunits.patch`                  | PATCH     | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits/{orgUnitPath}`                           | `admin.directory.orgunit`                                                                                                          | yes         |
| `directory.orgunits.update`                 | PUT       | `admin.googleapis.com`                       | `/admin/directory/v1/customer/{customerId}/orgunits/{orgUnitPath}`                           | `admin.directory.orgunit`                                                                                                          | yes         |
| `directory.users.delete`                    | DELETE    | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}`                                                        | `admin.directory.user`                                                                                                             | yes         |
| `directory.users.get`                       | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}`                                                        | `admin.directory.user`, `admin.directory.user.readonly`, `cloud-platform`                                                          | no          |
| `directory.users.insert`                    | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/users`                                                                  | `admin.directory.user`                                                                                                             | yes         |
| `directory.users.list`                      | GET       | `admin.googleapis.com`                       | `/admin/directory/v1/users`                                                                  | `admin.directory.user`, `admin.directory.user.readonly`, `cloud-platform`                                                          | no          |
| `directory.users.makeAdmin`                 | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}/makeAdmin`                                              | `admin.directory.user`                                                                                                             | yes         |
| `directory.users.patch`                     | PATCH     | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}`                                                        | `admin.directory.user`                                                                                                             | yes         |
| `directory.users.undelete`                  | POST      | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}/undelete`                                               | `admin.directory.user`                                                                                                             | yes         |
| `directory.users.update`                    | PUT       | `admin.googleapis.com`                       | `/admin/directory/v1/users/{userKey}`                                                        | `admin.directory.user`                                                                                                             | yes         |
| `oauth.token`                               | POST      | `oauth2.googleapis.com`                      | `/token`                                                                                     | none                                                                                                                               | no          |
| `oauth.tokeninfo`                           | GET, POST | `oauth2.googleapis.com`                      | `/tokeninfo`                                                                                 | none                                                                                                                               | no          |

<!-- generated:end api-coverage -->

## Parameters and rulings

The sections below list the parameters that each resource reads. The mock ignores other query parameters.
Live Google evidence backs the milestone 1 reads. The [calibration record](../calibration.md) holds that evidence and every ruling that stands in for it.

### Every Directory and Chrome Management route

| Parameter     | Rule                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fields`      | Google's partial-response syntax: comma lists, `a/b` paths, `a(b,c)` groups, and `*`. An unknown name answers `400`. |
| `prettyPrint` | `false` returns compact JSON.                                                                                        |
| `alt`         | The mock accepts `json`.                                                                                             |
| `pageToken`   | An opaque token bound to its query. A token from another query, or from before a domain reset, answers `400`.        |

A token without an accepted scope answers `403` with "Request had insufficient authentication scopes."
A subject that is not a super administrator answers `403` with "Not Authorized to access this resource/api" on every route whose Super admin column reads `yes`.
`users.list` and `users.get` read `no`, because they check the subject only for the default `admin_view`. The `domain_public` view skips the check.
See the [parity results](../calibration.md#parity-results) and the [parity calibration changes](../calibration.md#calibration-changes-from-the-parity-check).

### OAuth

| Route             | Parameters                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `oauth.token`     | A form body with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and an RS256 `assertion`.             |
| `oauth.tokeninfo` | `access_token` in the query or the form body, or an `Authorization: Bearer` header. `GET` and `POST` both work. |

The assertion needs `aud` set to `https://oauth2.googleapis.com/token`, a lifetime of one hour or less, a `sub` user of a domain, and a `scope` list.
A scope outside the delegation grant answers `401 unauthorized_client`. Other failures answer `400` with `invalid_grant`, `invalid_request`, or `invalid_scope`.
A success returns a bearer token with `expires_in` 3599.

### Customers and domains

| Route                     | Parameters                                       |
| ------------------------- | ------------------------------------------------ |
| `directory.customers.get` | `customerKey`: `my_customer` or the customer ID. |
| `directory.domains.list`  | `customer`.                                      |

A foreign customer ID answers `400 badRequest`. See the [parity calibration changes](../calibration.md#calibration-changes-from-the-parity-check).

### Organizational units

| Route                                | Parameters                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `directory.orgunits.list`            | `orgUnitPath`, and `type`: `all`, `children` (the default), or `allIncludingParent`.                  |
| `directory.orgunits.get`             | `orgUnitPath` in the path, as a path or an `id:` ID.                                                  |
| `directory.orgunits.insert`          | A body with `name` and `parentOrgUnitPath` or `parentOrgUnitId`.                                      |
| `directory.orgunits.update`, `patch` | A body with the fields to change. A rename or move cascades to every descendant OU, user, and device. |
| `directory.orgunits.delete`          | Only an OU without child OUs, users, or devices.                                                      |

OU writes share a limit of 1 per second per customer. The OU limits are 35 levels and 40,000 OUs per customer.
See the [milestone 2 rulings](../calibration.md#milestone-2-rulings).

### Chrome devices

| Route                                       | Parameters                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory.chromeosdevices.list`            | `maxResults` 1 to 300 (default 100, larger values clamp), `pageToken`, `orderBy`, `sortOrder`, `orgUnitPath`, `includeChildOrgunits`, `query`, `projection` (`BASIC` or `FULL`). |
| `directory.chromeosdevices.get`             | `projection`.                                                                                                                                                                    |
| `directory.chromeosdevices.update`, `patch` | `projection`, and a body with `annotatedUser`, `annotatedLocation`, `annotatedAssetId`, `notes`, `orgUnitPath`, or `orgUnitId`.                                                  |
| `directory.chromeosdevices.moveDevicesToOu` | `orgUnitPath` in the query, and up to 50 `deviceIds` in the body.                                                                                                                |
| `directory.chromeos.batchChangeStatus`      | Up to 50 `deviceIds`, a `changeChromeOsDeviceStatusAction`, and a `deprovisionReason` for a deprovision.                                                                         |
| `directory.chromeos.issueCommand`           | A `commandType` and an optional `payload`. `SET_VOLUME` needs `{"volume": N}` with N from 0 to 100.                                                                              |
| `directory.chromeos.commands.get`           | `commandId` in the path.                                                                                                                                                         |

`orderBy` takes `annotatedLocation`, `annotatedUser`, `lastSync`, `notes`, `serialNumber`, or `status`.
`query` takes the operators `id`, `asset_id`, `user`, `recent_user`, `location`, `note`, `status`, `public_model_name`, `wifi_mac`, `ethernet_mac`, `boot_mode`, `register`, `sync`, `last_user_activity`, `aue`, and `chrome_version`.
The write limits are 100 characters for `annotatedUser`, 200 for `annotatedLocation`, and 500 for `notes`.
The [calibration record](../calibration.md#calibration-record) holds the page maximum and the query operators. The [milestone 2 rulings](../calibration.md#milestone-2-rulings) cover writes and commands.

### Users

| Route                                             | Parameters                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directory.users.list`                            | `customer` or `domain`, `maxResults` 1 to 500 (default 100), `pageToken`, `orderBy` (`email`, `givenName`, or `familyName`), `sortOrder`, `query`, `projection` (`basic`, `full`, or `custom`), `viewType`, `showDeleted`. |
| `directory.users.get`                             | `userKey` as a primary email, an alias, or a user ID, `projection`, and `viewType` (`admin_view` or `domain_public`).                                                                                                      |
| `directory.users.insert`                          | A body with `primaryEmail`, `name.givenName`, `name.familyName`, and `password`. `orgUnitPath` defaults to `/`.                                                                                                            |
| `directory.users.update`, `patch`                 | A body with `name`, `orgUnitPath`, `suspended`, `externalIds`, `password`, `changePasswordAtNextLogin`, or `primaryEmail`.                                                                                                 |
| `directory.users.delete`, `undelete`, `makeAdmin` | `userKey` in the path. `undelete` takes an optional `orgUnitPath`. `makeAdmin` takes `{"status": true}` or `{"status": false}`.                                                                                            |

`query` takes no field, `name`, `email`, `givenName`, `familyName`, `isAdmin`, `isSuspended`, `externalId`, and `orgUnitPath`, with the operators `=`, `:`, and `:PREFIX*`.
User creations have a limit of 10 per second per domain. A deleted user stays recoverable for 20 days.
See the [milestone 2 rulings](../calibration.md#milestone-2-rulings).

### Groups

| Route                                        | Parameters                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `directory.groups.list`                      | `customer`, `domain`, or `userKey`, `maxResults` 1 to 200 (default 200), `orderBy` (`email`), `sortOrder`, `query`, `pageToken`. |
| `directory.groups.get`, `delete`             | `groupKey` as the group email, an alias, or the group ID.                                                                        |
| `directory.groups.insert`, `update`, `patch` | A body with `email`, `name`, and `description`. `name` defaults to the local part of the email.                                  |
| `directory.groups.aliases.list`              | `groupKey`.                                                                                                                      |
| `directory.groups.aliases.insert`            | A body with `alias` on one of the customer's domains.                                                                            |
| `directory.groups.aliases.delete`            | `alias` in the path.                                                                                                             |

`query` takes `email` and `name` with `=` and `:prefix*`, and `memberKey` with `=`. `memberKey` with `email` or `name` answers `400`.
Group and alias reads accept `admin.directory.group` or `admin.directory.group.readonly`. Group and alias writes need `admin.directory.group`.
See the [milestone 3 rulings](../calibration.md#milestone-3-rulings).

### Members

| Route                               | Parameters                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `directory.members.list`            | `maxResults` 1 to 200 (default 200), `roles` (a comma list of `OWNER`, `MANAGER`, and `MEMBER`), `includeDerivedMembership`, `pageToken`. |
| `directory.members.get`, `delete`   | `memberKey` as a user or group email, alias, or ID. Only a direct member matches.                                                         |
| `directory.members.insert`          | A body with `email` or `id`, and the optional `role` and `delivery_settings`.                                                             |
| `directory.members.update`, `patch` | A body with `role` or `delivery_settings`.                                                                                                |
| `directory.members.hasMember`       | `memberKey` naming a user.                                                                                                                |

Member reads accept the two group scopes and also the two `group.member` scopes: `admin.directory.group.member` and `admin.directory.group.member.readonly`.
Member writes accept `admin.directory.group` or `admin.directory.group.member`.
A cycle answers `400 Cyclic memberships not allowed.` A group younger than the ready delay answers `404` to `members.insert`.
See the [milestone 3 rulings](../calibration.md#milestone-3-rulings) and the [timing rules](../guide/behavior.md#group-delays).

### Chrome Management telemetry

| Route                           | Parameters                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `chrome.telemetry.devices.list` | `pageSize` up to 1,000 (default 100, larger values clamp), `pageToken`, `readMask` (required), `filter`. |
| `chrome.telemetry.devices.get`  | `readMask` (required).                                                                                   |

`readMask` takes `name`, `customer`, `orgUnitId`, `deviceId`, `serialNumber`, `batteryInfo`, `batteryStatusReport`, `memoryInfo`, and `storageInfo`.
`filter` takes `orgUnitId`, `serialNumber`, and `deviceId` with `=`, and `reports_timestamp` with `>=` or `>`.
Without a `reports_timestamp` filter, a device returns its newest report only. The `telemetry.recentReports` setting changes that count.
See the [calibration record](../calibration.md#calibration-record).

### Batch

`batch.directory` takes a `multipart/mixed` body of up to 1,000 parts on either path.
Each part passes quota admission and the write limits on its own, and carries its own status and body.
The response echoes each `Content-ID` with a `response-` prefix. Every Directory route runs inside a batch.
