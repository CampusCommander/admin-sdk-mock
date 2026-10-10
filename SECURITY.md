# Security

The Admin SDK mock is test infrastructure. It never serves production traffic, and it holds no real Google data.
Run it only on a developer machine, a CI runner, or a test network.

## Security model

- The mock never accepts or stores a real Google credential. Every key it issues is its own. A key from real Google fails the token exchange.
- The mock writes key files with mode 0600. Logs never print private keys.
- The control API has no authentication. It binds to `127.0.0.1` outside the image, and it keeps two guards:
  - It answers `403` to a `Host` header other than `localhost`, `127.0.0.1`, `[::1]`, or `admin-sdk-mock`, each with any port.
  - It answers `415` to a `POST`, `PUT`, or `DELETE` body without `content-type: application/json`.
  - Together these block a web page from driving the mock with a cross-origin `text/plain` post or a rebound DNS name.
- The proxy refuses every target outside port 443 of the four Google hostnames unless `passthrough` is on. It never decrypts traffic, and with `passthrough` on it only tunnels. It binds to `127.0.0.1` outside the image.
- The image binds every listener to `0.0.0.0` so that other containers reach it. Publish its ports on `127.0.0.1` only, as the examples do.

## Passthrough

With `passthrough` on, the proxy relays to any host and any port. Every client that reaches the proxy can use the relay.
Through it, a client reaches the container's own control listener, which has no authentication, and link-local metadata endpoints such as `169.254.169.254`.

The proxy refuses these passthrough targets with `403` and the `proxy-refused` log event, as it refuses other targets:

- `localhost`, and every name that ends in `.localhost`.
- A literal loopback address in `127.0.0.0/8`, or `::1`.
- A literal link-local address in `169.254.0.0/16` or `fe80::/10`.
- The unspecified addresses `0.0.0.0` and `::`.
- The IPv4-mapped IPv6 form of each IPv4 address above, and IPv4 shorthand such as `127.1` or `2130706433`.

The check reads the target as the client wrote it, and it never resolves a name.
A host name that resolves to a local address still tunnels, for example `metadata.google.internal` on Google Cloud.
The container's own network address, such as `172.17.0.2:8080`, also tunnels to the control listener.

Every example therefore publishes each port on `127.0.0.1`. Then only processes on the host reach the proxy and the control API.
A port published on every interface lets any machine on the network relay through the proxy and drive the control API.
`start` logs a `warning` event when passthrough is on and the proxy listens on an address other than loopback, as in the image.
Keep passthrough off on a shared network. Turn it on only when you trust every client that reaches the proxy.

## Safe use

- Never point a production system at the mock, and never give the mock a real service-account key.
- Keep the data directory and the key files out of version control. The `init` starter keeps them under `.admin-sdk-mock/`.
- A client that ignores `HTTPS_PROXY` sends its requests to real Google instead of the mock. See [the clients guide](docs/guide/clients.md#node).
- Trust the mock CA only in the processes under test. The mock never installs it into a system trust store.

## Report a vulnerability

Report a suspected vulnerability privately to the repository owner. Open a draft security advisory on the `CampusCommander/admin-sdk-mock` repository, or contact the owner directly.
Do not open an issue for a vulnerability. Include the version, the steps to reproduce, and the impact.
