# Contributing

This page describes the development workflow of the Admin SDK mock.

## Set up

Use Node 24.11 or later. CI uses the Node 24 release that `.nvmrc` names.

```sh
npm ci
```

Node runs the TypeScript sources directly in development, so no build step runs before a test.
`npm run build` compiles `src/` and `bin/` into `dist/` for the package. Git installs run it through `prepare`.

## Commands

| Command                 | Effect                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `npm start`             | Run `admin-sdk-mock start` from the sources, with the same flags and exit codes.     |
| `npm test`              | Run the unit, parity comparison, and docs tests.                                     |
| `npm run lint`          | Run ESLint.                                                                          |
| `npm run typecheck`     | Run the TypeScript compiler without output.                                          |
| `npm run format:check`  | Check formatting with Prettier. `npm run format` rewrites the files.                 |
| `npm run docs`          | Regenerate the generated sections of `docs/reference/`.                              |
| `npm run test:coverage` | Run the unit tests with the coverage gate.                                           |
| `npm run test:contract` | Validate responses against Google's discovery schemas.                               |
| `npm run test:compat`   | Run Google's Node clients against the mock through the proxy.                        |
| `npm run test:examples` | Build the package and run the Node, curl, and fixtures examples.                     |
| `npm run test:python`   | Run the Python example. It needs the packages in `examples/python/requirements.txt`. |
| `npm run test:package`  | Pack the package, install it into an empty project, and use it.                      |
| `npm run test:scale`    | Seed an `xlarge` domain and page through it. It takes several minutes.               |
| `npm run parity`        | Compare the mock with live Google. It needs the owner's Easton fixture.              |

Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run format:check` before each commit. CI runs every layer.
[docs/trust.md](docs/trust.md) explains what each test layer proves.

## Changes

- Write the failing test first, then the code that passes it.
- Keep every milestone 1 to 3 route, the control API guards, the `mockctl` commands, and the Campus Commander overlay working.
- Add no runtime dependency, and add no development dependency without the owner's agreement.
- Relative imports end in `.ts`. Type-only imports use `import type`. Never use `enum`, `namespace`, parameter properties, or decorators.
- A change to the configuration schema, the CLI help, or the route table also needs `npm run docs`. A test fails until the references match.
- A behavior that Google does not document gets a ruling and a row in [docs/calibration.md](docs/calibration.md).

## Writing rules

Documentation prose follows these rules:

- Use the active voice.
- Use no hedging words.
- Use no semicolons and no contractions.
- Keep each instruction sentence to 20 words or fewer.

## Commits and merges

End every commit message with a `Co-Authored-By` trailer that names the person or the model that wrote the commit.

```text
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

`main` takes merges directly, with no pull request.
A tag `vX.Y.Z` that matches the `package.json` version runs the release workflow. Only the owner pushes release tags.
Add a `## [X.Y.Z] - <date>` section to [CHANGELOG.md](CHANGELOG.md) before the tag. The release notes come from that section.
