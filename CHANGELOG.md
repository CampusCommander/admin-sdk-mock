# Changelog

This file records every notable change to the project.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-10-10

### Added

- Configuration files, environment variables, and command-line flags, with a published JSON schema.
- A CONNECT proxy that routes the four Google hostnames to the mock and refuses or tunnels every other target.
- The `admin-sdk-mock` command-line tool with `start`, `init`, `env`, `doctor`, `config validate`, and `token`. `mockctl` runs the same commands.
- A programmatic API with `startMock`, in-process installation, and TypeScript types.
- The control API requests `GET /info` and `POST /domains/{id}/tokens`.
- Fixtures for hand-written OUs, users, devices, and groups.
- The `empty` seed tier.
- Container image configuration: a mounted configuration file, the proxy port, and the CLI on the path.
- A GitHub action that starts the image and exports the client environment.
- Examples for Node, Python, curl, fixtures, and GitHub Actions.
- Documentation: guides, generated references, and a trust map.
- Package install tests and coverage tests.

### History

- Milestone 1 added Directory and Chrome Management reads.
- Milestone 2 added writes.
- Milestone 3 added groups.
