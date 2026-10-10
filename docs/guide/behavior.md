# Behavior

The mock models the limits and the timing that a Google client meets in production: quota, latency, the search lag, the group delays, and the write limits.
Every value below is a per-domain [setting](configuration.md#settings), and the time scale divides every duration.
The [calibration record](../calibration.md) holds the evidence behind each value, and every ruling that stands in for missing evidence.

## Quota

The mock keeps one quota bucket for each pair of service-account project and delegated subject, per customer and per API.
The nominal quota Q is `quota.perMinute`, 2,400 requests per minute. Chrome Management uses its own buckets with `chromeQuota`.
One plain call counts 1. One batch part counts 1. A rejected request counts nothing.

Each bucket keeps the last 60 minutes, in fixed one-minute windows.

| Bucket state | Admission                                                  |
| ------------ | ---------------------------------------------------------- |
| Unflagged    | Admit while the minute count is below `ceiling` × Q, 125%. |
| Flagged      | Admit while the minute count is below Q.                   |

At the end of each minute, the mock classifies the minute by its admitted count:

| Class  | Admitted count                                                   |
| ------ | ---------------------------------------------------------------- |
| Normal | Q or less.                                                       |
| Over   | More than Q.                                                     |
| Heavy  | More than `heavyRatio` × Q, 112.5%. A heavy minute is also over. |

The mock flags a bucket when its last 60 minutes hold 30 over minutes (`overMinutesToFlag`) or 10 heavy minutes (`heavyMinutesToFlag`).
A flag lasts 60 minutes (`flagMinutes`). Then the bucket returns to the unflagged state.

| API               | Rejection                                  |
| ----------------- | ------------------------------------------ |
| Directory         | `403` with reason `userRateLimitExceeded`. |
| Chrome Management | `429` with status `RESOURCE_EXHAUSTED`.    |

Google sends no `Retry-After` header. The mock sends one only when `retryAfter` is true.
`admin-sdk-mock quota <customerId>` shows each bucket, its minute history, its flag, and the in-flight requests.

### Concurrency caps

| Cap                                                      | Default | Directory rejection                   | Chrome Management rejection |
| -------------------------------------------------------- | ------- | ------------------------------------- | --------------------------- |
| In-flight requests per customer and method (`perMethod`) | 40      | `403` with reason `quotaExceeded`     | `429 RESOURCE_EXHAUSTED`    |
| In-flight requests per customer (`perCustomer`)          | 120     | `429` with reason `rateLimitExceeded` | `429 RESOURCE_EXHAUSTED`    |

Google publishes neither cap, nor a Chrome Management quota. The defaults stand in for them.

## Latency

With `timing.delays` on, each response waits for a modeled time. The delay is the sum of three parts, capped, then raised by load:

| Part       | Model                                                                                                        | Settings                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Round trip | A log-normal draw with a median of 80 ms and a 99th percentile of 400 ms, at most twice the 99th percentile. | `roundTripMedianMs`, `roundTripP99Ms`     |
| Transfer   | The response bytes divided by 8,000,000 bytes per second.                                                    | `bytesPerSecond`                          |
| Compute    | 150 ms, plus 3 ms per returned item, plus 20 ms per 10,000 scanned rows.                                     | `baseMs`, `perItemMs`, `scanPer10kRowsMs` |
| Cap        | The sum of the three parts stops at 2,000 ms.                                                                | `capMs`                                   |
| Load       | 2% more per in-flight request of the customer above 20.                                                      | `loadPercentPerRequest`, `loadThreshold`  |

A write computes with 250 ms (`writeBaseMs`) instead of 150 ms, plus 10 ms per device (`perDeviceWriteMs`) for device moves and status changes.
A batch computes with 150 ms plus 40 ms (`batchPartMs`) for each wave of 10 parts (`batchParallelism`). Its parts add no delay of their own.
A token exchange computes with 30 ms.

`timing.delays: false`, or `admin-sdk-mock clock --delays off`, removes the modeled latency. The time scale divides it.
The defaults target 1 to 2 seconds for a full 300-device page with `projection=FULL`, and 150 to 300 ms for a single `get`.

## The search lag

Google's search index lags writes. Google documents that most updates appear within one hour, and some take up to 36 hours.
The mock lags every list by `writes.searchDelaySeconds`, 300 seconds by default.

A list at time _t_ shows each entity as it was at _t_ − 300 seconds. The lag covers list membership, filters, `query` matching, sort keys, and the returned bodies.
It applies to `chromeosdevices.list`, `users.list`, `orgunits.list`, `telemetry.devices.list`, `groups.list`, `members.list`, and `groups.aliases.list`.
A `get`, `hasMember`, a write, and a write's response read current data.

- A device moved to `/B` stays under `/A` in lists for 300 seconds. `chromeosdevices.get` shows `/B` at once.
- A new user stays out of lists for 300 seconds.
- A deleted user stays in lists for 300 seconds. `users.get` answers `404` at once.
- Two writes 3 minutes apart each surface 300 seconds after they happened.

Three controls end or shorten the lag:

- `admin-sdk-mock index flush <customerId>`, `flush()` in process, or `POST /domains/<customerId>/index/flush` make every pending write visible at once.
- `writes.searchDelaySeconds` set to 0 removes the lag for that domain.
- The time scale shortens it. At scale 60, the lag lasts 5 seconds.

`timing.delays` does not affect the search lag. `GET /domains` reports the pending writes of each domain as `counts.pendingWrites`.

## Group delays

Two more delays apply to groups. The time scale divides both, a value of 0 removes each, and a flush ends both.

| Delay                                 | Default     | Rule                                                                                        |
| ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Nesting delay (`nestingDelaySeconds`) | 600 seconds | `hasMember` and `includeDerivedMembership` follow a new group link only after this delay.   |
| Ready delay (`groupReadySeconds`)     | 60 seconds  | `members.insert` into a group younger than this answers `404 Resource Not Found: groupKey`. |

Google documents both: "a delay up to 10 minutes" for nesting, and "wait a minute before adding a member" for new groups.
A removed group link takes effect at once for `hasMember`. Derived lists drop it after the search lag. The nesting delay applies only to additions.
The cycle check follows every link, including links still inside the nesting delay.
Seeded and fixture groups carry old creation times, so neither delay applies to them.

## Device commands

`issueCommand` starts a computed timeline. No background timer runs. `commands.get` computes the state from the time since issue.

| Device  | Time since issue          | State                                        |
| ------- | ------------------------- | -------------------------------------------- |
| Online  | Under 2 seconds           | `PENDING`                                    |
| Online  | 2 to 5 seconds            | `SENT_TO_CLIENT`                             |
| Online  | 5 seconds until execution | `ACKED_BY_CLIENT`                            |
| Online  | From the execution time   | `EXECUTED_BY_CLIENT`, with a `commandResult` |
| Offline | Before expiry             | `PENDING`                                    |
| Offline | At `commandExpireTime`    | `EXPIRED`                                    |

A device that synced within the last 24 hours is online. That window does not scale.
The execution time falls between 10 and 60 seconds. 95% of executed commands report `SUCCESS`. The domain seed and the command ID decide every outcome.
A command expires 5 days after issue (`commandExpirySeconds`).
`REBOOT`, `WIPE_USERS`, and `REMOTE_POWERWASH` change the device at execution time, and the change lags like any other write.

## Write limits

| Limit                                            | Default | Setting                  | Rejection                             |
| ------------------------------------------------ | ------- | ------------------------ | ------------------------------------- |
| User creations per second per domain             | 10      | `userCreatesPerSecond`   | `403` with reason `rateLimitExceeded` |
| OU creations and updates per second per customer | 1       | `orgUnitWritesPerSecond` | `403` with reason `rateLimitExceeded` |

Deletes have no limit. A rejected write does not use the limit. Each batch part passes the limits on its own.
Group, member, and alias writes have no limit beyond the quota.

Other limits answer `400`:

- A device `annotatedUser` holds 100 characters, `annotatedLocation` 200, and `notes` 500.
- `moveDevicesToOu` and `batchChangeStatus` take 50 device IDs at most.
- An OU sits at most 35 levels deep, and a customer holds at most 40,000 OUs.
- A group `description` holds 4,096 characters.
- A batch holds 1,000 parts at most.

A deleted user stays recoverable for 20 days. The time scale divides that window.

## How the mock differs from Google

The mock follows Google's documentation and the live parity evidence. Where neither exists, a ruling decides.

- Live evidence covers the milestone 1 reads only. No live check covered writes or groups, so every write and group ruling is unverified.
- The search lag is 300 seconds. Google's lag varies, up to 36 hours.
- The Chrome Management quota, the concurrency caps, and the latency constants have no published or measured value.
- Some responses carry extra fields, such as `blockInheritance` and `domainAliases`, and some errors lack Google's `details`.
- A telemetry list without a `reports_timestamp` filter returns the newest report of each device only.

Every ruling has a row in the calibration record:

- [Open calibration values](../calibration.md#calibration-record)
- [Parity results](../calibration.md#parity-results) and [calibration changes from the parity check](../calibration.md#calibration-changes-from-the-parity-check)
- [Remaining shape notes](../calibration.md#remaining-shape-notes)
- [Seed deviations](../calibration.md#seed-deviations)
- [Milestone 2 rulings](../calibration.md#milestone-2-rulings)
- [Milestone 3 rulings](../calibration.md#milestone-3-rulings) and their [execution notes](../calibration.md#execution-notes)
