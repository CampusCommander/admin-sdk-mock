# Clients

A client under test keeps calling the real Google hostnames. The mock answers in Google's place.
This guide explains how each client stack reaches the mock, and the variables that each stack reads.
The [examples](../../examples/README.md) hold runnable Node, Python, and curl clients.

## How a client reaches the mock

Two pieces route a client to the mock:

1. The proxy. `HTTPS_PROXY` points the client at the mock's CONNECT proxy.
   The proxy tunnels port 443 of `oauth2.googleapis.com`, `admin.googleapis.com`, `www.googleapis.com`, and `chromemanagement.googleapis.com` to the mock's Google listener.
2. The CA. The Google listener presents a certificate for the four hostnames, signed by the mock CA. The client trusts that CA.

The proxy never decrypts traffic. It answers `403 Forbidden` to every other target unless `passthrough` is on, and then it tunnels that target unchanged.
It answers `405 Method Not Allowed` to any request that is not `CONNECT`.

Three tools produce the client environment:

- `admin-sdk-mock env` asks a running mock for its listeners and prints the variables.
- `startMock()` returns a handle whose `env()` gives the same variables, and whose `useInProcess()` applies them to the current process.
- The GitHub Action writes them to `$GITHUB_ENV` for every later step.

## The variables

| Variable                         | Value                           | Read by                                                                                           |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `HTTPS_PROXY`, `https_proxy`     | `http://127.0.0.1:<proxy port>` | Google's Node clients, Python, curl, Go, and most other stacks.                                   |
| `NODE_USE_ENV_PROXY`             | `1`                             | Node's built-in `fetch` and `https` modules, which read `HTTPS_PROXY` only with it.               |
| `NO_PROXY`, `no_proxy`           | `localhost,127.0.0.1,::1`       | The same stacks.                                                                                  |
| `NODE_EXTRA_CA_CERTS`            | The CA file, `ca.pem`           | Node.                                                                                             |
| `SSL_CERT_FILE`                  | The bundle, `ca-bundle.pem`     | OpenSSL clients, and Go on Linux.                                                                 |
| `REQUESTS_CA_BUNDLE`             | The bundle                      | Python `requests`, which `google-auth` uses.                                                      |
| `HTTPLIB2_CA_CERTS`              | The bundle                      | Python `httplib2`, which `google-api-python-client` uses.                                         |
| `CURL_CA_BUNDLE`                 | The bundle                      | curl.                                                                                             |
| `ADMIN_SDK_MOCK_CONTROL`         | The control URL                 | The `admin-sdk-mock` control commands.                                                            |
| `GOOGLE_APPLICATION_CREDENTIALS` | The key file                    | Google default credentials. `env` sets it when the configuration has exactly one service account. |

`env` prints no proxy variables when the proxy is off, and it warns on standard error.

### Why the bundle holds the public roots

`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `HTTPLIB2_CA_CERTS`, and `CURL_CA_BUNDLE` replace the client's default trust store. They do not add to it.
A file with the mock CA alone would break every other HTTPS call of the client, such as passthrough targets and package downloads.
So the mock writes `ca-bundle.pem` beside `ca.pem`: the mock CA followed by the public roots that Node ships.
`NODE_EXTRA_CA_CERTS` adds to Node's own roots, so it takes the CA alone.

### NO_PROXY

`NO_PROXY` keeps local traffic, including the control API, off the proxy.
With `passthrough` off, the proxy refuses every target outside the four Google hostnames.
Add the other hosts of your application to `NO_PROXY`, or turn `passthrough` on. Never add a Google hostname to `NO_PROXY`.

### Output formats

`admin-sdk-mock env --format <format>` prints the variables in one of four formats:

| Format   | Output                                                                                       |
| -------- | -------------------------------------------------------------------------------------------- |
| `sh`     | `export NAME='value'` lines, the default. Load them with `eval "$(npx admin-sdk-mock env)"`. |
| `dotenv` | `NAME=value` lines for an `.env` file.                                                       |
| `json`   | One JSON object.                                                                             |
| `github` | `NAME=value` lines appended to the file that `$GITHUB_ENV` names.                            |

The `dotenv` format double-quotes a value that holds whitespace, a quote, `#`, or `$`.
docker compose and python-dotenv still expand `${VAR}` inside double quotes.
The mock's own values are paths and URLs. They hold a `$` only when a path in your configuration holds one, so keep `$` out of those paths.

## Node

Google's Node clients, `googleapis`, `@googleapis/*`, and `google-auth-library`, send requests through gaxios. gaxios reads `HTTPS_PROXY` on every request.
Node reads `NODE_EXTRA_CA_CERTS` once, at startup, so set it before the process starts.

```sh
eval "$(npx admin-sdk-mock env)"
node my-client.mjs
```

Node's built-in `fetch` and `https` modules ignore `HTTPS_PROXY` unless the environment sets `NODE_USE_ENV_PROXY=1`.
`env` and the GitHub Action set it with the proxy variables. Node reads it once, at startup.
Without it, such a call goes to real Google, which rejects the mock's tokens.

A test that starts the mock in its own process calls `useInProcess()` instead. It sets `HTTPS_PROXY` and `NO_PROXY`, and adds the mock CA through `tls.setDefaultCACertificates`.
Google's clients in that process reach the mock. Built-in `fetch` and `https` calls still skip the proxy, because the process started without `NODE_USE_ENV_PROXY`.
Run such a client in a child process with the `env()` variables.
See the [testing guide](testing.md).

## Python

`google-api-python-client` sends requests through `httplib2`, which reads `HTTPLIB2_CA_CERTS`.
`httplib2` reads `HTTPS_PROXY`, but it needs the PySocks package to tunnel through a proxy.
`google-auth` refreshes tokens through `requests` when your code uses its `requests` transport, and `requests` reads `REQUESTS_CA_BUNDLE`.

```sh
python -m pip install google-api-python-client google-auth google-auth-httplib2 PySocks
eval "$(npx admin-sdk-mock env)"
python list_users.py
```

The [Python example](../../examples/python) lists users this way, and CI runs it.

## curl

curl reads `HTTPS_PROXY` and `CURL_CA_BUNDLE`.

```sh
eval "$(npx admin-sdk-mock env)"
TOKEN="$(npx admin-sdk-mock token <customerId> --raw)"
curl -H "Authorization: Bearer $TOKEN" "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer"
```

`token` mints an access token without the OAuth exchange. The [curl example](../../examples/curl) shows a complete script.

## OpenSSL clients

A client built on OpenSSL reads `SSL_CERT_FILE` as its default trust file.
Check that the client honors `HTTPS_PROXY`, or configure its proxy setting with the same URL.

## Java

Java ignores the variables above. Copy the JDK trust store, add the mock CA to the copy, and point Java at it:

```sh
eval "$(npx admin-sdk-mock env)"
cp "$JAVA_HOME/lib/security/cacerts" mock-cacerts
keytool -importcert -noprompt -alias admin-sdk-mock -file "$NODE_EXTRA_CA_CERTS" -keystore mock-cacerts -storepass changeit
java -Djavax.net.ssl.trustStore=mock-cacerts -Djavax.net.ssl.trustStorePassword=changeit \
  -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=3128 -jar my-client.jar
```

The copy keeps the public roots, so other HTTPS calls keep working. `changeit` is the JDK default password.
Use the proxy port of your mock in `https.proxyPort`.

## Go

Go's `net/http` reads `HTTPS_PROXY` and `NO_PROXY` through `http.ProxyFromEnvironment`, the default transport's proxy function.
On Linux, Go reads `SSL_CERT_FILE`, so `eval "$(npx admin-sdk-mock env)"` covers both.
On macOS and Windows, Go ignores `SSL_CERT_FILE`. Add the CA from `ca.pem` to the `RootCAs` pool of the client's `tls.Config`.

## The hosts-file alternative

A client that ignores proxies reaches the mock through the hosts file instead.

1. Map the four hostnames to the loopback address in `/etc/hosts`, or in `C:\Windows\System32\drivers\etc\hosts` on Windows:

   ```text
   127.0.0.1 oauth2.googleapis.com admin.googleapis.com www.googleapis.com chromemanagement.googleapis.com
   ```

2. Start the mock with the Google listener on port 443: `npx admin-sdk-mock start --google-port 443`. Binding port 443 needs root or a low-port capability.
3. Trust the CA. Set `NODE_EXTRA_CA_CERTS` or the bundle variables, or import the CA as the Java section shows. `admin-sdk-mock ca --out <file>` writes the CA.
4. Leave `HTTPS_PROXY` unset.

The hosts file affects every program on the machine. Remove the line when the tests finish.

## Docker network aliases

Inside Docker, network aliases replace the hosts file.
The Campus Commander overlay, `compose/campus-commander.overlay.yml`, shows the pattern:

- The mock container joins the application's internal network with the four Google hostnames as network aliases. Docker DNS resolves them to the mock.
- The mock listens on port 443, the image default. The overlay sets the `net.ipv4.ip_unprivileged_port_start=0` sysctl so the `node` user can bind it.
- The mock exports its CA to a shared volume. The `api` and `workers` containers mount it and trust it through `NODE_EXTRA_CA_CERTS`.

Combine the overlay with a rendered Campus Commander all-docker Compose file:

```sh
docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml up --detach --wait
```

The overlay adds no file to Campus Commander. It routes the four Google hostnames to the mock inside the `internal` network.
The default image is private. Build it locally and point the overlay at it when you lack access:

```sh
docker build -t admin-sdk-mock:local .
ADMIN_SDK_MOCK_IMAGE=admin-sdk-mock:local docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml up --detach --wait
```

A plain `docker run` needs `--sysctl net.ipv4.ip_unprivileged_port_start=0` to bind port 443.
Seeding an `xlarge` domain blocks the mock for about 26 seconds. Seed before you connect Campus Commander.
[docs/campus-commander.md](../campus-commander.md) holds the full procedure.
