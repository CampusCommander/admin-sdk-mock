# Run Campus Commander against the mock

This procedure changes no file in Campus Commander.

## Prepare

1. Start the Docker daemon. `docker version` must print a server version.
2. Build the mock image: `docker build -t admin-sdk-mock:local .`
3. In Campus Commander, follow `deployment/profiles/all-docker/README.md` to build the release, prepare an installation directory, and render `<install>/docker-compose.yml`.

## Start

```sh
export ADMIN_SDK_MOCK_IMAGE=admin-sdk-mock:local
docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml up --detach --wait
```

## Seed and connect

```sh
mock() { docker compose -f <install>/docker-compose.yml -f compose/campus-commander.overlay.yml exec -T admin-sdk-mock node bin/mockctl.ts "$@"; }
mock domain create --tier large --seed acceptance
```

Note the `customerId` and `adminEmail` that `domain create` prints.

```sh
mock credential <customerId> > mock-credential.json
```

1. Sign in to Campus Commander.
2. Open **Google connection**. Import `mock-credential.json`.
3. Enter the `adminEmail` from `domain create` as the delegated email. Confirm the customer.
4. Open **Devices** and select **Refresh inventory**. Wait for the sync to finish.

## Record

The Docker daemon is not available in the implementation environment. The demonstration needs the owner in a browser.
The owner runs the steps above and fills the pending cells. The grid must show 60,000 devices.

| Check                                                        | Result                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| Device count in the grid status bar                          | Pending owner run: Docker Desktop WSL integration is off |
| Full sync duration                                           | Pending owner run: Docker Desktop WSL integration is off |
| `mock quota <customerId>` after the sync                     | Pending owner run: Docker Desktop WSL integration is off |
| `git -C ~/projects/campus-commander status --short` is empty | Verified 2026-10-09: the command printed nothing.        |
| Owner observation                                            | Pending owner run: Docker Desktop WSL integration is off |
