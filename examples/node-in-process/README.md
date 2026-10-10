# Node in-process example

This example starts the mock inside a `node:test` file. It lists users, Chrome devices, and groups. It then inserts a group and reads it back.

## Prerequisites

- Node 24.11 or later.
- The `@googleapis/admin` and `google-auth-library` packages.
- The built mock package. In this repository, run `npm run build`.

## Run it

```bash
node --test examples/node-in-process/directory.test.mjs
```

## How it works

1. `startMock()` starts the listeners and one `small` domain. The seed `example` makes the domain deterministic.
2. `useInProcess()` points this process at the mock proxy and trusts the mock CA. The client code stays unmodified.
3. `mock.credential(customerId, 'read-write')` issues a service account key. A `JWT` signs with it for the administrator.
4. `after()` calls `close()`, which restores the process state and removes the temporary data directory.

## Expected output

```text
✔ lists users, Chrome devices, and groups
✔ inserts a group and reads it back
ℹ tests 2
ℹ pass 2
ℹ fail 0
```
