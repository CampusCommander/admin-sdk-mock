# Examples

Each example is a small program that a consumer copies. All of them run against the unmodified Google clients.
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
4. Run `npm run test:python` for the Python example. It needs the packages in `python/requirements.txt`.

The Node examples import `@campuscommander/admin-sdk-mock` by name, as a consumer does.
