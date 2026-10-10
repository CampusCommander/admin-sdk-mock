# Calibration record

Updated: 2026-10-09.

| Value                                 | Default                         | Evidence                                                                                | Status         |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- | -------------- |
| Round trip median and 99th percentile | 80 ms, 400 ms                   | Defaults. No measurement at scale.                                                      | open           |
| Batch part cost                       | 40 ms per wave of 10            | The Easton live batch of 3 parts took 736 ms on 2026-10-07, including connection setup. | open           |
| Concurrency caps                      | 40 per method, 120 per customer | Google publishes no value.                                                              | open           |
| Chrome Management quota               | 2,400 per minute                | Google publishes no value.                                                              | open           |
| Chrome device page maximum            | 300, larger values clamp        | Needs the device scope in the Easton grant.                                             | open           |
| Unsupported query operator            | 400 invalid                     | Needs the device or user scope in the Easton grant.                                     | open           |
| Telemetry without a timestamp filter  | newest report only              | Google documents "only recent reports".                                                 | owner decision |

## Parity results

The live run on 2026-10-09 used the approved Easton read-only fixture. It sent 19 probes. All 19 probes match in status. Six probes show shape differences, listed below.
Source: `parity/evidence/live-2026-10-09.json`.

- `token.granted`: 200 on both. Match.
- `token.ungranted`: 401 `unauthorized_client` on both. Match.
- `tokeninfo`: 200 on both. Match.
- `customers.get`: 200 on both. Match.
- `domains.list`: 200 on both. The mock emits an extra `domainAliases` field.
- `domains.list.badFields`: 400 on both. The mock lacks Google's `details` on the error.
- `orgunits.list.allIncludingParent`: 200 on both. The mock emits an extra `blockInheritance` field.
- `orgunits.list.children`: 200 on both. The mock emits an extra `blockInheritance` field.
- `orgunits.get.missing`: 404 on both. Match.
- `orgunits.list.otherCustomer`: 400 on both. Match.
- `customers.get.otherCustomer`: 400 on both. Match.
- `domains.list.otherCustomer`: 400 on both. Match.
- `orgunits.list.noToken`: 401 on both. The mock lacks Google's `details` on the error.
- `orgunits.list.badToken`: 401 on both. Match.
- `customers.get.wrongScope`: 403 on both. Match.
- `chromeosdevices.list.wrongScope`: 403 on both. Match.
- `users.list.wrongScope`: 403 on both. Match.
- `telemetry.list.wrongScope`: 403 on both. Match.
- `batch.orgunits`: 200 on both. The mock emits an extra `blockInheritance` field in each part body.

Device, user, and telemetry success shapes have no live evidence. The Easton grant lacks their scopes.

### Calibration changes from the parity check

- An ungranted-scope token request now returns 401 `unauthorized_client`. It returned 400 before. Live evidence supports this. The spec text now matches (spec section Token exchange). The owner has not yet confirmed it.
- `customers.get` now returns `postalAddress.addressLine2`. The value is invented.
- The mock now always emits the OU `description`. Google's behavior for an empty description is unverified.
- A foreign customer ID on Directory routes now returns 400 `badRequest` "Bad Request". It returned 403 `forbidden` before. Live evidence covers `orgunits.list`, `customers.get`, and `domains.list`. Other Directory routes extrapolate from those three. Chrome Management keeps 403.
- An unknown `fields` name now returns 400 `invalidParameter`. The mock checks the name against the union of discovery schema property names (spec section Common behavior). A name valid in another schema passes.

### Remaining shape notes

- The mock emits `blockInheritance` and `domainAliases` extras that Google omits for this tenant.
- The mock lacks Google's `details` on some errors.

## Scale

Task 22 measured the following.

- The `xlarge` tier seeded in 14.9 s.
- The mock served 400,000 devices over 1,334 pages at about 13 ms server time per page.
- It served 365,003 users over 731 pages.
- Telemetry held 380,118 records.
- Resident memory peaked at 546 MB.
- The `large` tier holds 60,000 devices. It seeded in 1.4 s and uses 62 MB on disk.

### Milestone 2 writes

The Task 16 rerun on this branch measured the following on the `xlarge` tier.

- 60,000 devices moved through 1,200 `moveDevicesToOu` parts in 2,567 ms.
- With those before-images pending, device pages took 17 ms of server time on average.
- Before the compound list query of Task 3b, lagging pages took 194 ms.
- With the same before-images pending, telemetry pages of 1,000 devices took 12 ms of server time on average.
- A rename of `/Zone 1` cascaded to 82,096 devices in 1,154 ms.

## Compatibility

Task 20 ran `@googleapis/admin` 37.0.2, `@googleapis/chromemanagement` 31.1.1, and `google-auth-library` 11.2.0 through a CONNECT proxy.
All 10 tests passed. The proxy accepted 20 connections and refused none.

## Findings for Campus Commander

1. Campus Commander requests telemetry without a `reports_timestamp` filter. Google documents that such requests return only recent reports.
   Against the mock, each device shows one battery report instead of a history.
2. The Campus Commander provider maps HTTP 401 to credential-rejected before it checks `unauthorized_client`.
   The delegation-not-authorized outcome is unreachable for token errors. See `libs/google-connection/src/lib/provider.ts`.
3. The Easton fixture does not grant the device read scopes. Device, user, and telemetry parity waits for the owner.
   The owner must add `admin.directory.device.chromeos.readonly`, `admin.directory.user.readonly`, and `chrome.management.telemetry.readonly` to the Easton delegation grant.

## Seed deviations

- The spec estimates about 13,000 org units for the `xlarge` tier. The seed produces about 8,561. The layout is unchanged.
- The owner decides whether to add a layer, such as homerooms, to close the gap.

## Milestone 2 rulings

Live Google evidence for writes does not exist. The Easton authorization does not permit mutations.
Each value below follows the milestone 2 spec or a plan ruling. A live write check would replace it with evidence.

| Value                                     | Mock behavior                                                                      | Status                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| Search delay                              | 300 seconds. Every list lags, and `get` is current.                                | unverified             |
| OU parameters of a lagging list           | Resolve against the lagged OUs                                                     | unverified             |
| Aliases in lagging user lists             | Lag with the user, in list bodies and email queries                                | unverified             |
| Bodiless responses                        | `204` with an empty body                                                           | unverified             |
| Malformed JSON body                       | `400 invalid`, "Invalid JSON payload received."                                    | unverified             |
| Read-only fields in a write body          | Ignored                                                                            | unverified             |
| Unknown OU named by a write               | `400 invalid`                                                                      | unverified             |
| `moveDevicesToOu` with one unknown device | The whole request fails with `400`, and nothing moves.                             | unverified             |
| Device updates by status                  | Every status accepts an update                                                     | unverified             |
| Online window for commands                | Last sync within 24 hours. The window does not scale.                              | unverified             |
| Command timeline                          | Sent at 2 s, acknowledged at 5 s, executed at 10 to 60 s                           | unverified             |
| Command success rate                      | 95%                                                                                | unverified             |
| Command expiry                            | 5 days                                                                             | unverified             |
| Duplicate OU name under one parent        | `400 invalid`, names compare without case                                          | unverified             |
| Write limit response                      | `403 rateLimitExceeded`                                                            | unverified             |
| Write latency                             | 250 ms per write, 10 ms per device, 20 ms per 10,000 cascaded rows                 | unverified             |
| Undelete without `orgUnitPath`            | Restores into `/`                                                                  | unverified             |
| Undelete of an active user                | `400 invalid`                                                                      | unverified             |
| Aliases taken since a delete              | Dropped on undelete                                                                | unverified             |
| Role of a user created through the API    | Staff                                                                              | unverified             |
| User paging during writes                 | Users page by primaryEmail, so a primaryEmail change can move a user between pages | unverified             |
| OU limits                                 | 35 levels and 40,000 OUs per customer, answering 400 invalid                       | unverified             |
| OU subtree matching                       | By path range, so names outside the Basic Multilingual Plane match                 | verified by unit tests |
