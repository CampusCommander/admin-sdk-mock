# Admin SDK mock: productization design

Status: written under the owner's autonomy grant of 2026-10-10 and implemented as version 1.0.0. Awaiting owner review.
Source: owner request on 2026-10-10.
Parents: [Admin SDK mock design](2026-10-09-admin-sdk-mock-design.md) and its milestone specs. Every rule of those specs still applies unless this spec changes it.

## Purpose

The owner asked to "productize this":

> It needs a way to be used anywhere these apis need to be tested. It needs streamlined installation, robust documentation, custom configurations, and tests that prove the code can be trusted.

Today the mock serves Campus Commander through Docker network aliases or `/etc/hosts` edits, a port-443 bind, and seeded K-12 domains.
Version 1.0 makes the same mock usable by any project that calls the Google Admin SDK Directory API, the Chrome Management telemetry API, or the Google OAuth service-account flow.
That includes Node and Python applications, CI pipelines, and local development, on Linux, macOS, and Windows.

The mock stays test infrastructure. It never serves production traffic.

## Autonomous decisions

The owner went to bed on 2026-10-10 at 01:10 EDT and authorized full autonomy.
Each decision below stands in for an owner answer. Each one is reversible, and the owner reviews it in the morning.

| ID    | Decision                                                                                                                                                               | Cost if wrong                                                                |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| P-D1  | Distribution stays private. The package installs from the private GitHub repository by tag. No public npm publish, no public image, no repository visibility change.   | The owner wants a public release. That is one more workflow step.            |
| P-D2  | Three install paths: an npm git dependency, the Docker image, and a GitHub Actions composite action.                                                                   | One path goes unused.                                                        |
| P-D3  | A built-in CONNECT proxy is the portable integration path. Clients set `HTTPS_PROXY` and trust the mock CA. No root, no hosts file, no port 443.                       | A client ignores proxies. The hosts-file path still works.                   |
| P-D4  | Configuration is one JSON file with a published JSON Schema. Command-line flags override environment variables, which override the file, which overrides the defaults. | YAML users convert their file.                                               |
| P-D5  | Fixtures let a test declare exact OUs, users, devices, and groups. A new `empty` tier seeds only the root OU and one administrator.                                    | Generated tiers alone covered most needs.                                    |
| P-D6  | The package ships compiled JavaScript in `dist/`. Node refuses to type-strip files inside `node_modules`. Development still runs `.ts` files directly.                 | None. Node leaves no other option.                                           |
| P-D7  | Python is the second proven client language. CI runs the documented Python example against the mock.                                                                   | Go or Java users rely on the proxy contract without a CI proof.              |
| P-D8  | Version 1.0.0. A tag-triggered release workflow builds the package tarball and the image. No tag is pushed until the owner decides.                                    | None until the owner tags.                                                   |
| P-D9  | A coverage gate equals the measured baseline rounded down to a whole percent, with at least 85% of lines.                                                              | The gate blocks a change that only removes tested code.                      |
| P-D10 | The license is a proprietary notice for CampusCommander, and `package.json` says `UNLICENSED`. The repository is private internal test infrastructure.                 | The owner picks an open license. That is a one-file change.                  |
| P-D11 | The configuration file proxy defaults to `passthrough: false`. The in-process API defaults to `passthrough: true`, so a test's other HTTPS calls keep working.         | A test expects the proxy to block other hosts. It sets `passthrough: false`. |

## Exclusions

- Public registries and public images. See P-D1.
- Google APIs beyond the current surface: Directory customers, domains, OUs, Chrome devices, device commands, users, groups, members, group aliases, Chrome Management telemetry, and OAuth.
- Interception of hosts other than the four Google hostnames. The proxy never decrypts or forwards other traffic unless `passthrough` is on, and then it only tunnels.
- A graphical console.
- Native installers, system services, and Windows-specific packaging. Node and Docker cover every platform.
- Changes to `campus-commander`.

## Distribution

### Package

| Field          | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| `name`         | `@campuscommander/admin-sdk-mock`                                                             |
| `version`      | `1.0.0`                                                                                       |
| `private`      | `true`, which blocks an accidental `npm publish`. Git installs still work.                    |
| `type`         | `module`. The package is ESM only.                                                            |
| `engines.node` | `>=24.11`                                                                                     |
| `bin`          | `admin-sdk-mock` and `mockctl`, both pointing into `dist/bin/`                                |
| `exports`      | `.` for the programmatic API with its type declarations, and `./config.schema.json`           |
| `files`        | `dist/`, `schema/`, `README.md`, `CHANGELOG.md`, `LICENSE.md`                                 |
| Scripts        | `build` compiles `src/` and `bin/` to `dist/`. `prepare` runs `build`, so git installs build. |

The build uses `tsc` with `rewriteRelativeImportExtensions` and declaration output. It emits no test files.
Install: `npm install --save-dev github:CampusCommander/admin-sdk-mock#v1.0.0`. The installer needs read access to the repository.

### Docker image

The image keeps its current base, user, volume, and health check. It gains:

- `MOCK_CONFIG_DEFAULT=/config/admin-sdk-mock.json`, a fallback configuration file that the mock reads when that file exists. `--config`, `MOCK_CONFIG`, and `./admin-sdk-mock.json` come before it (P-R30).
- Port 3128 for the proxy, exposed and off unless the configuration enables it.
- The `admin-sdk-mock` CLI on the path.

### GitHub Action

A composite action at the repository root, `action.yml`, starts the image on the runner:

| Input          | Default                             | Meaning                                    |
| -------------- | ----------------------------------- | ------------------------------------------ |
| `config`       | none                                | Path to a configuration file in the repo.  |
| `image`        | empty                               | The image to run. See below.               |
| `workdir`      | `${{ runner.temp }}/admin-sdk-mock` | Where CA and credential files land.        |
| `passthrough`  | `'true'`                            | Whether the proxy tunnels other targets.   |
| `control-port` | `18080`                             | The host port for the control API (P-R30). |
| `proxy-port`   | `13128`                             | The host port for the proxy (P-R30).       |

An empty `image` resolves to `ghcr.io/campuscommander/admin-sdk-mock:<X.Y.Z>` when `github.action_ref` is `vX.Y.Z`, and to `:main` otherwise (P-R7).
`passthrough` defaults to true, so later steps that share `HTTPS_PROXY` keep their network (P-R7).

It waits for the ready file, then writes `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`, `CURL_CA_BUNDLE`, and `ADMIN_SDK_MOCK_CONTROL` to `$GITHUB_ENV`.
It sets five outputs: `workdir`, `ca-file`, `ca-bundle-file`, `proxy-url`, and `control-url`. It sets no credential-path output.
A key file that the configuration writes under `/out` lands in `<workdir>/out` (P-R30).
The action requires Docker on the runner. GitHub-hosted Ubuntu runners have it.

## Configuration

### File and precedence

The CLI and the image read one JSON file. The CLI finds it in this order: `--config <file>`, then `MOCK_CONFIG`, then `./admin-sdk-mock.json` if present.
A missing `./admin-sdk-mock.json` is not an error. The defaults then apply.
A file that `--config` or `MOCK_CONFIG` names must exist. A missing named file is an error with exit code 2 (P-R5).
Values resolve in this order, highest first: command-line flags, environment variables, the file, the defaults.
`schema/config.schema.json` describes the file. A `$schema` key in the file is allowed and ignored.
Paths written in the file resolve against the file. A `dataDir` that the file does not set defaults to `./data` against the working directory (P-R4).

### Keys

| Key                 | Default                                 | Meaning                                                                                         |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dataDir`           | `./data` (CLI), `/data` (image)         | The data volume.                                                                                |
| `listen.google`     | `{ "host": "127.0.0.1", "port": 8443 }` | The TLS listener for the Google hostnames. Port 0 picks a free port.                            |
| `listen.control`    | `{ "host": "127.0.0.1", "port": 8080 }` | The plain HTTP control listener.                                                                |
| `listen.proxy`      | `null`                                  | `{ "host", "port", "passthrough" }` enables the CONNECT proxy. `passthrough` defaults to false. |
| `timing.scale`      | 1                                       | The time scale.                                                                                 |
| `timing.delays`     | true                                    | Whether modeled latency applies.                                                                |
| `caFile`            | `<dataDir>/ca/ca.pem`                   | Where the CLI writes the CA certificate for clients.                                            |
| `readyFile`         | none                                    | A file the CLI writes once every domain is ready. It holds the `ready` event JSON (P-R12).      |
| `defaults.settings` | `{}`                                    | A settings patch applied to every configured domain before its own settings.                    |
| `domains`           | `[]`                                    | The domains to ensure at startup. See below.                                                    |

Environment variables keep their current names and add the new ones: `MOCK_DATA_DIR`, `MOCK_GOOGLE_HOST`, `MOCK_GOOGLE_PORT`, `MOCK_CONTROL_HOST`, `MOCK_CONTROL_PORT`, `MOCK_PROXY_HOST`, `MOCK_PROXY_PORT`, `MOCK_PROXY_PASSTHROUGH`, `MOCK_TIME_SCALE`, `MOCK_DELAYS`, `MOCK_CA_EXPORT` (the `caFile`), `MOCK_READY_FILE`, `MOCK_CONFIG`.
`MOCK_PROXY_PORT` alone enables the proxy.
The image sets `MOCK_GOOGLE_PORT` to 443 and `MOCK_GOOGLE_HOST`, `MOCK_CONTROL_HOST`, and `MOCK_PROXY_HOST` to `0.0.0.0`, so its listeners stay reachable from other containers.

### Domain entries

| Key               | Default  | Meaning                                                                                                   |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `spec`            | required | A seed specification: `tier`, `seed`, and the optional `name`, `layout`, `counts`, and `rates`.           |
| `onStart`         | `keep`   | `keep` reuses the domain when its seed specification matches. `reset` reseeds it on every start.          |
| `settings`        | `{}`     | A settings patch, merged after `defaults.settings`.                                                       |
| `fixtures`        | none     | A fixtures file path, relative to the configuration file. See [Fixtures](#fixtures).                      |
| `serviceAccounts` | `[]`     | `{ "out", "scopes" }` entries. Each issues a service account, grants the scopes, and writes the key file. |
| `faults`          | `[]`     | Fault rules to add at startup, in the existing fault format.                                              |

`scopes` is a list of scope URLs, or one of the words `read` or `read-write`, which name the mock's test scope sets.
A key file is written with mode 0600 and holds the Google service-account JSON format.
`keep` with a changed seed specification is an error that names the domain. The operator chooses `reset` or deletes the data.

### Validation

Validation runs before any listener starts. One run reports every error it finds, each with its JSON path, for example `domains[1].spec.tier must be small, medium, large, xlarge, or empty.`
Unknown keys are errors. An invalid file exits with code 2 and starts nothing.

## Proxy

The proxy listener accepts HTTP `CONNECT host:port` requests. It never terminates TLS.

| Target                                                                                                                  | Result                                             |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Port 443 of `oauth2.googleapis.com`, `admin.googleapis.com`, `www.googleapis.com`, or `chromemanagement.googleapis.com` | A tunnel to the mock's Google listener.            |
| Any other target, with `passthrough` off                                                                                | `403 Forbidden`, and a log line naming the target. |
| Any other target, with `passthrough` on                                                                                 | A plain tunnel to that target.                     |
| A request that is not `CONNECT`                                                                                         | `405 Method Not Allowed`.                          |

The Google listener's certificate already names the four hostnames, so a tunneled client sees a valid chain once it trusts the mock CA.
`passthrough` lets an application under test reach its other services through the same `HTTPS_PROXY`.

## Control API additions

`GET /info` answers the version, the listener addresses, the CA file path, and the configured domains with their key file paths.
It follows the existing host and content-type guards.

## Command-line interface

One executable, `admin-sdk-mock`, holds every command. `mockctl` stays as an alias for the control commands.

| Command                                   | Effect                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`                                   | Validate the configuration, start the listeners, ensure the domains, write the CA, key, and ready files, and run until a signal.                                                |
| `init [--out <file>]`                     | Write a starter configuration with one small domain, a proxy, and a read-write service account. Print the next steps.                                                           |
| `env [--format sh\|dotenv\|json\|github]` | Ask a running mock's `GET /info` for its listeners, then print the client environment: proxy, CA variables, `NO_PROXY`, and the control URL. `github` appends to `$GITHUB_ENV`. |
| `doctor`                                  | Check the Node version, the data directory, free ports, and the CA file. Print a pass or fail line for each.                                                                    |
| `config validate <file>`                  | Validate a configuration file and print every error.                                                                                                                            |
| Control commands                          | Every current `mockctl` command: `domain`, `credential`, `ca`, `clock`, `quota`, `fault`, `index`, `settings`.                                                                  |

Exit codes: 0 for success, 1 for a runtime failure, 2 for invalid usage or configuration.
Code 2 covers usage, configuration, fixture, and seed specification errors.
The existing control commands, such as `domain`, `credential`, and `clock`, keep exit code 1 for their own validation messages (P-R14).
The `token` command exits with code 2 on usage errors. A malformed control URL exits with code 2 for every command (P-R15).
Control commands find the mock through `--control`, then `MOCK_CONTROL_URL`, then `ADMIN_SDK_MOCK_CONTROL`.
Then `env` reads the configuration's control listener, and the other commands use `http://127.0.0.1:8080` (P-R16).
`start` logs one JSON line per event to standard output, starting with the `started` event. It logs one `ready` event after every domain is ready.
The `ready` event is `{ event: 'ready', ...ServerInfo }`. Its `domains[]` entries carry `customerId`, and `readyFile` receives it (P-R12).
`--help` on every command prints its usage.

## Programmatic API

The package root exports `startMock(options?)` for in-process tests. It returns a promise of a handle.

| Option    | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `dataDir` | Default: a fresh temporary directory, removed by `close()`.             |
| `config`  | A configuration object in the file format. `listen` ports default to 0. |
| `proxy`   | Default `{ passthrough: true }`. `false` starts no proxy.               |
| `timing`  | Default `{ scale: 1, delays: false }`, so tests run fast.               |

| Handle member                         | Meaning                                                                                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `googleUrl`, `controlUrl`, `proxyUrl` | The listener URLs.                                                                                                                                                                                                                                       |
| `caCert`, `caFile`                    | The CA certificate PEM and its file path.                                                                                                                                                                                                                |
| `domains`                             | The configured domains: customer ID, primary domain, administrator email, and key files.                                                                                                                                                                 |
| `createDomain(spec, options?)`        | Seed one more domain. Options take `settings` and `fixtures`.                                                                                                                                                                                            |
| `credential(customerId, scopes)`      | Issue a service account with the scopes and return its key object.                                                                                                                                                                                       |
| `env()`                               | The client environment for child processes.                                                                                                                                                                                                              |
| `useInProcess()`                      | Trust the mock CA in this process through `tls.setDefaultCACertificates`, and set `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, and `no_proxy` for the whole process. `NO_PROXY` holds the loopback list. Returns a function that restores all four (P-R30). |
| `flush(customerId)`                   | The control flush.                                                                                                                                                                                                                                       |
| `control(method, path, body?)`        | Any control API call.                                                                                                                                                                                                                                    |
| `close()`                             | Stop the listeners, restore in-process changes, and remove a temporary data directory.                                                                                                                                                                   |

`useInProcess()` lets the unmodified `googleapis` and `google-auth-library` clients reach the mock from the same process. gaxios reads `HTTPS_PROXY` on every request.
The in-process proxy tunnels other targets by default, so the test's other HTTPS calls keep working.

## Fixtures

A fixtures file declares exact entities for a domain. It applies in its own transaction right after the generated seed (P-R9). A failure removes the whole domain.

| Section    | Fields                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orgUnits` | `path` (required), `description`. Missing parents are created.                                                                                                                   |
| `users`    | `primaryEmail`, `givenName`, `familyName` (required), `orgUnitPath` (default `/`), `isAdmin`, `suspended`, `aliases`, `externalIds`, `id`.                                       |
| `devices`  | `serialNumber` (required), `model` (from the model catalog), `status`, `orgUnitPath`, `annotatedUser`, `annotatedAssetId`, `annotatedLocation`, `notes`, `lastSync`, `deviceId`. |
| `groups`   | `email` (required), `name`, `description`, `aliases`, `members`: `{ email, role, type }` or `{ id, role, type }`. `type` is optional (P-R8).                                     |

Rules:

- Addresses must sit on the domain's own domains, and must not collide with any address already in the domain.
- Omitted IDs derive from the seed and the entry, so one fixtures file always yields the same IDs.
- An omitted device field takes the generator's value for that serial number. Telemetry follows the device as it does for seeded devices.
- A group member names a fixture or seeded user or group, the customer ID, or an outside address. Cycles are errors.
- A member `type` of `USER`, `GROUP`, or `CUSTOMER` must match the kind of entity that the key names (P-R8).
- Errors name the file, the JSON path, and the problem. A fixtures error fails startup with exit code 2.

The `empty` tier seeds the primary domain, the student domain when it differs from the primary domain, the alias domain, the root OU, and one super administrator, `admin@<primary domain>` (P-R30).
It seeds no other OU, user, device, or group, and its rates do not apply.

## Documentation

The repository becomes the documentation site, in Markdown that GitHub renders.

| Path                                                           | Content                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                    | What the mock is, three five-minute quickstarts (npm, Docker, GitHub Actions), and a map of the docs.                  |
| `docs/guide/installation.md`                                   | Each install path, prerequisites, and upgrades.                                                                        |
| `docs/guide/configuration.md`                                  | The configuration model, precedence, domains, service accounts, and worked examples.                                   |
| `docs/guide/clients.md`                                        | Node, Python, curl, and other clients: proxy and CA variables, and the hosts-file alternative.                         |
| `docs/guide/testing.md`                                        | The programmatic API, fixtures, time scale, flush, and faults in test suites.                                          |
| `docs/guide/ci.md`                                             | The GitHub Action, other CI systems through Docker, and caching data.                                                  |
| `docs/guide/behavior.md`                                       | Quota, latency, search lag, nesting and ready delays, and how they differ from Google.                                 |
| `docs/guide/troubleshooting.md`                                | Symptom, cause, and fix for each common failure.                                                                       |
| `docs/reference/configuration.md`                              | Every configuration key. Generated from the JSON Schema.                                                               |
| `docs/reference/cli.md`                                        | Every command and flag. Generated from the CLI's own help text.                                                        |
| `docs/reference/api-coverage.md`                               | Every supported Google method, its parameters, and its rulings. Generated from the route table and checked against it. |
| `docs/trust.md`                                                | What each test layer proves, and where each spec requirement is tested.                                                |
| `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE.md` | Release notes, the development workflow, the security model, and the proprietary license notice.                       |

Generated sections sit between `<!-- generated:start -->` and `<!-- generated:end -->` markers. `npm run docs` regenerates them. A test fails when a generated section is out of date.
Documentation prose follows the repository writing rules.

## Examples

`examples/` holds runnable projects. Each one has a README and a test that runs it.

| Example           | Shows                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `node-in-process` | `startMock()`, `useInProcess()`, and the unmodified `googleapis` client in a `node:test` suite. |
| `node-cli`        | `admin-sdk-mock start` with a configuration file, and a client process using `env`.             |
| `python`          | `google-api-python-client` and `google-auth` through the proxy.                                 |
| `curl`            | A token exchange and a list call from the shell.                                                |
| `github-actions`  | A workflow that uses the action and runs a client.                                              |
| `fixtures`        | An `empty` domain with a fixtures file, and assertions on exact entities.                       |

## Trust

### Test layers

| Layer                | Command                 | Proves                                                                                                  |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Unit                 | `npm test`              | Every module's behavior, including configuration, fixtures, proxy, CLI, and API.                        |
| Coverage             | `npm run test:coverage` | The unit layer exercises at least the gated share of lines, branches, and functions.                    |
| Contract             | `npm run test:contract` | Every response matches Google's discovery schemas.                                                      |
| Node compatibility   | `npm run test:compat`   | Google's Node clients work unmodified through the proxy.                                                |
| Python compatibility | `npm run test:python`   | Google's Python clients work unmodified through the proxy.                                              |
| Package              | `npm run test:package`  | `npm pack` installs into an empty project, the CLI starts, and the API imports with its types.          |
| Examples             | `npm run test:examples` | Every documented Node, curl, and fixtures example runs as written.                                      |
| Docs                 | part of `npm test`      | Generated references match the schema, the CLI, and the route table.                                    |
| Image                | CI `image` job          | The image starts from a mounted configuration, serves the proxy, and passes the Campus Commander smoke. |
| Action               | CI `action` job         | The action starts the mock and exports a working client environment.                                    |
| Scale                | `npm run test:scale`    | Chicago-size domains page within the latency bound.                                                     |

`docs/trust.md` maps each spec requirement to the tests that prove it.

### CI

CI runs every layer on pull requests and on `main`. The Python and package layers run in their own jobs.
`workflow_dispatch` runs CI on any branch.
A tag `v*` runs the release workflow: every check, then the package tarball and the versioned image tags, attached to a GitHub release.

## Security

- The mock never accepts or stores a real Google credential. Every key it issues is its own.
- Key files are written with mode 0600. Logs never print private keys.
- The control API keeps its host and content-type guards. It binds to `127.0.0.1` outside the image.
- The proxy refuses every target outside the four Google hostnames unless `passthrough` is on, and it never decrypts traffic. It binds to `127.0.0.1` outside the image.
- `SECURITY.md` states that the mock is test infrastructure and gives the reporting route.

## Acceptance

Version 1.0 is complete when all of these hold:

1. `npm install` from the repository tag into an empty project yields working `admin-sdk-mock` and `mockctl` commands and an importable, typed API.
2. A configuration file declares domains, settings, fixtures, service accounts, and faults, and `start` produces them.
3. Unmodified Node and Python Google clients reach the mock through the proxy with no root access and no hosts file.
4. The image starts from a mounted configuration, and the action starts the mock in a workflow.
5. Every documented example runs in CI. Every generated reference matches its source.
6. Every test layer passes in CI, and the coverage gate holds.
7. The existing milestone 1–3 behavior and the Campus Commander overlay keep working unchanged.

## Amendments under the autonomy grant

The execution ledger recorded these rulings while the plan ran. The text above already reflects each one.

- P-R4: a `dataDir` that the file does not set defaults to `./data` against the working directory. Paths written in the file resolve against the file.
- P-R5: an explicit `--config` or `MOCK_CONFIG` that names a missing file is an error with exit code 2. Only the implicit `./admin-sdk-mock.json` may be absent.
- P-R7: the action's `image` input defaults to empty, which resolves to the version tag of a pinned action or to `:main`. A new `passthrough` input defaults to true.
- P-R8: fixture group members accept an optional `type` of `USER`, `GROUP`, or `CUSTOMER`, which must match the key.
- P-R9: fixtures apply in their own transaction right after the seed, not inside the seed transaction.
- P-R12: `readyFile` holds the `ready` event with `domains[].customerId`, not the `started` event.
- P-R14: the existing control commands keep exit code 1 for their own validation messages.
- P-R15: the new `token` command exits with code 2 on usage errors, and a malformed control URL exits with code 2 for every command.
- P-R16: the control URL comes from `--control`, then `MOCK_CONTROL_URL`, then `ADMIN_SDK_MOCK_CONTROL`, then the configuration's control listener for `env` or `http://127.0.0.1:8080`.
- P-R30: the spec text matches the code in these places:
  - The image sets `MOCK_CONFIG_DEFAULT=/config/admin-sdk-mock.json`, not `MOCK_CONFIG`. The lookup reads it last.
  - The action has `control-port` (default 18080) and `proxy-port` (default 13128) inputs.
  - The action waits for the ready file, not for health.
  - The action sets five outputs, `workdir`, `ca-file`, `ca-bundle-file`, `proxy-url`, and `control-url`, and no credential-path output.
  - `useInProcess()` sets `HTTPS_PROXY` and `https_proxy` for the whole process, not for the Google hostnames alone. It sets `NO_PROXY` and `no_proxy` to the loopback list.
  - The `empty` tier adds the student domain only when it differs from the primary domain.
