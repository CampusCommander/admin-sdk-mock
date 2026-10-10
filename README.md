# Admin SDK mock

The Admin SDK mock is a local stand-in for the Google Admin SDK Directory API, the Chrome Management telemetry API, and the Google OAuth service-account flow.
Unmodified Google clients reach it through a built-in CONNECT proxy and a mock CA, so tests need no root access, no hosts file, and no real Google tenant.
It serves seeded K-12 domains, from an empty domain to the 400,000-device `xlarge` tier, and it models Google's quota, latency, and search lag.
It is test infrastructure and never serves production traffic.

Until v1.0.0 is tagged, use `#main` and `@main`.
The image tag `1.0.0` arrives with that tag. Until then, use the image tag `main`.

## Quickstart with npm

You need Node 24.11 or later and read access to this repository. See [private repository access](docs/guide/installation.md#private-repository-access).

```sh
npm install --save-dev github:CampusCommander/admin-sdk-mock#v1.0.0
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

You need Docker and a `ghcr.io` login with a token that has `read:packages`. Write a configuration that puts the key file under `/out`:

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
  ghcr.io/campuscommander/admin-sdk-mock:1.0.0
until [ -f mock/out/ready.json ]; do sleep 1; done
```

Then point the client environment at the published proxy and the exported CA files:

```sh
export HTTPS_PROXY=http://127.0.0.1:3128 NO_PROXY=localhost,127.0.0.1,::1
export NODE_EXTRA_CA_CERTS="$PWD/mock/out/ca.pem"
export SSL_CERT_FILE="$PWD/mock/out/ca-bundle.pem" CURL_CA_BUNDLE="$PWD/mock/out/ca-bundle.pem"
export REQUESTS_CA_BUNDLE="$PWD/mock/out/ca-bundle.pem" HTTPLIB2_CA_CERTS="$PWD/mock/out/ca-bundle.pem"
TOKEN="$(docker exec admin-sdk-mock admin-sdk-mock token C07k9krdo --raw)"
curl -H "Authorization: Bearer $TOKEN" "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=3"
```

The key file lands at `mock/out/credentials/demo.json`. Stop the mock with `docker rm -f admin-sdk-mock`.

## Quickstart with GitHub Actions

The action starts the image on the runner and exports the client environment to every later step.
The image is private, so log in to `ghcr.io` first. The job needs the `packages: read` permission.

```yaml
permissions:
  contents: read
  packages: read

steps:
  - uses: actions/checkout@v5
  - name: Log in to GHCR
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    run: echo "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
  - id: mock
    uses: CampusCommander/admin-sdk-mock@v1.0.0
    with:
      config: admin-sdk-mock.json
  - run: npm test
    env:
      GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.mock.outputs.workdir }}/out/credentials/ci.json
```

Write each key file path in that configuration under `/out`, for example `/out/credentials/ci.json`.
The [CI guide](docs/guide/ci.md) lists every input and output, and [examples/github-actions](examples/github-actions) holds a complete workflow.

## Documentation

| Page                                                       | Content                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [Installation](docs/guide/installation.md)                 | Prerequisites, the three install paths, private access, upgrades, and removal.   |
| [Configuration](docs/guide/configuration.md)               | The file, precedence, domains, settings, service accounts, faults, and fixtures. |
| [Clients](docs/guide/clients.md)                           | How Node, Python, curl, Java, and Go clients reach the mock.                     |
| [Testing](docs/guide/testing.md)                           | `startMock()`, fixtures, time, flush, faults, tokens, and the control API.       |
| [CI](docs/guide/ci.md)                                     | The GitHub Action and other CI systems.                                          |
| [Behavior](docs/guide/behavior.md)                         | Quota, latency, search lag, group delays, and write limits.                      |
| [Troubleshooting](docs/guide/troubleshooting.md)           | Symptom, cause, and fix for common failures.                                     |
| [Configuration reference](docs/reference/configuration.md) | Every configuration key, generated from the JSON schema.                         |
| [CLI reference](docs/reference/cli.md)                     | Every command and flag, generated from the CLI help.                             |
| [API coverage](docs/reference/api-coverage.md)             | Every Google method, its parameters, and its rulings.                            |
| [Trust](docs/trust.md)                                     | What each test layer proves, and which tests prove each requirement.             |
| [Examples](examples/README.md)                             | Runnable Node, Python, curl, fixtures, and GitHub Actions projects.              |
| [Calibration record](docs/calibration.md)                  | Live parity evidence, measurements, and every ruling.                            |

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
Version 1.0.0 adds the configuration file, the proxy, the CLI, the programmatic API, fixtures, the image configuration, the action, the examples, and these documents. It awaits owner review.
The Campus Commander acceptance run awaits the owner. [docs/trust.md](docs/trust.md) records every acceptance item and its evidence.

## Campus Commander

The mock began as the scale-test backend of Campus Commander.
A Compose overlay routes the four Google hostnames to the mock inside the Campus Commander network. The overlay adds no file to Campus Commander.
[docs/campus-commander.md](docs/campus-commander.md) holds the procedure and its record. The [clients guide](docs/guide/clients.md#docker-network-aliases) explains the overlay.
