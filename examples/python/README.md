# Python example

This example lists five users with `google-api-python-client`. The client reaches the mock through the proxy variables.

## Prerequisites

- Python 3.9 or later.
- The `@campuscommander/admin-sdk-mock` package, installed in your project, with a mock running. The [node-cli example](../node-cli) shows the start command.
- The packages in `requirements.txt`. `httplib2` needs PySocks to tunnel through an HTTP proxy.

## Run it

Run every command from `examples/python`. Create the virtual environment at `examples/python/.venv`.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Start the mock from `examples/node-cli` as that example shows. Then load its environment and run the script.

```bash
eval "$(npx admin-sdk-mock env)"
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/../node-cli/.admin-sdk-mock/credentials/example.json"
export ADMIN_SUBJECT=admin@salem-community-schools.test
.venv/bin/python list_users.py
```

`env` sets `HTTPLIB2_CA_CERTS` and `HTTPS_PROXY`. The script needs no other setup.

Inside this repository, run `npm run build` first. Then use `node ../../dist/bin/admin-sdk-mock.js` in place of `npx admin-sdk-mock`.
From the repository root, `PYTHON=examples/python/.venv/bin/python npm run test:python` runs the example against a temporary mock.

## Expected output

The script prints five primary emails, one per line.

```text
aaliyah.rodriguez@students.salem-community-schools.test
aaliyah.schmidt@students.salem-community-schools.test
admin@salem-community-schools.test
alexander.bennett@students.salem-community-schools.test
alexander.evans@students.salem-community-schools.test
```
