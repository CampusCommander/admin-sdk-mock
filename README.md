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
