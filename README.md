# Admin SDK mock

This service imitates the Google Admin SDK for Campus Commander scale testing.
It answers on the real Google hostnames and serves seeded K-12 domains.

The design is in [docs/specs/2026-10-09-admin-sdk-mock-design.md](docs/specs/2026-10-09-admin-sdk-mock-design.md).

## Develop

Use Node 24.19 and run `npm ci`.
Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run format:check` before each commit.
