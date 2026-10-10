# Python example

This example lists five users with `google-api-python-client`. The client reaches the mock through the proxy variables.

## Prerequisites

- Python 3.9 or later.
- A running mock with the proxy on. See the [node-cli example](../node-cli) for the start command.
- The packages in `requirements.txt`.

PySocks is required. `httplib2` tunnels through an HTTP proxy only with it.

## Run it

Install the packages into a virtual environment.

```bash
python3 -m venv .venv
.venv/bin/pip install -r examples/python/requirements.txt
```

Start the mock from `examples/node-cli`, then load its environment in another terminal.

```bash
eval "$(node dist/bin/admin-sdk-mock.js env)"
export GOOGLE_APPLICATION_CREDENTIALS="$PWD/examples/node-cli/.admin-sdk-mock/credentials/example.json"
export ADMIN_SUBJECT=admin@salem-community-schools.test
.venv/bin/python examples/python/list_users.py
```

`env` sets `HTTPLIB2_CA_CERTS` and `HTTPS_PROXY`. The script needs no other setup.

## Expected output

The script prints five primary emails, one per line.

```text
aaliyah.rodriguez@students.salem-community-schools.test
aaliyah.schmidt@students.salem-community-schools.test
admin@salem-community-schools.test
alexander.bennett@students.salem-community-schools.test
alexander.evans@students.salem-community-schools.test
```

In this repository, `PYTHON=.venv/bin/python npm run test:python` runs the example against a temporary mock.
