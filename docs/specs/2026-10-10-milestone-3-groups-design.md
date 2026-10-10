# Admin SDK mock: milestone 3 groups design

Status: design and written spec approved by the owner on 2026-10-10.
Source: owner interview with Claude on 2026-10-10.
Parent: [Admin SDK mock design](2026-10-09-admin-sdk-mock-design.md). Every rule of the parent spec and of the
[milestone 2 writes design](2026-10-09-milestone-2-writes-design.md) still applies unless this spec changes it.

## Purpose

Milestone 3 adds the groups that decision D3 of the parent spec assigns to it.
The Campus Commander development order puts groups after devices, Google users, and OUs.
Its groups gap G21 needs membership browsing, nested and outside members, and bulk membership changes through jobs.
Campus Commander's open question 23 names the cost of syncing every group's members. Only a Chicago-size domain shows that cost.

Live parity evidence for groups does not exist. The owner chose no live check on 2026-10-10.
Group behavior follows Google's reference documentation, guides, limits page, and discovery document.
Each rule without a documented source is marked **Ruling**.

## Owner decisions

| ID    | Decision                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| M3-D1 | Seeds contain structural groups and class-section groups, as described in [Seed rules](#seed-rules).                   |
| M3-D2 | Memberships store direct links only. Nested membership is resolved on each read.                                       |
| M3-D3 | The group, member, alias, timing, interaction, limit, and testing rules below are approved as presented on 2026-10-10. |
| M3-D4 | No live check. The rulings stay unverified against live Google.                                                        |

## Exclusions

- The Groups Settings API, as in the parent spec.
- Cloud Identity groups, dynamic groups, security labels, and `checkTransitiveMembership`.
- `groups.list` and `members.list` watch channels.
- `nonEditableAliases` contents. The field is omitted, as it is for users.
- Group conversation content and mail delivery.
- Live parity for groups. See M3-D4.

## API surface

All paths are on `admin.googleapis.com` under `/admin/directory/v1`. Every method also runs inside the Directory batch.

| Method                  | HTTP     | Path                                       |
| ----------------------- | -------- | ------------------------------------------ |
| `groups.list`           | `GET`    | `/groups`                                  |
| `groups.get`            | `GET`    | `/groups/{groupKey}`                       |
| `groups.insert`         | `POST`   | `/groups`                                  |
| `groups.update`         | `PUT`    | `/groups/{groupKey}`                       |
| `groups.patch`          | `PATCH`  | `/groups/{groupKey}`                       |
| `groups.delete`         | `DELETE` | `/groups/{groupKey}`                       |
| `groups.aliases.list`   | `GET`    | `/groups/{groupKey}/aliases`               |
| `groups.aliases.insert` | `POST`   | `/groups/{groupKey}/aliases`               |
| `groups.aliases.delete` | `DELETE` | `/groups/{groupKey}/aliases/{alias}`       |
| `members.list`          | `GET`    | `/groups/{groupKey}/members`               |
| `members.get`           | `GET`    | `/groups/{groupKey}/members/{memberKey}`   |
| `members.insert`        | `POST`   | `/groups/{groupKey}/members`               |
| `members.update`        | `PUT`    | `/groups/{groupKey}/members/{memberKey}`   |
| `members.patch`         | `PATCH`  | `/groups/{groupKey}/members/{memberKey}`   |
| `members.delete`        | `DELETE` | `/groups/{groupKey}/members/{memberKey}`   |
| `members.hasMember`     | `GET`    | `/groups/{groupKey}/hasMember/{memberKey}` |

The parent spec lists no `members.patch`. The discovery document defines it, so milestone 3 adds it.
A method without a response schema returns `204` with an empty body, as in milestone 2.

### Keys

A `groupKey` is the group's email, one of its aliases, or its ID.
A `memberKey` is a user's primary email, alias, or ID, or a group's email, alias, or ID.
Keys match emails without regard to case, as user keys do.
An unknown `groupKey` returns `404` with the message `Resource Not Found: groupKey`.
An unknown `memberKey` returns `404` with the message `Resource Not Found: memberKey`.

## Seed rules

Every tier gets groups. The seed specification decides every group, member, role, and ID, like the rest of the seed.
Groups are seeded after users. Seeded groups and memberships have creation times far enough in the past that no delay applies.

### Per school

| Group        | Address                                         | Direct members                                                                |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Staff        | `<school>-staff@<primary domain>`               | The school's staff. One is `OWNER`. One or two are `MANAGER`.                 |
| Grade        | `<school>-<grade>@<student domain>`             | The students of one student OU. One group per student OU that holds students. |
| Students     | `<school>-students@<student domain>`            | The school's grade groups, as `GROUP` members.                                |
| School-wide  | `<school>-all@<primary domain>`                 | The staff group and the students group, as `GROUP` members.                   |
| Parent group | `<school>-parents@<primary domain>`             | The staff group owner as `OWNER`, and 3 to 12 outside members.                |
| Club         | `<club>-<school>@<student domain>`              | About 2 per school. A staff `OWNER`, other staff, and students of the school. |
| Section      | `<course>-p<period>-<teacher>@<student domain>` | A teacher of the school as `OWNER`, and about 25 students of one grade.       |

A school-wide group reaches a student through three levels: school-wide, students, and grade.
The `<grade>` part is the student OU's name, such as `grade-5` or `class-of-2031`.

Section groups:

- Each student joins `sectionsPerStudent` distinct sections of the student's grade. The default is 4.
- A grade holds `ceil(students × sectionsPerStudent / 25)` sections, so a section has about 25 students.
- A grade with fewer sections than `sectionsPerStudent` puts each student in every section.
- The course comes from a catalog for the grade band. The display name reads like `Algebra I – Period 3 (Rivera)`.
- The teacher is a random staff member of the school. A school without staff uses a district staff member.

Clubs have `adminCreated: false`. Every other seeded group has `adminCreated: true`.

### District

| Group           | Address                    | Direct members                                                                                                          |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| All staff       | `all-staff@<primary>`      | The district staff, and every school staff group. In `xlarge`, the region staff groups replace the school staff groups. |
| Region staff    | `<region>-staff@<primary>` | `xlarge` only: the staff groups of the region's schools. Each is a member of all staff.                                 |
| All students    | `all-students@<primary>`   | Every school students group.                                                                                            |
| Everyone        | `everyone@<primary>`       | One `CUSTOMER` member, which stands for every user of the customer.                                                     |
| Technology team | `tech-team@<primary>`      | The seeded administrators.                                                                                              |
| Principals      | `principals@<primary>`     | The `OWNER` of each school staff group.                                                                                 |
| Board           | `board@<primary>`          | Five to nine outside members, and the first administrator as `OWNER`.                                                   |

In an `xlarge` domain, all staff reaches a teacher through three levels: all staff, region staff, and school staff.

### Scenarios

Each rate is a per-domain default and accepts an override in the seed specification's `rates` object.

| Rate                   | Default | Meaning                                                                                                                                             |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sectionsPerStudent`   | 4       | Section groups per student.                                                                                                                         |
| `externalMemberGroups` | 0.03    | Share of groups with outside members. Parent groups and the board count first. Random clubs and sections fill the rest with one outside guest each. |
| `emptyGroups`          | 0.02    | Share of groups without members. These are extra sections of courses that no student takes.                                                         |
| `groupAliases`         | 0.10    | Share of groups with one alias on the primary domain.                                                                                               |
| `deepGroupChains`      | 1       | Chains of 8 to 10 nested groups. The last group of a chain holds 3 staff members.                                                                   |

An outside member is a `USER` member whose address is on a domain outside the customer, under `.test`.
Google documents the `EXTERNAL` type as "Not currently used", so no seeded member has that type.

Delivery settings: 85% `ALL_MAIL`, 7% `DIGEST`, 4% `DAILY`, and 4% `NONE`.

### Size

| Tier     | Groups  | Memberships |
| -------- | ------- | ----------- |
| `small`  | ~110    | ~2,600      |
| `medium` | ~1,100  | ~31,000     |
| `large`  | ~8,700  | ~260,000    |
| `xlarge` | ~59,000 | ~1,700,000  |

These are estimates. The seed tests and the scale test record the exact figures.
The 2026-10-10 `xlarge` run measured 60,301 groups, 1,705,693 memberships, and a 1,022 MB database file. Milestone 2 measured 546 MB.

## Groups

### `list`

| Parameter    | Rule                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------- |
| `customer`   | The customer's groups, on every domain. Accepts `my_customer`.                                     |
| `domain`     | The groups on one domain. With `customer` as well, the result is that domain's groups.             |
| `userKey`    | The groups that a user or group is a direct member of. With `customer`, the request returns `400`. |
| `query`      | See below.                                                                                         |
| `maxResults` | 1 to 200. The default is 200.                                                                      |
| `orderBy`    | `email`.                                                                                           |
| `sortOrder`  | `ASCENDING` or `DESCENDING`. Only used with `orderBy`.                                             |
| `pageToken`  | Bound to its query, as in milestone 1.                                                             |

A request without `customer`, `domain`, or `userKey` returns `400 Bad Request`, as `users.list` does.
**Ruling:** the `userKey` of a user or group outside the customer returns `400`.
**Ruling:** `userKey` and `memberKey` match direct memberships only.
Results come in email order.

`query` fields:

| Field       | Operators       | Rule                                                                                   |
| ----------- | --------------- | -------------------------------------------------------------------------------------- |
| `email`     | `=`, `:prefix*` | The group's email.                                                                     |
| `name`      | `=`, `:prefix*` | The group's name.                                                                      |
| `memberKey` | `=`             | Groups that the user or group is a direct member of. Accepts emails, aliases, and IDs. |

Values may be quoted with single quotes, and `\'` escapes a quote. Clauses combine with an implicit `AND`.
`memberKey` with `email` or `name` in the same query returns `400`.
Any other field or operator returns the `400` response that `users.list` returns for an unsupported query.

### `get`

The response is the group resource:

| Field                          | Value                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `kind`                         | `admin#directory#group`                                                                                       |
| `id`                           | **Ruling:** 15 characters, `0` followed by 14 lowercase letters and digits.                                   |
| `email`, `name`, `description` | Stored values.                                                                                                |
| `directMembersCount`           | A string. **Ruling:** counts every direct member, with a child group counted once.                            |
| `adminCreated`                 | Stored value.                                                                                                 |
| `aliases`                      | The group's aliases in alias order. Omitted when empty.                                                       |
| `etag`                         | **Ruling:** changes whenever the rendered group changes: its fields, its aliases, or its direct member count. |

### `insert`

| Condition                                                                            | Response                      |
| ------------------------------------------------------------------------------------ | ----------------------------- |
| `email` is missing.                                                                  | `400 Invalid Input: email`    |
| The email domain is not one of the customer's domains.                               | `400 Invalid Input: email`    |
| The address is already a user's primary email or alias, or a group's email or alias. | `409` with reason `duplicate` |
| `description` is longer than 4,096 characters.                                       | `400` with reason `invalid`   |

**Ruling:** `name` defaults to the local part of the email.
A group created through the API has `adminCreated: true` and `directMembersCount: "0"`.
`id`, `adminCreated`, `aliases`, `nonEditableAliases`, and `directMembersCount` in the body are ignored, as Google documents.

### `update` and `patch`

Both methods change only the fields present in the body. The writable fields are `email`, `name`, and `description`.
**Ruling:** an email change keeps the old address as an alias, as a user's `primaryEmail` change does.
A new address already in use returns `409`. The `insert` rules for the domain and the description apply.

### `delete`

The delete removes the group, its aliases, its direct memberships, and its membership in other groups.
User accounts stay, as Google documents.
Each parent group's `directMembersCount` and `etag` change.

## Members

### Member resource

| Field               | Value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `kind`              | `admin#directory#member`                                                                            |
| `id`                | The user's ID, the group's ID, or the customer ID. **Ruling:** an outside member has a 21-digit ID. |
| `email`             | The member's current primary email. Omitted for a `CUSTOMER` member.                                |
| `role`              | `OWNER`, `MANAGER`, or `MEMBER`.                                                                    |
| `type`              | `USER`, `GROUP`, or `CUSTOMER`.                                                                     |
| `status`            | **Ruling:** `SUSPENDED` for a suspended user. `ACTIVE` otherwise.                                   |
| `delivery_settings` | Returned by `get`, `insert`, `update`, and `patch` only, as Google documents.                       |
| `etag`              | Changes on every write to the membership.                                                           |

A user's or group's email change updates the member email in every membership, as Google documents.
A user's suspension changes the computed status only.

### `list`

| Parameter                  | Rule                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| `maxResults`               | 1 to 200. The default is 200.                                                |
| `roles`                    | A comma list of `OWNER`, `MANAGER`, and `MEMBER`. Other values return `400`. |
| `includeDerivedMembership` | `true` adds the members of nested groups.                                    |
| `pageToken`                | Bound to its query.                                                          |

Members come in member-email order, as Google documents. **Ruling:** a `CUSTOMER` member sorts first.
List entries omit `delivery_settings`.

With `includeDerivedMembership`:

- The result holds every distinct member reachable through followable group links, including the nested groups themselves.
- A group link is followable once the nesting delay has passed since it was added. See [Timing](#timing).
- **Ruling:** each member appears once. Its role is the highest role it holds in any reached group, in the order `OWNER`, `MANAGER`, `MEMBER`.
- `roles` filters on that role.

### `get`

**Ruling:** `get` returns direct memberships only. A nested member returns `404`.

### `insert`

The body names the member by `email` or `id`. `role` defaults to `MEMBER`. `delivery_settings` defaults to `ALL_MAIL`.

| Member key                                  | Stored type |
| ------------------------------------------- | ----------- |
| A user's primary email, alias, or ID        | `USER`      |
| A group's email, alias, or ID               | `GROUP`     |
| The customer ID                             | `CUSTOMER`  |
| An address on a domain outside the customer | `USER`      |

| Condition                                                                  | Response                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Neither `email` nor `id` is present.                                       | `400 Invalid Input: memberKey`                                      |
| `role` or `delivery_settings` has an unknown value.                        | `400` with reason `invalid`                                         |
| An address on a customer domain names no user or group.                    | **Ruling:** `404 Resource Not Found: memberKey`                     |
| The member is already a direct member.                                     | **Ruling:** `409 Member already exists.`, reason `duplicate`        |
| The member is the group itself, or the group is reachable from the member. | **Ruling:** `400 Cyclic memberships not allowed.`, reason `invalid` |
| The group was created less than the ready delay ago.                       | **Ruling:** `404 Resource Not Found: groupKey`                      |

The cycle check follows every group link, including links still inside the nesting delay.
The response is the member resource.

### `update` and `patch`

Both methods change only `role` and `delivery_settings`. Other fields in the body are ignored.
An unknown value returns `400` with reason `invalid`. A key that is not a direct member returns `404`.

### `delete`

The delete removes one direct membership. A key that is not a direct member returns `404`.

### `hasMember`

The response is `{"isMember": true}` or `{"isMember": false}`.

1. The `memberKey` must name a user. **Ruling:** a group key, an outside address, or the customer ID returns `400 Invalid Input: memberKey`.
2. A direct membership returns `true` on any domain.
3. Otherwise, a user and a group on different email domains return `400 Invalid Input`, as Google documents.
4. Otherwise, the answer follows followable group links. A `CUSTOMER` member reached this way contains every user.

Seeded students are on the student domain. A nested check from a primary-domain group to a student therefore returns `400`.

## Group aliases

| Method   | Rule                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`   | `{"kind": "admin#directory#aliases", "aliases": [...]}`. Each entry has `kind` `admin#directory#alias`, `id`, `primaryEmail`, `alias`, and `etag`. |
| `insert` | The body's `alias` must be on one of the customer's domains, or the request returns `400`. An address in use returns `409`.                        |
| `delete` | An alias that the group does not hold returns `404`.                                                                                               |

An alias works as a `groupKey` and as a `memberKey` at once.

## Timing

All three durations are per-domain settings. The time scale divides them. A value of 0 disables each one.

| Rule                                                                                                              | Default     | Source                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `groups.list`, `members.list`, and `groups.aliases.list` lag writes by the search delay _D_.                      | 300 seconds | The search-groups guide documents the lag. M2-D1 covers every list. |
| A new group link is not followed by `hasMember` or `includeDerivedMembership` until the nesting delay has passed. | 600 seconds | The limits page: "a delay up to 10 minutes".                        |
| `members.insert` into a group created less than the ready delay ago returns `404`.                                | 60 seconds  | The groups guide: "wait a minute before adding a member".           |

The lag follows the milestone 2 contract. Group, membership, and group alias rows receive before-images.
List membership, filters, `query` matching, `userKey` matching, sort keys, and returned bodies all lag.
`get`, `hasMember`, writes, and write responses use current data. Cycle checks use current data.
`includeDerivedMembership` reads lagged memberships and applies the nesting delay on top.

**Ruling:** a removed group link takes effect at once for `hasMember`.
Derived lists read lagged memberships, so they drop the link after the search delay. The nesting delay applies only to additions.
**Ruling:** `groups.list` `userKey` and `memberKey` lookups still find the member during the search delay after a group or user email change.
They match the member ID plus every current address of the target: its primary email and its aliases.
A rename keeps the old address as an alias, so lagged rows that still hold it match.

Groups and members page by email. An email change can move an entry between pages, like a user's `primaryEmail` change.

## Interaction with milestone 2 writes

| Write                                         | Effect on groups                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `users.delete`                                | Removes the user's memberships. Each parent group's count and `etag` change.                  |
| `users.undelete`                              | **Ruling:** restores the memberships that the delete removed, except in groups deleted since. |
| `users.update` or `patch` with `primaryEmail` | Updates the member email in every membership.                                                 |
| `users.update` or `patch` with `suspended`    | Changes the computed member status only.                                                      |
| `users.insert` or a `primaryEmail` change     | An address used by a group or group alias returns `409`.                                      |
| OU writes                                     | None. Groups do not belong to OUs.                                                            |

Each changed membership receives a before-image, so `members.list` keeps showing the old state for _D_.

## Scopes

| Methods                               | Accepted scopes                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `groups` reads, `groups.aliases.list` | `admin.directory.group`, `admin.directory.group.readonly`                                                                          |
| `groups` writes, alias writes         | `admin.directory.group`                                                                                                            |
| `members` reads                       | `admin.directory.group`, `admin.directory.group.readonly`, `admin.directory.group.member`, `admin.directory.group.member.readonly` |
| `members` writes                      | `admin.directory.group`, `admin.directory.group.member`                                                                            |

The test scope sets gain `admin.directory.group.readonly` for reads and `admin.directory.group` for writes.
A token without an accepted scope receives `403` with the message "Request had insufficient authentication scopes."

## Limits and quota

Each call or batch part counts 1 against the parent spec's Directory bucket. The concurrency caps apply unchanged.
**Ruling:** Google documents no per-second limit for group writes. Group writes have no limit beyond the quota.

## Latency

| Cost                                                                      | Default                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Group, member, and alias list pages                                       | The existing per-item read cost.                       |
| Base compute per group, member, or alias write                            | 250 ms, the milestone 2 setting.                       |
| Membership rows visited by `includeDerivedMembership` and `groups.delete` | 20 ms per 10,000 rows, the existing scan-cost setting. |

**Ruling:** these costs are defaults without live calibration.

## Batch and faults

Every milestone 3 method runs inside the Directory multipart batch. Each part passes quota admission separately.
Every existing fault applies to milestone 3 methods. Fault method IDs include the new methods.

## Control listener and settings

`POST /domains/{id}/index/flush` also ends every pending nesting and ready delay.
`POST /domains/{id}/reset` discards every group write.
`GET /domains` reports the group and membership counts of each domain.

New per-domain settings:

| Setting               | Default     |
| --------------------- | ----------- |
| `nestingDelaySeconds` | 600 seconds |
| `groupReadySeconds`   | 60 seconds  |

## Testing

### Unit tests

- every group, member, and alias handler, including each `400`, `404`, and `409` case above;
- `groups.list` by customer, domain, `userKey`, and each `query` field;
- `members.list` with `roles` and `includeDerivedMembership`;
- cycles: a group in itself, a two-group cycle, and a cycle through a chain of 10;
- the nesting delay, the ready delay, flush, and a delay of 0;
- the cross-domain `hasMember` rule and a `CUSTOMER` member;
- the lag for group, membership, and alias writes, and paging during writes;
- the effects of user delete, undelete, rename, and suspension;
- address collisions between users, user aliases, groups, and group aliases;
- seed determinism, the per-tier group and membership counts, and each scenario rate.

### Contract tests

Every milestone 3 response is validated against the discovery schema of its method.

### Client compatibility tests

Google's `googleapis` client performs every milestone 3 method through the proxy, as plain calls and inside a batch.

### Scale test

On an `xlarge` domain at a compressed time scale, the scale test:

1. records the seed time and the database size with groups;
2. pages through every group;
3. pages through the members of a sample of 1,000 groups;
4. pages through the derived membership of `all-students`, about 320,000 members;
5. runs `hasMember` from the top of a deep chain to a user at its bottom.

Each list checks the milestone 1 bound: the mean server time per page is at most 250 ms above the scaled 2-second cap.

**Risk:** a derived-membership page sorts a union of up to 320,000 rows on each request.
If that misses the bound, the plan adds an expansion cached per page token.

### Calibration record

`docs/calibration.md` lists every ruling of this spec as unverified against live Google.

## Milestone 3 acceptance

Milestone 3 is complete when all of these hold:

1. The Google client performs every milestone 3 method without modification, through plain calls and batches.
2. Every milestone 3 response passes discovery schema validation.
3. Group lists lag writes by the search delay. Nested reads wait for the nesting delay. Flush and delays of 0 remove both.
4. Cycles are rejected.
5. A domain reset discards every group write.
6. The scale test passes with groups.
7. CI passes on `main` and publishes the image.
