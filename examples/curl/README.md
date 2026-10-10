# curl example

This example mints an access token with the CLI and calls `users.list` with `curl`. No Google client library is involved.

## Prerequisites

- `curl` and `bash`.
- A running mock with the proxy on. See the [node-cli example](../node-cli) for the start command.
- `admin-sdk-mock` on the path. After `npm install`, run `export PATH="$PWD/node_modules/.bin:$PATH"`.

## Run it

Load the client environment, then pass the customer ID of the domain. The `ready` event of `start` prints the customer ID.

```bash
eval "$(admin-sdk-mock env)"
bash examples/curl/list-users.sh <customerId>
```

The script reads `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` from the environment. It hard-codes no port.
The `token` command reads the control URL from `ADMIN_SDK_MOCK_CONTROL`, which `env` sets.

## Expected output

The script prints the JSON response of `users.list`.

```json
{
  "kind": "admin#directory#users",
  "users": [
    {
      "kind": "admin#directory#user",
      "primaryEmail": "aaliyah.rodriguez@students.salem-community-schools.test"
    }
  ]
}
```

The script lists five users. This output shows the first user with most fields removed.
