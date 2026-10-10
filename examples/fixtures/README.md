# Fixtures example

This example declares exact data for a domain. A fixtures file adds two org units, three users, two devices, and two groups to an empty domain.
The test reads the data back through the Google client and asserts it.

## Prerequisites

- Node 24.11 or later.
- The `@googleapis/admin` and `google-auth-library` packages.
- The built mock package. In this repository, run `npm run build`.

## Run it

Run the command from the repository root. The test resolves `examples/fixtures/fixtures.json` against the working directory.

```bash
node --test examples/fixtures/fixtures.test.mjs
```

## The fixtures file

- `fixtures.json` names users on `lexington-public-schools.test`. That is the primary domain of the spec `{ "tier": "empty", "seed": "fixtures-example" }`.
- `ada.admin` is an administrator. `pat.paused` is suspended.
- `FIX-0002` is a disabled device. `FIX-0001` is assigned to `sam.student`.
- Each group lists its members with roles.

A fixtures file works with any tier. In a configuration file, set `fixtures` on the domain. The path resolves against the configuration file.

## Expected output

```text
✔ the users match the fixtures file
✔ the devices match the fixtures file
✔ the group members match the fixtures file
ℹ tests 3
ℹ pass 3
ℹ fail 0
```
