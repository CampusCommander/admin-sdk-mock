# Trust

This page states what each test layer proves, and which tests prove each acceptance item of every spec.
Every file named here exists in the repository. Run any layer yourself with the command in its row.

## Test layers

| Layer                | Command                 | Runs in                                           | Proves                                                                                                  |
| -------------------- | ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Unit                 | `npm test`              | CI `check`, release `verify`, as the coverage run | Every module's behavior, including configuration, fixtures, proxy, CLI, and API.                        |
| Coverage             | `npm run test:coverage` | CI `check`, release `verify`                      | The unit layer exercises at least the gated share of lines, branches, and functions.                    |
| Contract             | `npm run test:contract` | CI `check`, release `verify`                      | Every response matches Google's discovery schemas.                                                      |
| Node compatibility   | `npm run test:compat`   | CI `check`, release `verify`                      | Google's Node clients work unmodified through the proxy.                                                |
| Python compatibility | `npm run test:python`   | CI `python`                                       | Google's Python clients work unmodified through the proxy.                                              |
| Package              | `npm run test:package`  | CI `package`, release `verify`                    | `npm pack` installs into an empty project, the CLI starts, and the API imports with its types.          |
| Examples             | `npm run test:examples` | CI `check`                                        | Every documented Node, curl, and fixtures example runs as written.                                      |
| Docs                 | part of `npm test`      | CI `check`, release `verify`                      | Generated references match the schema, the CLI, and the route table.                                    |
| Image                | CI `image` job          | CI `image`                                        | The image starts from a mounted configuration, serves the proxy, and passes the Campus Commander smoke. |
| Action               | CI `action` job         | CI `action`                                       | The action starts the mock and exports a working client environment.                                    |
| Scale                | `npm run test:scale`    | CI `scale`, on pushes and manual runs             | Chicago-size domains page within the latency bound.                                                     |
| Live parity          | `npm run parity`        | The owner, by hand                                | The mock's milestone 1 responses match live Google for the Easton fixture.                              |

[.github/workflows/ci.yml](../.github/workflows/ci.yml) defines the CI jobs. It runs on pull requests, on pushes to `main`, and on `workflow_dispatch`.
The `scale` job skips pull requests. It runs on pushes and on `workflow_dispatch`.
[.github/workflows/release.yml](../.github/workflows/release.yml) runs on a `vX.Y.Z` tag. Its `verify` job runs format, lint, type, coverage, contract, compatibility, and package checks before it publishes.
The `test:coverage` script in [package.json](../package.json) holds the coverage thresholds. It also runs the parity comparison tests, outside the measurement.

The layer sources:

| Layer                | Files                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit and docs        | `src/**/*.test.ts`, `parity/compare.test.ts`, and [src/docs/generate.test.ts](../src/docs/generate.test.ts)                                                                                                                                      |
| Contract             | [test/contract/contract.test.ts](../test/contract/contract.test.ts), [test/contract/validate.test.ts](../test/contract/validate.test.ts), and the discovery documents in `test/contract/discovery/`                                              |
| Node compatibility   | [test/compat/run.ts](../test/compat/run.ts), which runs `directory`, `chrome`, `writes`, and `groups` `.compat.ts` files in `test/compat/`                                                                                                       |
| Python compatibility | [test/python/run.ts](../test/python/run.ts), which runs [examples/python](../examples/python)                                                                                                                                                    |
| Package              | [test/package/run.ts](../test/package/run.ts)                                                                                                                                                                                                    |
| Examples             | [test/examples/run.ts](../test/examples/run.ts), which runs [examples/node-in-process](../examples/node-in-process), [examples/node-cli](../examples/node-cli), [examples/curl](../examples/curl), and [examples/fixtures](../examples/fixtures) |
| Image                | [scripts/image-smoke.sh](../scripts/image-smoke.sh) with [scripts/smoke-config.json](../scripts/smoke-config.json), and [compose/smoke.yml](../compose/smoke.yml) with the overlay                                                               |
| Action               | [action.yml](../action.yml) with [examples/github-actions/admin-sdk-mock.json](../examples/github-actions/admin-sdk-mock.json) and `examples/node-cli/list-users.mjs`                                                                            |
| Scale                | [test/scale/scale.ts](../test/scale/scale.ts)                                                                                                                                                                                                    |
| Live parity          | [parity/live.ts](../parity/live.ts), [parity/probes.ts](../parity/probes.ts), and the evidence in `parity/evidence/live-2026-10-09.json`                                                                                                         |

## Milestone 1

Spec: [Admin SDK mock design](specs/2026-10-09-admin-sdk-mock-design.md#milestone-1-acceptance).

| Acceptance item                                                                                       | Proof                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `mockctl` creates and seeds an `xlarge` domain, and the same specification reproduces it exactly.  | `src/control/mockctl.test.ts`, `src/seed/seed.test.ts` (identical data from one specification), `src/seed/spec.test.ts`, and `test/scale/scale.ts` (the `xlarge` seed).       |
| 2. The Google client lists and gets every milestone 1 resource unmodified, plainly and in batches.    | `test/compat/directory.compat.ts` and `test/compat/chrome.compat.ts` through `test/compat/run.ts`, and `src/batch/batch.test.ts`.                                             |
| 3. Every milestone 1 response passes discovery schema validation.                                     | `test/contract/contract.test.ts`, the milestone 1 test.                                                                                                                       |
| 4. A sustained 110% load flags after 30 scaled minutes, the penalty lasts 60, and admission recovers. | `src/quota/bucket.test.ts` and `src/quota/limits.test.ts`.                                                                                                                    |
| 5. The live parity check matches the Easton response shapes.                                          | `parity/live.ts` by hand, and `parity/compare.test.ts`. All 19 probes match in status, and six have shape notes. See the [calibration record](calibration.md#parity-results). |
| 6. Campus Commander connects through the overlay and syncs 60,000 devices, with no file changed.      | Not automated. The CI `image` job runs the overlay smoke in `compose/smoke.yml`. The full run awaits the owner. See [docs/campus-commander.md](campus-commander.md).          |

## Milestone 2

Spec: [milestone 2 writes design](specs/2026-10-09-milestone-2-writes-design.md#milestone-2-acceptance).

| Acceptance item                                                                            | Proof                                                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 1. The Google client performs every milestone 2 method unmodified, plainly and in batches. | `test/compat/writes.compat.ts` through `test/compat/run.ts`.                                                    |
| 2. Every milestone 2 response passes discovery schema validation.                          | `test/contract/contract.test.ts`, the milestone 2 test.                                                         |
| 3. Lists lag writes, `get` is current, and a flush or a delay of 0 removes the lag.        | `src/directory/lag.test.ts`, `src/store/lag.test.ts`, and `src/control/control.test.ts` (the index flush test). |
| 4. Both write limits return their specified errors.                                        | `src/quota/write-limits.test.ts`.                                                                               |
| 5. A domain reset discards every write.                                                    | `src/control/control.test.ts` (the reset test) and `src/domains.test.ts`.                                       |
| 6. The scale test passes.                                                                  | `test/scale/scale.ts`. The measured run is in the [calibration record](calibration.md#milestone-2-writes).      |
| 7. CI passes on `main` and publishes the image.                                            | The CI `image` job in `.github/workflows/ci.yml` publishes `:main` on each push to `main`.                      |

## Milestone 3

Spec: [milestone 3 groups design](specs/2026-10-10-milestone-3-groups-design.md#milestone-3-acceptance).

| Acceptance item                                                                                  | Proof                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The Google client performs every milestone 3 method unmodified, plainly and in batches.       | `test/compat/groups.compat.ts` through `test/compat/run.ts`.                                                                                                                                                                                 |
| 2. Every milestone 3 response passes discovery schema validation.                                | `test/contract/contract.test.ts`, the milestone 3 test.                                                                                                                                                                                      |
| 3. Group lists lag writes, nested reads wait for the nesting delay, and flush and 0 remove both. | `src/directory/groups.test.ts`, `src/directory/members.test.ts`, `src/directory/has-member.test.ts`, `src/directory/group-aliases.test.ts`, `src/directory/member-writes.test.ts`, and `src/control/control.test.ts` (the delay flush test). |
| 4. Cycles are rejected.                                                                          | `src/directory/member-writes.test.ts`, `src/directory/group-graph.test.ts`, and `src/seed/groups.test.ts`.                                                                                                                                   |
| 5. A domain reset discards every group write.                                                    | `src/control/control.test.ts` (the group reset test).                                                                                                                                                                                        |
| 6. The scale test passes with groups.                                                            | `test/scale/scale.ts`. The measured run is in the [calibration record](calibration.md#milestone-3-scale).                                                                                                                                    |
| 7. CI passes on `main` and publishes the image.                                                  | The CI `image` job in `.github/workflows/ci.yml`.                                                                                                                                                                                            |

## Version 1.0

Spec: [productization design](specs/2026-10-10-productization-design.md#acceptance).

| Acceptance item                                                                                                        | Proof                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. An install from the tag yields working `admin-sdk-mock` and `mockctl` commands and a typed API.                     | `test/package/run.ts` installs the packed tarball into an empty project, runs both commands, lists users through the CLI and the API, and type-checks a consumer. `src/version.test.ts`. An install from the tag itself awaits the tag. |
| 2. A configuration file declares domains, settings, fixtures, service accounts, and faults, and `start` produces them. | `src/startup/ensure-domains.test.ts`, `src/server.test.ts`, `src/cli/cli.test.ts`, `src/main.test.ts`, `src/config/config.test.ts`, and `src/seed/fixtures.test.ts`.                                                                    |
| 3. Unmodified Node and Python clients reach the mock through the proxy, with no root and no hosts file.                | `test/compat/run.ts`, `src/index.test.ts`, `src/server.test.ts`, `src/proxy.test.ts`, `test/examples/run.ts`, and `test/python/run.ts`.                                                                                                 |
| 4. The image starts from a mounted configuration, and the action starts the mock in a workflow.                        | The CI `image` job runs `scripts/image-smoke.sh`. The CI `action` job runs `action.yml` and lists users with `examples/node-cli/list-users.mjs`.                                                                                        |
| 5. Every documented example runs in CI, and every generated reference matches its source.                              | `test/examples/run.ts`, `test/python/run.ts`, the CI `action` job, and `src/docs/generate.test.ts`.                                                                                                                                     |
| 6. Every test layer passes in CI, and the coverage gate holds.                                                         | `.github/workflows/ci.yml` and `.github/workflows/release.yml`. The gate lives in the `test:coverage` script of `package.json`.                                                                                                         |
| 7. The milestone 1 to 3 behavior and the Campus Commander overlay keep working unchanged.                              | Every milestone 1 to 3 test above, `src/control/mockctl.test.ts`, and the overlay smoke in the CI `image` job.                                                                                                                          |

## Security

Spec: [productization design, Security](specs/2026-10-10-productization-design.md#security).

| Requirement                                                                                                      | Proof                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The mock never accepts a real Google credential. Every key it issues is its own.                                 | `src/auth/token.test.ts` rejects an assertion from an unknown account, and `src/auth/accounts.test.ts` covers issued keys.                                             |
| The mock writes key files with mode 0600.                                                                        | `src/startup/ensure-domains.test.ts`, `src/control/mockctl.test.ts`, `src/cli/cli.test.ts`, and `src/ca.test.ts` for the CA keys.                                      |
| Logs never print private keys.                                                                                   | No test reads the log for keys. `src/auth/accounts.test.ts` proves that the registry never stores a private key. The log events in `src/server.ts` carry no key field. |
| The control API keeps its host and content-type guards, and binds to `127.0.0.1` outside the image.              | `src/control/control.test.ts` and `src/config/config.test.ts` (the defaults).                                                                                          |
| The proxy refuses every target outside the four Google hostnames unless `passthrough` is on, and never decrypts. | `src/proxy.test.ts` and `src/server.test.ts`.                                                                                                                          |
| With `passthrough` on, the proxy refuses local targets, and `start` warns when it listens beyond loopback.       | `src/proxy.test.ts` (the local target test) and `src/server.test.ts` (the warning tests).                                                                              |
