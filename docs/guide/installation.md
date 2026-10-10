# Installation

The mock installs three ways: as an npm development dependency, as a Docker image, or as a GitHub Action.
All three run the same mock. Pick the path that matches where your tests run.

## Prerequisites

| Path           | Prerequisites                                                   |
| -------------- | --------------------------------------------------------------- |
| npm            | Node 24.11 or later.                                            |
| Docker         | Docker. Node is not needed.                                     |
| GitHub Actions | A runner with Docker. GitHub-hosted Ubuntu runners have Docker. |

The guides use POSIX shell commands, for a shell such as bash or zsh on Linux and macOS, or a shell inside WSL on Windows.
`eval "$(npx admin-sdk-mock env)"` needs such a shell. On Windows outside WSL, run the commands inside WSL instead.
Or print `npx admin-sdk-mock env --format json` and set each variable in your shell by hand.
After an npm install, `npx admin-sdk-mock doctor` checks Node, the configuration, the data directory, the CA file, and the ports.

## npm

```sh
npm install --save-dev github:CampusCommander/admin-sdk-mock#v0.1.0
npx admin-sdk-mock --help
```

npm records the dependency as `"@campuscommander/admin-sdk-mock": "github:CampusCommander/admin-sdk-mock#v0.1.0"`.
The install runs the `prepare` script, which compiles the package into `dist/`. The first install therefore takes longer.

### Lifecycle scripts

npm must run the `prepare` script of this Git dependency. Two npm settings stop it. The steps below hold for npm 11.19.

With `--ignore-scripts`, or `ignore-scripts=true` in an `.npmrc` file, npm skips `prepare`.
The install still exits 0, but the package holds no `dist/` directory and links no executables.
`npx admin-sdk-mock` then fails with `npm error 404 Not Found - GET https://registry.npmjs.org/admin-sdk-mock`.
Run `npm install --ignore-scripts=false` in the project. npm then builds the package and links both executables.
`npm rebuild` does not build it.

An `allow-scripts` line in any `.npmrc` file fails the install:

```text
npm error git dep preparation failed
npm error npm error code EALLOWSCRIPTS
npm error npm error --allow-scripts is not allowed in project-scoped installs.
```

npm passes the setting to the nested install that prepares the Git dependency. That install treats it as a command-line flag and rejects it.
For one install, pass an empty value: `npm install --allow-scripts=` or `npm ci --allow-scripts=`.
To fix it for good, run `npm config ls`. It names the file that sets `allow-scripts`.
Remove the line from that file, for example with `npm config delete allow-scripts --location=user`.
A project keeps its script policy in the `allowScripts` field of `package.json` instead. That field never reaches the nested install.

Approve this package in `package.json` by its repository:

```json
{
  "allowScripts": {
    "github:CampusCommander/admin-sdk-mock": true
  }
}
```

npm matches a Git dependency by its repository and commit SHA.
A key with a tag, such as `github:CampusCommander/admin-sdk-mock#v0.1.0`, never matches. The package name never matches either.
Without the entry, npm runs `prepare` and prints a warning that names the package.
With `strict-allow-scripts=true`, the install fails with `ESTRICTALLOWSCRIPTS` until the entry exists.

The package provides:

- The `admin-sdk-mock` and `mockctl` executables.
- The programmatic API, `import { startMock } from '@campuscommander/admin-sdk-mock'`, with TypeScript types.
- The JSON schema, at `@campuscommander/admin-sdk-mock/config.schema.json` and in `node_modules/@campuscommander/admin-sdk-mock/schema/`.

The package is ESM only. Start with `npx admin-sdk-mock init`, then read the [configuration guide](configuration.md).

## Docker

```sh
docker pull ghcr.io/campuscommander/admin-sdk-mock:0.1.0
```

| Tag            | Source                                              |
| -------------- | --------------------------------------------------- |
| `0.1.0`, `0.1` | The release workflow, from the tag `v0.1.0`.        |
| `main`         | CI, from every push to `main`.                      |
| A commit SHA   | CI, from the push to `main` that built that commit. |

The image runs `admin-sdk-mock start` as the `node` user, with these settings:

| Setting               | Value                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_DATA_DIR`       | `/data`, a volume.                                                                                                           |
| `MOCK_GOOGLE_HOST`    | `0.0.0.0`                                                                                                                    |
| `MOCK_GOOGLE_PORT`    | `443`                                                                                                                        |
| `MOCK_CONTROL_HOST`   | `0.0.0.0`                                                                                                                    |
| `MOCK_CONTROL_PORT`   | `8080`                                                                                                                       |
| `MOCK_PROXY_HOST`     | `0.0.0.0`. The proxy stays off until `MOCK_PROXY_PORT` or the configuration turns it on.                                     |
| `MOCK_CONFIG_DEFAULT` | `/config/admin-sdk-mock.json`. The mock reads it when that file exists.                                                      |
| Exposed ports         | 443, 3128, and 8080.                                                                                                         |
| Health check          | `GET /health` on `MOCK_CONTROL_PORT`, every 5 seconds, with a 600-second start period. It fails until every domain is ready. |

The `admin-sdk-mock` and `mockctl` commands sit on the path, so `docker exec <container> admin-sdk-mock domain list` works.

Docker 20.10 and later let the `node` user bind port 443. Another runtime may need `--sysctl net.ipv4.ip_unprivileged_port_start=0`.
A client that uses the proxy never needs port 443, so the action and the image smoke test set `MOCK_GOOGLE_PORT=8443`.

Mount a configuration at `/config/admin-sdk-mock.json`, or set `MOCK_CONFIG` to another path.
Write key files and the CA under a mounted directory such as `/out`, so the host can read them.
Without a mount, `/out` is an empty directory that the `node` user owns. Read its files with `docker exec` or `docker cp`.
Pass `--user "$(id -u):$(id -g)"` when the mounted directories belong to your host user.
The [README](../../README.md#quickstart-with-docker) shows a complete `docker run`.

### Docker Compose

Inside a clone of this repository, `compose/standalone.yml` builds the image as `admin-sdk-mock:local` and runs it. Set `ADMIN_SDK_MOCK_IMAGE` to run another image.

```sh
docker compose -f compose/standalone.yml up --detach --wait --build
docker compose -f compose/standalone.yml exec admin-sdk-mock mockctl domain create --tier medium --seed demo
```

It publishes the control API on `127.0.0.1:18080`, the Google listener on `127.0.0.1:18443`, and the proxy on `127.0.0.1:13128`.
It writes the CA to `/ca-public/ca.pem` in the `admin-sdk-mock-ca` volume.
Add `compose/with-config.yml` to mount a configuration directory:

```sh
ADMIN_SDK_MOCK_CONFIG_DIR="$PWD/my-config" docker compose -f compose/standalone.yml -f compose/with-config.yml up --detach --wait
```

Pass an absolute path. Compose resolves a relative path against `compose/`, the directory of the first file.
The start fails when the directory does not exist or holds no `admin-sdk-mock.json`. The mock exits with code 2 and logs `/config/admin-sdk-mock.json does not exist.`
Docker Engine refuses a missing directory. Docker Desktop creates it, owned by root, before the mock exits. Remove that directory afterwards.

## GitHub Actions

```yaml
- id: mock
  uses: CampusCommander/admin-sdk-mock@v0.1.0
  with:
    config: .github/admin-sdk-mock.json
```

The [CI guide](ci.md) covers the login, the inputs, and the outputs.

## Upgrades

Releases follow version tags such as `v0.1.0`. A 0.x release may change any interface. Read [CHANGELOG.md](../../CHANGELOG.md) before you move to a new tag.

| Path           | Upgrade                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| npm            | `npm install --save-dev github:CampusCommander/admin-sdk-mock#<new tag>`   |
| Docker         | Pull and run `ghcr.io/campuscommander/admin-sdk-mock:<new version>`.       |
| GitHub Actions | Change `@v0.1.0` to the new tag. The action then picks the matching image. |

A domain with `onStart: keep` keeps its stored data across an upgrade.
To seed it with the new version, set `onStart` to `reset` for one start, or delete the data directory.

## Uninstall

| Path           | Steps                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| npm            | Run `npm uninstall @campuscommander/admin-sdk-mock`. Delete the data directory and the key files.                                  |
| Docker         | Run `docker rm -f <container>` and `docker image rm ghcr.io/campuscommander/admin-sdk-mock:<tag>`. Delete the mounted directories. |
| GitHub Actions | Remove the step. Hosted runners discard the container.                                                                             |

A self-hosted runner keeps the container after the job. A composite action has no post step, so end the job with this step:

```yaml
- name: Stop the Admin SDK mock
  if: always()
  run: docker rm -f admin-sdk-mock
```

The starter configuration keeps its data and its key file under `.admin-sdk-mock/`. Delete that folder.
The mock never installs its CA into a system trust store. Remove the CA only from a store that you added it to yourself.
