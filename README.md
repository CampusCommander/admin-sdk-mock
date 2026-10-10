# Admin SDK mock

The Admin SDK mock is a local stand-in for the Google Admin SDK Directory API, the Chrome Management telemetry API, and the Google OAuth service-account flow.
Unmodified Google clients reach it through a built-in CONNECT proxy and a mock CA, so tests need no root access, no hosts file, and no real Google tenant.
It serves seeded K-12 domains, from an empty domain to the 400,000-device `xlarge` tier, and it models Google's quota, latency, and search lag.
It is test infrastructure and never serves production traffic.

> [!WARNING]
> Version 0.1.0 is an early release, and it is not production ready. Any 0.x release may change the configuration, the CLI, the API, or the image.
> Pin an exact version, and read [CHANGELOG.md](CHANGELOG.md) before you upgrade.

## Quickstart with npm

You need Node 24.11 or later.

```sh
npm install --save-dev github:CampusCommander/admin-sdk-mock#v0.1.0
npx admin-sdk-mock init
npx admin-sdk-mock start
```

`init` writes `admin-sdk-mock.json` with one `small` domain, a proxy on port 3128, and a read-write service account.
`start` runs until you press Ctrl+C. In another shell, load the client environment and call the Directory API:

```sh
eval "$(npx admin-sdk-mock env)"
TOKEN="$(npx admin-sdk-mock token C07k9krdo --raw)"
curl -H "Authorization: Bearer $TOKEN" "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=3"
```

The seed decides the customer ID, so the starter domain always has the ID `C07k9krdo`.
A Google client library uses the key file `.admin-sdk-mock/credentials/demo.json` with the subject `admin@lexington-community-schools.test`.

## Quickstart with Docker

You need Docker. Write a configuration that puts the key file under `/out`:

```sh
mkdir -p mock/data mock/out
cat > admin-sdk-mock.json <<'EOF'
{
  "domains": [
    {
      "spec": { "tier": "small", "seed": "demo" },
      "serviceAccounts": [{ "out": "/out/credentials/demo.json", "scopes": "read-write" }]
    }
  ]
}
EOF
docker run --detach --name admin-sdk-mock --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:3128:3128 \
  -v "$PWD/admin-sdk-mock.json:/config/admin-sdk-mock.json:ro" \
  -v "$PWD/mock/data:/data" -v "$PWD/mock/out:/out" \
  -e MOCK_GOOGLE_PORT=8443 -e MOCK_PROXY_PORT=3128 \
  -e MOCK_CA_EXPORT=/out/ca.pem -e MOCK_READY_FILE=/out/ready.json \
  ghcr.io/campuscommander/admin-sdk-mock:0.1.0
(for _ in $(seq 1 600); do
  [ -f mock/out/ready.json ] && exit 0
  [ "$(docker inspect -f '{{.State.Running}}' admin-sdk-mock)" = true ] \
    || { echo "The mock exited before it became ready."; docker logs admin-sdk-mock; exit 1; }
  sleep 1
done
echo "The mock did not become ready in 600 seconds."; docker logs admin-sdk-mock; exit 1)
```

The wait stops early, and prints the container log, when the container exits first.

Then point the client environment at the published proxy and the exported CA files:

```sh
export HTTPS_PROXY=http://127.0.0.1:3128 NODE_USE_ENV_PROXY=1 NO_PROXY=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS="$PWD/mock/out/ca.pem"
export SSL_CERT_FILE="$PWD/mock/out/ca-bundle.pem" CURL_CA_BUNDLE="$PWD/mock/out/ca-bundle.pem"
export REQUESTS_CA_BUNDLE="$PWD/mock/out/ca-bundle.pem" HTTPLIB2_CA_CERTS="$PWD/mock/out/ca-bundle.pem"
TOKEN="$(docker exec admin-sdk-mock admin-sdk-mock token C07k9krdo --raw)"
curl -H "Authorization: Bearer $TOKEN" "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=3"
```

The key file lands at `mock/out/credentials/demo.json`. Stop the mock with `docker rm -f admin-sdk-mock`.

## Quickstart with GitHub Actions

The action starts the image on the runner and exports the client environment to every later step.
Give the action its own configuration file, such as `.github/admin-sdk-mock.json`, as [examples/github-actions](examples/github-actions) does.
The `init` starter does not fit. Its relative key paths resolve under `/config`, where the container cannot write.

```yaml
on: [push, pull_request]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - id: mock
        uses: CampusCommander/admin-sdk-mock@v0.1.0
        with:
          config: .github/admin-sdk-mock.json
      - run: npm ci
      - run: npm test
        env:
          GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.mock.outputs.workdir }}/out/credentials/ci.json
```

Write each key file path in that configuration under `/out`, for example `/out/credentials/ci.json`.
The [CI guide](docs/guide/ci.md) lists every input and output, and [examples/github-actions](examples/github-actions) holds a complete workflow.

## Documentation

| Page                                                                     | Content                                                                          |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [Installation](docs/guide/installation.md)                               | Prerequisites, the three install paths, private access, upgrades, and removal.   |
| [Configuration](docs/guide/configuration.md)                             | The file, precedence, domains, settings, service accounts, faults, and fixtures. |
| [Clients](docs/guide/clients.md)                                         | How Node, Python, curl, Java, and Go clients reach the mock.                     |
| [Testing](docs/guide/testing.md)                                         | `startMock()`, fixtures, time, flush, faults, tokens, and the control API.       |
| [CI](docs/guide/ci.md)                                                   | The GitHub Action and other CI systems.                                          |
| [Behavior](docs/guide/behavior.md)                                       | Quota, latency, search lag, group delays, and write limits.                      |
| [Troubleshooting](docs/guide/troubleshooting.md)                         | Symptom, cause, and fix for common failures.                                     |
| [Configuration reference](docs/reference/configuration.md)               | Every configuration key, generated from the JSON schema.                         |
| [CLI reference](docs/reference/cli.md)                                   | Every command and flag, generated from the CLI help.                             |
| [API coverage](docs/reference/api-coverage.md)                           | Every Google method, its parameters, and its rulings.                            |
| [Trust](docs/trust.md)                                                   | What each test layer proves, and which tests prove each requirement.             |
| [Examples](examples/README.md)                                           | Runnable Node, Python, curl, fixtures, and GitHub Actions projects.              |
| [Calibration record](docs/calibration.md)                                | Live parity evidence, measurements, and every ruling.                            |
| [Mock design](docs/specs/2026-10-09-admin-sdk-mock-design.md)            | The milestone 1 design: architecture, seed data, reads, quota, and latency.      |
| [Milestone 2 design](docs/specs/2026-10-09-milestone-2-writes-design.md) | The writes design.                                                               |
| [Milestone 3 design](docs/specs/2026-10-10-milestone-3-groups-design.md) | The groups design.                                                               |
| [Productization design](docs/specs/2026-10-10-productization-design.md)  | The 0.1.0 design: configuration, proxy, CLI, API, fixtures, and distribution.    |

[CHANGELOG.md](CHANGELOG.md), [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [LICENSE.md](LICENSE.md) hold the release notes, the development workflow, the security model, and the license.

## Supported API surface

- OAuth: the JWT bearer token exchange with domain-wide delegation, and `tokeninfo`, on `oauth2.googleapis.com`.
- Directory reads: customers, domains, OUs, Chrome devices, and users, with Google's paging, `fields`, and query languages.
- Directory writes: Chrome device updates, moves, status changes, and commands, plus user and OU writes.
- Groups: groups, group aliases, members, derived membership, and `hasMember`.
- Chrome Management: the telemetry device list and get, with read masks and filters.
- Batch: the Directory multipart batch on `www.googleapis.com` and `admin.googleapis.com`.

## Status

Milestones 1, 2, and 3 are built: Directory and Chrome Management reads, writes, and groups.
Version 0.1.0, the first public release, adds the configuration file, the proxy, the CLI, the programmatic API, fixtures, the image configuration, the action, the examples, and these documents.
The Campus Commander acceptance run awaits the owner. [docs/trust.md](docs/trust.md) records every acceptance item and its evidence.

- Live parity against the Easton fixture: 19 of 19 probes match in status. Six have shape notes.
- Client library compatibility: 10 of 10 read tests pass through a CONNECT proxy.
- Write compatibility: 15 of 15 client tests pass through a CONNECT proxy, writes included.
- Scale: the `xlarge` tier seeds with groups in 26,072 ms. The [calibration record](docs/calibration.md#scale) holds every measurement.

## Campus Commander

The mock began as the scale-test backend of Campus Commander.
A Compose overlay routes the four Google hostnames to the mock inside the Campus Commander network. The overlay adds no file to Campus Commander.
[docs/campus-commander.md](docs/campus-commander.md) holds the procedure and its record. The [clients guide](docs/guide/clients.md#docker-network-aliases) explains the overlay.

## License

The mock is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).
Any noncommercial use is permitted, including use by schools, charities, public research organizations, and government institutions. Commercial use is not licensed.
