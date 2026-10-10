# Installation

The mock installs three ways: as an npm development dependency, as a Docker image, or as a GitHub Action.
All three run the same mock. Pick the path that matches where your tests run.

Until v1.0.0 is tagged, use `#main` and `@main`.
The image tag `1.0.0` arrives with that tag. Until then, use the image tag `main`.

## Prerequisites

| Path           | Prerequisites                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| npm            | Node 24.11 or later, and read access to the `CampusCommander/admin-sdk-mock` repository.                        |
| Docker         | Docker, and a `ghcr.io` login with a token that has `read:packages`. Node is not needed.                        |
| GitHub Actions | A runner with Docker, and a job with the `packages: read` permission. GitHub-hosted Ubuntu runners have Docker. |

The guides use POSIX shell commands, for a shell such as bash or zsh on Linux and macOS, or a shell inside WSL on Windows.
`eval "$(npx admin-sdk-mock env)"` needs such a shell. On Windows outside WSL, run the commands inside WSL instead.
Or print `npx admin-sdk-mock env --format json` and set each variable in your shell by hand.
After an npm install, `npx admin-sdk-mock doctor` checks Node, the configuration, the data directory, the CA file, and the ports.

## Private repository access

The repository and the image are private. Every install path needs an account or a token with access.

### The GitHub CLI

`gh auth setup-git` makes git use your GitHub CLI login for `github.com`. npm then fetches the repository through git with that login.

```sh
gh auth login
gh auth setup-git
```

### A deploy key or a token

A machine without a personal login uses a deploy key or a fine-grained token.

- A deploy key is a read-only SSH key on the repository. npm falls back to SSH when the HTTPS fetch fails, so a loaded deploy key works.
- A fine-grained token needs read access to the repository contents. Point git at it before `npm install`:

```sh
git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
```

Keep the token in a CI secret. Never commit it.

### The image

Log in to `ghcr.io` with a token that has `read:packages`:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github user> --password-stdin
```

In GitHub Actions, `GITHUB_TOKEN` pulls the image when the package grants your repository access. Other repositories need a token with `read:packages`.
Using the action from another repository also requires the Actions access setting of this repository to allow it.

## npm

```sh
npm install --save-dev github:CampusCommander/admin-sdk-mock#v1.0.0
npx admin-sdk-mock --help
```

npm records the dependency as `"@campuscommander/admin-sdk-mock": "github:CampusCommander/admin-sdk-mock#v1.0.0"`.
The install runs the `prepare` script, which compiles the package into `dist/`. The first install therefore takes longer.

The package provides:

- The `admin-sdk-mock` and `mockctl` executables.
- The programmatic API, `import { startMock } from '@campuscommander/admin-sdk-mock'`, with TypeScript types.
- The JSON schema, at `@campuscommander/admin-sdk-mock/config.schema.json` and in `node_modules/@campuscommander/admin-sdk-mock/schema/`.

The package is ESM only. Start with `npx admin-sdk-mock init`, then read the [configuration guide](configuration.md).

## Docker

```sh
docker pull ghcr.io/campuscommander/admin-sdk-mock:1.0.0
```

| Tag            | Source                                              |
| -------------- | --------------------------------------------------- |
| `1.0.0`, `1.0` | The release workflow, from the tag `v1.0.0`.        |
| `main`         | CI, from every push to `main`.                      |
| A commit SHA   | CI, from the push to `main` that built that commit. |

The image runs `admin-sdk-mock start` as the `node` user, with these settings:

| Setting               | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `MOCK_DATA_DIR`       | `/data`, a volume.                                                                       |
| `MOCK_GOOGLE_HOST`    | `0.0.0.0`                                                                                |
| `MOCK_GOOGLE_PORT`    | `443`                                                                                    |
| `MOCK_CONTROL_HOST`   | `0.0.0.0`                                                                                |
| `MOCK_CONTROL_PORT`   | `8080`                                                                                   |
| `MOCK_PROXY_HOST`     | `0.0.0.0`. The proxy stays off until `MOCK_PROXY_PORT` or the configuration turns it on. |
| `MOCK_CONFIG_DEFAULT` | `/config/admin-sdk-mock.json`. The mock reads it when that file exists.                  |
| Exposed ports         | 443, 3128, and 8080.                                                                     |
| Health check          | `GET /health` on port 8080.                                                              |

The `admin-sdk-mock` and `mockctl` commands sit on the path, so `docker exec <container> admin-sdk-mock domain list` works.

The `node` user cannot bind port 443 without `--sysctl net.ipv4.ip_unprivileged_port_start=0`.
A client that uses the proxy never needs port 443, so set `MOCK_GOOGLE_PORT=8443` instead. The action and the image smoke test do so.

Mount a configuration at `/config/admin-sdk-mock.json`, or set `MOCK_CONFIG` to another path.
Write key files and the CA under a mounted directory such as `/out`, so the host can read them.
Pass `--user "$(id -u):$(id -g)"` when the mounted directories belong to your host user.
The [README](../../README.md#quickstart-with-docker) shows a complete `docker run`.

### Docker Compose

Inside a clone of this repository, `compose/standalone.yml` builds and runs the image:

```sh
docker compose -f compose/standalone.yml up --detach --wait --build
docker compose -f compose/standalone.yml exec admin-sdk-mock mockctl domain create --tier medium --seed demo
```

It publishes the control API on `127.0.0.1:18080`, the Google listener on `127.0.0.1:18443`, and the proxy on `127.0.0.1:13128`.
It writes the CA to `/ca-public/ca.pem` in the `admin-sdk-mock-ca` volume.
Add `compose/with-config.yml` to mount a configuration directory:

```sh
ADMIN_SDK_MOCK_CONFIG_DIR=./my-config docker compose -f compose/standalone.yml -f compose/with-config.yml up --detach --wait
```

## GitHub Actions

```yaml
- id: mock
  uses: CampusCommander/admin-sdk-mock@v1.0.0
  with:
    config: admin-sdk-mock.json
```

The [CI guide](ci.md) covers the login, the inputs, and the outputs.

## Upgrades

Releases follow version tags such as `v1.0.0`. Read [CHANGELOG.md](../../CHANGELOG.md) before you move to a new tag.

| Path           | Upgrade                                                                    |
| -------------- | -------------------------------------------------------------------------- |
| npm            | `npm install --save-dev github:CampusCommander/admin-sdk-mock#<new tag>`   |
| Docker         | Pull and run `ghcr.io/campuscommander/admin-sdk-mock:<new version>`.       |
| GitHub Actions | Change `@v1.0.0` to the new tag. The action then picks the matching image. |

A domain with `onStart: keep` keeps its stored data across an upgrade.
To seed it with the new version, set `onStart` to `reset` for one start, or delete the data directory.

## Uninstall

| Path           | Steps                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| npm            | Run `npm uninstall @campuscommander/admin-sdk-mock`. Delete the data directory and the key files.                                  |
| Docker         | Run `docker rm -f <container>` and `docker image rm ghcr.io/campuscommander/admin-sdk-mock:<tag>`. Delete the mounted directories. |
| GitHub Actions | Remove the step. The runner discards the container.                                                                                |

The starter configuration keeps its data and its key file under `.admin-sdk-mock/`. Delete that folder.
The mock never installs its CA into a system trust store. Remove the CA only from a store that you added it to yourself.
