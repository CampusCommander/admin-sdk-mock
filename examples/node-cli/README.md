# Node CLI example

This example starts the mock with the CLI. A separate Node script then lists five users with the unmodified Google client.

## Prerequisites

- Node 24.11 or later.
- The `@googleapis/admin` and `google-auth-library` packages.
- The built mock package. In this repository, run `npm run build`.

## Run it

Run these commands from `examples/node-cli`. Use two terminals.

Terminal 1 starts the mock. It writes the key file under `.admin-sdk-mock/`.

```bash
node ../../dist/bin/admin-sdk-mock.js start
```

Terminal 2 loads the client environment and lists the users.

```bash
eval "$(node ../../dist/bin/admin-sdk-mock.js env)"
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/.admin-sdk-mock/credentials/example.json"
export ADMIN_SUBJECT=admin@salem-community-schools.test
node list-users.mjs
```

The `start` command reads `admin-sdk-mock.json` in the working directory. The file enables the proxy on port 3128.
Stop the mock with `Ctrl+C` in terminal 1. Delete `.admin-sdk-mock/` to remove the data and the key.

## Expected output

The script prints five primary emails, one per line. The seed `example` makes them the same on every run.

```text
aaliyah.rodriguez@students.salem-community-schools.test
aaliyah.schmidt@students.salem-community-schools.test
admin@salem-community-schools.test
alexander.bennett@students.salem-community-schools.test
alexander.evans@students.salem-community-schools.test
```

The script exits 1 with a message when `GOOGLE_APPLICATION_CREDENTIALS` or `ADMIN_SUBJECT` is missing.
