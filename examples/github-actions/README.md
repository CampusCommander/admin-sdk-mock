# Admin SDK mock GitHub Action

The action starts the mock image on a runner. It exports proxy and CA variables, so Google clients reach the mock without code changes.
The runner needs Docker. GitHub-hosted Ubuntu runners have it.

## Use the action

Copy `workflow.yml` and `admin-sdk-mock.json` into your repository. Set `config` to the path of your copy.
Inside this repository, use `uses: ./` instead of `uses: CampusCommander/admin-sdk-mock@v1.0.0`.

## Log in to the private image

The image is private. Run `docker/login-action@v3` for `ghcr.io` before the action. Pass `GITHUB_TOKEN` as the password.
Give the job `packages: read` permission.

## Inputs

| Input          | Default                                       | Meaning                                            |
| -------------- | --------------------------------------------- | -------------------------------------------------- |
| `config`       | none                                          | The path to an `admin-sdk-mock.json` in your repo. |
| `image`        | `ghcr.io/campuscommander/admin-sdk-mock:main` | The image to run.                                  |
| `workdir`      | `${{ runner.temp }}/admin-sdk-mock`           | The host directory for data and output files.      |
| `control-port` | `18080`                                       | The host port for the control API.                 |
| `proxy-port`   | `13128`                                       | The host port for the proxy.                       |

## Outputs

| Output           | Meaning                                   |
| ---------------- | ----------------------------------------- |
| `workdir`        | The host directory.                       |
| `ca-file`        | The mock CA certificate.                  |
| `ca-bundle-file` | The mock CA followed by the public roots. |
| `proxy-url`      | The proxy URL.                            |
| `control-url`    | The control API URL.                      |

The action also writes these variables to `$GITHUB_ENV` for later steps: `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`, `CURL_CA_BUNDLE`, and `ADMIN_SDK_MOCK_CONTROL`.

## Write key files under /out

The container sees `<workdir>/out` as `/out`. Write every key file path in the configuration under `/out`, for example `/out/credentials/ci.json`.
Read the file on the runner at `<workdir>/out/credentials/ci.json`. Use the `workdir` output to build the path.

## The example configuration

The example seeds one `small` domain with seed `ci`. Its primary domain is `vernon-school-district.test`, so the admin subject is `admin@vernon-school-district.test`.
It issues one read-write service account and writes its key to `/out/credentials/ci.json`.
