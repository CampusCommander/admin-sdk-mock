# Changelog

This file records every notable change to the project.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-10-10

The first public release. It is not production ready: any 0.x release may change the configuration, the CLI, the API, or the image.

### Added

- Configuration files, environment variables, and command-line flags, with a published JSON schema.
- A CONNECT proxy that routes the four Google hostnames to the mock and refuses or tunnels every other target.
- The `admin-sdk-mock` command-line tool with `start`, `init`, `env`, `doctor`, `config validate`, and `token`. `mockctl` runs the same commands.
- A programmatic API with `startMock`, in-process installation, and TypeScript types.
- The control API requests `GET /info` and `POST /domains/{id}/tokens`.
- Fixtures for hand-written OUs, users, devices, and groups.
- The `empty` seed tier.
- Container image configuration: a mounted configuration file, the proxy port, the CLI on the path, and an `/out` directory that the `node` user owns.
- A GitHub action that starts the image and exports the client environment.
- Examples for Node, Python, curl, fixtures, and GitHub Actions.
- Documentation: guides, generated references, and a trust map.
- Package install tests, including an install from a Git clone, and coverage tests.
- `env`, `startMock().env()`, and the action export `NODE_USE_ENV_PROXY=1`, so Node's built-in `fetch` uses the proxy.
- The package exports `ConfigError` and `FixtureError`, and the `token()` options take `ttlSeconds`.

### Changed

- The license is the PolyForm Noncommercial License 1.0.0. Any noncommercial use is permitted. Commercial use is not licensed.
- `GET /health` answers `503` until every domain is ready. The image health check reads `MOCK_CONTROL_PORT` and allows 600 seconds to start.
- `compose/standalone.yml` tags its build `admin-sdk-mock:local`, so the build no longer replaces a pulled `ghcr.io/campuscommander/admin-sdk-mock:main`.

### Security

- With `passthrough` on, the proxy refuses local targets such as `127.0.0.1`, `localhost`, and `169.254.169.254`.
- `start` logs a `warning` event when a passthrough proxy listens on an address other than loopback.
- The action rejects a line break in its path and image inputs, and a port outside 1 to 65535.

### History

- Milestone 1 added Directory and Chrome Management reads.
- Milestone 2 added writes.
- Milestone 3 added groups.
