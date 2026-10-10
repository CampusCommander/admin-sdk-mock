# curl example

This example mints an access token with the CLI and calls `users.list` with `curl`. It uses no Google client library.

## Prerequisites

- `curl` 7.76 or later, for `--fail-with-body`, and `bash`.
- A running mock with the proxy on. See the [node-cli example](../node-cli) for the start command.
- The `@campuscommander/admin-sdk-mock` package, installed in your project.

## Run it

Run these commands from your project root. The mock must already run. Pass the customer ID of the domain. The `ready` event of `start` prints it.

```bash
eval "$(npx admin-sdk-mock env)"
export PATH="$PWD/node_modules/.bin:$PATH"
bash examples/curl/list-users.sh <customerId>
```

The script runs the command in `ADMIN_SDK_MOCK`, which defaults to `admin-sdk-mock`. The shell splits the value into words on purpose.

Inside this repository, run `npm run build`, then run the script from the repository root.

```bash
export ADMIN_SDK_MOCK="node dist/bin/admin-sdk-mock.js"
eval "$($ADMIN_SDK_MOCK env)"
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

The script lists five users. The output is abridged to the first user with most fields removed.
