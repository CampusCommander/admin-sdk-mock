# Examples

Each example is a small program that a consumer copies. The Node and Python examples use the unmodified Google clients. The curl example uses plain HTTP.
The runners `npm run test:examples` and `npm run test:python` prove that the examples work.

| Example                            | Shows                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| [node-in-process](node-in-process) | A Node test that starts the mock with `startMock()`.        |
| [node-cli](node-cli)               | A Node script that talks to a mock started by the CLI.      |
| [python](python)                   | A Python script that uses `google-api-python-client`.       |
| [curl](curl)                       | A shell script that calls the API with a minted token.      |
| [fixtures](fixtures)               | A fixtures file that declares exact users, devices, groups. |
| [github-actions](github-actions)   | A workflow that runs the mock image on a runner.            |

## Run the examples in this repository

1. Install the dependencies with `npm ci`.
2. Build the package with `npm run build`.
3. Run `npm run test:examples` for the Node, curl, and fixtures examples.
4. Install `examples/python/requirements.txt` into a virtual environment. From the repository root, run `python3 -m venv examples/python/.venv` and `examples/python/.venv/bin/pip install -r examples/python/requirements.txt`.
5. Run `PYTHON=examples/python/.venv/bin/python npm run test:python` for the Python example.

The Node examples import `@campuscommander/admin-sdk-mock` by name, as a consumer does.
