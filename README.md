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
