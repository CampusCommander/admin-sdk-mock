# Troubleshooting

Each section names a symptom, its cause, and the fix.
Start with `npx admin-sdk-mock doctor`. It checks Node, the configuration, the data directory, the CA file, and every listener port.

## npx answers 404 after an npm install

Symptom: `npm install` exits 0, but `npx admin-sdk-mock` fails with `npm error 404 Not Found - GET https://registry.npmjs.org/admin-sdk-mock`.
`node_modules/@campuscommander/admin-sdk-mock` holds no `dist/` directory, and `node_modules/.bin` holds no `admin-sdk-mock`.

Cause: npm skipped the `prepare` script. `--ignore-scripts` or `ignore-scripts=true` in an `.npmrc` file does that.

Fix: run `npm install --ignore-scripts=false` in the project. `npm rebuild` does not build the package.
The [installation guide](installation.md#lifecycle-scripts) explains both script settings.

## EALLOWSCRIPTS on npm install

Symptom: `npm install` or `npm ci` fails with `git dep preparation failed`, then `EALLOWSCRIPTS` and `--allow-scripts is not allowed in project-scoped installs.`

Cause: an `.npmrc` file sets `allow-scripts`. npm 11.19 passes it to the nested install that prepares the Git dependency, and that install rejects it.

Fix: pass an empty value for one install, `npm install --allow-scripts=`. To fix it for good, find the file with `npm config ls`.
Remove the line, for example with `npm config delete allow-scripts --location=user`. Keep the project's policy in `package.json` instead.
The [installation guide](installation.md#lifecycle-scripts) shows the `allowScripts` entry for this package.

## Certificate errors

Symptoms:

- Node: `unable to verify the first certificate` or `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
- curl: `curl: (60)` with `unable to get local issuer certificate`.
- Python: `CERTIFICATE_VERIFY_FAILED`.

Cause: the client does not trust the mock CA.

- The CA variable is missing, or the client stack reads another variable. See the [variables table](clients.md#the-variables).
- Node read `NODE_EXTRA_CA_CERTS` before you set it. Node reads it once, at startup.
- A new data directory created a new CA, and the client still holds the old file.

Fix: run `eval "$(npx admin-sdk-mock env)"` in the client's shell, then start the client.
In process, call `useInProcess()` before the first request. In Docker, point the variables at the exported `ca.pem` and `ca-bundle.pem` on the host.

## 403 from the proxy

Symptoms: curl prints `CONNECT tunnel failed, response 403`. Other clients report a `403` status from the proxy.
The mock logs `{"event":"proxy-refused","target":"<host>:<port>"}`.

Cause: the target is not port 443 of one of the five Google hostnames, and `passthrough` is off.
The `init` starter and every configuration file default to `passthrough: false`.

Fix: add the other hosts to `NO_PROXY`, or turn passthrough on with `--passthrough`, `MOCK_PROXY_PASSTHROUGH=true`, or `"listen": { "proxy": { "passthrough": true } }`.
The GitHub Action and `startMock()` turn passthrough on by default.

Cause with passthrough on: the target is local, such as `127.0.0.1`, `localhost`, `[::1]`, or `169.254.169.254`. Passthrough still refuses it.
[SECURITY.md](../../SECURITY.md#passthrough) lists every refused form.

Fix: add the local host to `NO_PROXY`, so the client connects to it directly. The exported `NO_PROXY` already holds `localhost,127.0.0.1,::1`.

## Connection refused

Symptoms: `ECONNREFUSED` on the proxy port, or a control command prints `No mock answers at http://127.0.0.1:8080 (ECONNREFUSED).`

Causes and fixes:

- The mock is not running. Start it, and wait for the `ready` event or the ready file.
- The port differs. A configuration or a port of 0 moves a listener. Read the ports from the `ready` event or from `GET /info`, and pass `--control <url>`.
- The proxy is off. `env` warns `The proxy is off.` Set `listen.proxy` in the configuration, or pass `--proxy-port`.
- Docker does not publish the port. Add `-p 127.0.0.1:<host port>:<container port>` for each listener that you call.

## A request reaches real Google

Symptoms: a `401` that names a missing or invalid credential, with a `server: ESF` header, and no request in the mock's log.

Cause: the client ignores `HTTPS_PROXY`. Node's built-in `fetch` and `https` modules ignore it when the process starts without `NODE_USE_ENV_PROXY=1`.
`useInProcess()` cannot set it for the running process, so built-in `fetch` calls there skip the proxy.
A Google hostname in `NO_PROXY` has the same effect.

Fix: start a Node client with the variables from `env`, which include `NODE_USE_ENV_PROXY=1`.
In a test process, run such a call in a child process with `env()`, or use Google's client libraries.
Remove every Google hostname from `NO_PROXY`. A client that ignores proxies needs the [hosts-file alternative](clients.md#the-hosts-file-alternative).

## 401 unauthorized_client

Symptom: the token exchange answers `401` with `"error": "unauthorized_client"`.

Cause: the token request names a scope outside the delegation grant of the service account.
A `revoke-delegation` or `remove-scope` fault has the same effect.

Fix: request only the granted scopes, or grant more. Give `serviceAccounts[].scopes` the value `read-write`, or a list that covers the request.
For a running mock, issue a new key with `admin-sdk-mock credential <customerId> --scopes read-write`. Check `admin-sdk-mock fault list <customerId>` for a fault.

## 403 Not Authorized

Symptom: an API call answers `403` with "Not Authorized to access this resource/api".

Cause: the delegated subject is not a super administrator.

- The token names a seeded or fixture user without administrator rights.
- A `demote-subject` fault demoted the subject, or `users.makeAdmin` removed its rights.
- `users.list` named a `domain` that is not one of the customer's own domains.

Fix: delegate to the `adminEmail` of the domain, which the `ready` event and `GET /info` report.
A fixture user becomes an administrator with `"isAdmin": true`. Clear faults with `admin-sdk-mock fault clear <customerId>`.

A `403` with "Request had insufficient authentication scopes." has a different cause: the token lacks a scope that the method accepts.
The [API coverage reference](../reference/api-coverage.md) lists the scopes that each method accepts. The [configuration guide](configuration.md#service-accounts) lists the `read` and `read-write` scope sets.

## A list misses a recent write

Symptom: a `get` shows a write, but a list does not show it yet.

Cause: lists lag writes by the search delay, 300 seconds by default. The [behavior guide](behavior.md#the-search-lag) explains it.

Fix: call `flush(customerId)` or `admin-sdk-mock index flush <customerId>`, set `writes.searchDelaySeconds` to 0, or raise the time scale.
`timing.delays: false` does not remove the lag.

Two group delays look alike:

- `hasMember` answers `false` for a new nested link. The nesting delay, 600 seconds, still runs.
- `members.insert` answers `404 Resource Not Found: groupKey` for a new group. The ready delay, 60 seconds, still runs.

A flush ends both delays.

## A port in use

Symptom: `start` exits with code 1 and prints `listen EADDRINUSE: address already in use 127.0.0.1:8443`.
`doctor` reports `FAIL Google listener 127.0.0.1:8443 is in use.`

Cause: another process holds the port, such as a mock that still runs.

Fix: stop the other process, or move the listener with `--google-port`, `--control-port`, or `--proxy-port`. A port of 0 picks a free port.

## A keep restart error

Symptom: `start` exits with code 2 and prints:

```text
domains[0].spec changed since the domain was created. Set onStart to reset or delete the data directory.
```

The message names `fixtures` in place of `spec` when the fixtures file changed.

Cause: the domain exists in the data directory with another seed specification or fixtures file, and `onStart` is `keep`.

Fix: choose one of three:

- Set `onStart` to `reset`. The mock then seeds the domain again on every start.
- Delete the data directory. Every domain then seeds fresh.
- Restore the earlier specification or fixtures file.

## A slow xlarge seed

Symptom: `start` or `domain create --tier xlarge` takes about 26 seconds, and the control API stops answering meanwhile.

Cause: the seed writes the whole domain in one blocking step.
The milestone 3 scale run measured 26 seconds on the development machine for 60,301 groups and 1,705,693 memberships, in a 1,022 MB file.

Fix:

- Seed once and keep the data. With `onStart: keep`, later starts reuse the domain in moments.
- Wait for the `ready` event or the ready file before you connect a client. The GitHub Action waits up to 600 seconds.
- Use a smaller tier, or lower `counts`, when the test does not need Chicago-size data.

## A key file that cannot be written

Symptom: `start` exits with code 2 and prints:

```text
domains[0].serviceAccounts[0].out: /config/.admin-sdk-mock/credentials/demo.json cannot be written: EACCES. Choose a writable directory.
```

Cause: the `out` path names a directory that the mock cannot write. In the image, a relative path resolves against `/config`, a read-only mount. The `init` starter uses relative paths.

Fix: write key files under a writable directory. In the image, mount a host directory at `/out` and set `out` to a path such as `/out/credentials/demo.json`.

## Other errors

| Symptom                                                                | Cause and fix                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `start` exits with code 2: `<path> does not exist.`                    | `--config` or `MOCK_CONFIG` names a missing file. Fix the path, or unset the variable.             |
| `start` exits with code 2 and lists JSON paths                         | The configuration is invalid. Run `admin-sdk-mock config validate <file>` and fix each named path. |
| The control API answers `403` "The Host header is not allowed."        | The request used another host name. Call `127.0.0.1`, `localhost`, `[::1]`, or `admin-sdk-mock`.   |
| The control API answers `415`                                          | A request body lacks `content-type: application/json`. Add the header.                             |
| A control command exits with code 2: `... is not an http or https URL` | `--control`, `MOCK_CONTROL_URL`, or `ADMIN_SDK_MOCK_CONTROL` holds a malformed URL. Fix it.        |
