# CI

The mock runs in any CI system that runs Docker or Node.
GitHub Actions has a composite action. Other systems run the image with `docker run`, or the package with `npx`.

## The GitHub Action

The action starts the image on the runner, waits until every domain is ready, and exports the client environment to every later step.

```yaml
on: [push, pull_request]

permissions:
  contents: read
  packages: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Log in to GHCR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: echo "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
      - id: mock
        uses: CampusCommander/admin-sdk-mock@v1.0.0
        with:
          config: .github/admin-sdk-mock.json
      - run: npm ci
      - run: npm test
        env:
          GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.mock.outputs.workdir }}/out/credentials/ci.json
```

Until v1.0.0 is tagged, use `@main`.
[examples/github-actions](../../examples/github-actions) holds this workflow and its configuration.
Keep the action's configuration apart from the `init` starter. The starter's relative key paths resolve under `/config`, where the container cannot write.

### Access

The image and the action are private.
`GITHUB_TOKEN` pulls the image when the package grants your repository access. Other repositories pass a token with `read:packages` as the login password.
A workflow in another repository uses the action only when the Actions settings of this repository allow access from it.

### Inputs

| Input          | Default                             | Meaning                                                                                                                                                                                 |
| -------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`       | none                                | The path to an `admin-sdk-mock.json` in the repository. A missing file fails the step.                                                                                                  |
| `image`        | empty                               | The image to run. Empty picks `ghcr.io/campuscommander/admin-sdk-mock:X.Y.Z` for an action pinned to `vX.Y.Z`, the commit SHA tag for an action pinned to a SHA, and `:main` otherwise. |
| `workdir`      | `${{ runner.temp }}/admin-sdk-mock` | The host directory for data and output files. A value with a line break fails the step.                                                                                                 |
| `control-port` | `18080`                             | The host port for the control API. Any value other than an integer from 1 to 65535 fails the step.                                                                                      |
| `proxy-port`   | `13128`                             | The host port for the proxy. Any value other than an integer from 1 to 65535 fails the step.                                                                                            |
| `passthrough`  | `'true'`                            | Whether the proxy tunnels non-Google targets.                                                                                                                                           |

### Outputs

| Output           | Meaning                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `workdir`        | The host directory. Files under `/out` in the container land in `<workdir>/out`. |
| `ca-file`        | The mock CA certificate, `<workdir>/out/ca.pem`.                                 |
| `ca-bundle-file` | The mock CA followed by the public roots, `<workdir>/out/ca-bundle.pem`.         |
| `proxy-url`      | The proxy URL, `http://127.0.0.1:<proxy-port>`.                                  |
| `control-url`    | The control API URL, `http://127.0.0.1:<control-port>`.                          |

The action also writes `HTTPS_PROXY`, `https_proxy`, `NODE_USE_ENV_PROXY`, `NO_PROXY`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`, `CURL_CA_BUNDLE`, and `ADMIN_SDK_MOCK_CONTROL` to `$GITHUB_ENV`.
The action sets no output for a key file. Build its path from the `workdir` output, as the workflow above does.

### Key files

The container sees `<workdir>/out` as `/out`. Write every key file path in the configuration under `/out`, for example `/out/credentials/ci.json`.
A step on the runner reads that file at `<workdir>/out/credentials/ci.json`.

### Passthrough

The exported `HTTPS_PROXY` applies to every later step, including `npm ci`, caches, and artifact uploads.
With `passthrough: 'true'`, the default, the proxy tunnels those targets, so the steps keep working.
With `passthrough: 'false'`, the proxy refuses every non-Google target. Later steps then need their hosts in `NO_PROXY`, or must run before the action.

### How it runs

The action runs one container named `admin-sdk-mock` as the runner user, with these settings:

- The control port `8080` published on `127.0.0.1:<control-port>`, and the proxy port `3128` on `127.0.0.1:<proxy-port>`.
- `<workdir>/data` mounted at `/data`, and `<workdir>/out` at `/out`.
- The configuration file mounted read-only at `/config/admin-sdk-mock.json`.
- `MOCK_GOOGLE_PORT=8443`, `MOCK_PROXY_PORT=3128`, `MOCK_PROXY_PASSTHROUGH`, `MOCK_CA_EXPORT=/out/ca.pem`, and `MOCK_READY_FILE=/out/ready.json`.

The step logs the image it starts. A failed `docker run`, such as a pull without access, fails the step with an error that names the image.
It waits up to 600 seconds for `ready.json`. When the container exits first, or the wait ends, the step fails and prints the container log.
CI publishes a commit SHA tag only for a push to `main`. For an action pinned to any other commit, set `image`.
`docker logs admin-sdk-mock` in a later step shows the mock's log after a failure.

## Other CI systems

Run the image with the flags that the action uses:

```sh
workdir="$PWD/.admin-sdk-mock"
mkdir -p "$workdir/data" "$workdir/out"
docker run --detach --name admin-sdk-mock --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:18080:8080 -p 127.0.0.1:13128:3128 \
  -v "$workdir/data:/data" -v "$workdir/out:/out" \
  -v "$PWD/admin-sdk-mock.json:/config/admin-sdk-mock.json:ro" \
  -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128 -e MOCK_PROXY_PASSTHROUGH=true \
  -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json \
  ghcr.io/campuscommander/admin-sdk-mock:1.0.0
for _ in $(seq 1 600); do
  [ -f "$workdir/out/ready.json" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' admin-sdk-mock)" = true ] \
    || { echo "The mock exited before it became ready."; docker logs admin-sdk-mock; exit 1; }
  sleep 1
done
test -f "$workdir/out/ready.json" || { echo "The mock did not become ready in 600 seconds."; docker logs admin-sdk-mock; exit 1; }
export HTTPS_PROXY=http://127.0.0.1:13128 https_proxy=http://127.0.0.1:13128 NODE_USE_ENV_PROXY=1
export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS="$workdir/out/ca.pem"
export SSL_CERT_FILE="$workdir/out/ca-bundle.pem" REQUESTS_CA_BUNDLE="$workdir/out/ca-bundle.pem"
export HTTPLIB2_CA_CERTS="$workdir/out/ca-bundle.pem" CURL_CA_BUNDLE="$workdir/out/ca-bundle.pem"
export ADMIN_SDK_MOCK_CONTROL=http://127.0.0.1:18080
```

Until v1.0.0 is tagged, use the image tag `main`.
Log in to `ghcr.io` first, as [installation](installation.md#the-image) shows.
The wait stops early, and prints the container log, when the container exits first.
The ready file holds the `ready` event. Its `domains[].customerId` and `domains[].adminEmail` name each domain.

### Docker on another host

A job that reaches Docker on another host, such as a docker-in-docker service named `docker`, cannot mount its own files. A `-v` path names a directory on the Docker host, not in the job.
Create the container, copy the configuration in, start it, and read its files through `docker exec`:

```sh
# The Docker host's address on the job network. Publish the proxy there, never on every interface.
addr="$(getent hosts docker | awk '{ print $1 }')"
docker create --name admin-sdk-mock -p "$addr:13128:3128" \
  -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128 -e MOCK_CONFIG=/config/admin-sdk-mock.json \
  -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json \
  ghcr.io/campuscommander/admin-sdk-mock:1.0.0
docker cp admin-sdk-mock.json admin-sdk-mock:/config/admin-sdk-mock.json
docker start admin-sdk-mock
for _ in $(seq 1 600); do
  docker exec admin-sdk-mock test -f /out/ready.json 2> /dev/null && break
  [ "$(docker inspect -f '{{.State.Running}}' admin-sdk-mock)" = true ] \
    || { echo "The mock exited before it became ready."; docker logs admin-sdk-mock; exit 1; }
  sleep 1
done
docker exec admin-sdk-mock test -f /out/ready.json \
  || { echo "The mock did not become ready in 600 seconds."; docker logs admin-sdk-mock; exit 1; }
docker exec admin-sdk-mock cat /out/ca.pem > mock-ca.pem
docker exec admin-sdk-mock cat /out/ca-bundle.pem > mock-ca-bundle.pem
docker exec admin-sdk-mock cat /out/credentials/ci.json > ci.json
export HTTPS_PROXY=http://docker:13128 https_proxy=http://docker:13128 NODE_USE_ENV_PROXY=1
export NO_PROXY=localhost,127.0.0.1,::1,docker no_proxy=localhost,127.0.0.1,::1,docker
export NODE_EXTRA_CA_CERTS="$PWD/mock-ca.pem"
export SSL_CERT_FILE="$PWD/mock-ca-bundle.pem" REQUESTS_CA_BUNDLE="$PWD/mock-ca-bundle.pem"
export HTTPLIB2_CA_CERTS="$PWD/mock-ca-bundle.pem" CURL_CA_BUNDLE="$PWD/mock-ca-bundle.pem"
```

- The container runs as the image's `node` user, which owns `/out`. `docker cp` keeps the file's mode, so the configuration must be readable by others.
- `NO_PROXY` holds the Docker host's name. Without it, a Docker CLI that talks TLS to the host, such as `tcp://docker:2376`, sends its own requests through the mock's proxy, and every later `docker` command fails with `Forbidden`.
- The proxy has no `Host` guard, so `http://docker:13128` works.
- Run control commands inside the container, for example `docker exec admin-sdk-mock admin-sdk-mock domain list`.
  The control API answers `403` to `Host: docker`. It accepts only `localhost`, `127.0.0.1`, `[::1]`, and `admin-sdk-mock`, each with any port.
- Keep passthrough off unless that network is private to the job. With passthrough on, every client on the network can relay through the proxy to any host and port.
  That relay also reaches the control listener at the container's network address. [SECURITY.md](../../SECURITY.md#passthrough) explains the risk.
  With passthrough off, add the job's other hosts to `NO_PROXY`.
- `docker rm -f -v admin-sdk-mock` removes the container and its data volume.

[scripts/remote-docker-smoke.sh](../../scripts/remote-docker-smoke.sh) runs this block against a docker-in-docker host with TLS in CI.

### Without Docker

A runner with Node 24.11 or later runs the package directly. The repository's `admin-sdk-mock.json` must turn the proxy on, as the `init` starter does.

```sh
npm install --save-dev github:CampusCommander/admin-sdk-mock#v1.0.0
npx admin-sdk-mock start --ready-file .admin-sdk-mock/ready.json > mock.log 2>&1 &
mock_pid=$!
for _ in $(seq 1 600); do
  [ -f .admin-sdk-mock/ready.json ] && break
  kill -0 "$mock_pid" 2> /dev/null || { echo "The mock exited before it became ready."; cat mock.log; exit 1; }
  sleep 1
done
test -f .admin-sdk-mock/ready.json || { echo "The mock did not become ready in 600 seconds."; cat mock.log; exit 1; }
client_env="$(npx admin-sdk-mock env)" || { echo "admin-sdk-mock env failed."; exit 1; }
eval "$client_env"
npm test
```

Until v1.0.0 is tagged, use `#main`.
The wait stops early, and prints `mock.log`, when the mock exits first.
The block reads the environment into a variable first, because `eval "$(...)"` would ignore a failed `env`, and the tests would then run without the proxy.
`start` deletes an old ready file before it starts, so the wait never sees a stale one.
A graceful stop deletes the ready file that `start` wrote.

## Caching

Cache nothing. The seed is deterministic, so a fresh seed reproduces the same domain on every run.
A cached data directory carries the writes of the previous run into the next one.
Set `onStart` to `reset` in a CI configuration, so every run starts from the seeded state.
Seeding takes milliseconds for `small` and about 26 seconds for `xlarge`.
