# Run Campus Commander against the mock

This procedure changes no file in Campus Commander.

## Prepare

1. Start the Docker daemon. `docker version` must print a server version.
2. Build the mock image: `docker build -t admin-sdk-mock:local .`
3. In Campus Commander, follow `deployment/profiles/all-docker/README.md` to build the release, prepare an installation directory, and render `<install>/docker-compose.yml`.
   Use a phase 3 configuration. `deployment/examples/all-docker.json` is phase 1, which has no application sign-in and no Google connection.
   Phase 2 and later require `applicationAuth`, an OIDC issuer with an `https` URL. Phase 3 adds `googleConnection`.
   The release manifest needs a repository digest for each image, so push locally built images to a registry and pull them back first.

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

Docker runs in the implementation environment since 2026-10-10. The run still awaits the owner, who chooses the OIDC provider for a phase 3 installation.
The owner runs the steps above and fills the pending cells. The grid must show 60,000 devices.

The overlay routes the five Google hostnames to the mock on the `internal` network. The `api` service also sits on `ingress`, which reaches the internet, and a phase 3 render adds `google-egress` for `workers`.
Before you import the credential, run `nslookup admin.googleapis.com` inside `api` and `workers`. Both must answer with the mock's address.

| Check                                                        | Result                                            |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Device count in the grid status bar                          | Pending owner run: needs a phase 3 installation   |
| Full sync duration                                           | Pending owner run: needs a phase 3 installation   |
| `mock quota <customerId>` after the sync                     | Pending owner run: needs a phase 3 installation   |
| `git -C ~/projects/campus-commander status --short` is empty | Verified 2026-10-09: the command printed nothing. |
| Owner observation                                            | Pending owner run: needs a phase 3 installation   |
