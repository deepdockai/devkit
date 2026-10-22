# Deepdock CLI

The partner CLI (`@deepdockai/cli`, command `deepdock`). Everything in this repository is written
for a reader outside Deepdock: describe what the CLI does for a partner, nothing more. No internals
of Deepdock's systems belong in this repository.

## Rules

1. **No credential in the repository.** `bun run check:public` (also part of the tests) scans the
   repository and the packed tarball for key shapes, env files, source maps that embed sources and
   files over 1 MB.
2. **No key value in any stream.** The CLI creates an API key and writes it to `--write-env`; it
   never prints, logs, stores or uses it. Not on stdout, not on stderr, not under `--json`, not in
   the config file, not in an error message (ArkType's own messages quote values, so
   `parseAnswer` reports the schema name only). `tests/noSecretOnStreams.test.ts` runs every
   command against a canary and must stay green. The sign-in secret and poll secrets follow the
   same rule.
3. **Stdout is data, stderr is context.** One JSON document per command (`{ data, meta }` or
   `{ error, meta }`); the organisation line, links and warnings go to stderr.
4. **Exit codes 0 to 5**, one typed record (`EXIT_CODES` in `src/api/errors.ts`) over the API's
   error-code union. A new API code fails `tsc` until it has a row.
5. **ArkType is loaded lazily** (`src/api/schemas.ts` only) so `--help`, `--version`, `auth status`,
   `skill` and usage errors never pay for it.
6. **The terminal gate is ours**: `stdin.isTTY && stdout.isTTY && !json`. No prompt library, no
   spinner, no emoji.

## Code

TypeScript strict, arrow functions only (the `CliError` class is the one exception), camelCase file
names, explicit types on parameters and returns, no `any`. Comments say why (an observed API
behaviour, a security reason), never what. Tests live in `tests/`, mirroring `src/`.

Commit titles: `<prefix>[(scope)]: <imperative subject>` with prefix one of `feature`, `bugfix`,
`refactor`, `chore`, `docs`, `hotfix`, `improvement`.

## Gates (all green before a commit)

```bash
bun run format && bun run lint && bun run typecheck
bun run test            # Bun
bun run test:node       # Node
bun run build && bun run check:public
```

## Layout

- `src/commands/` one file per noun; `src/program.ts` wires commander, reshapes every failure into
  the error document, and returns the exit code.
- `src/api/` client (one `request`), error classes and exit codes, generated error codes, schemas.
- `src/config/` the credential store and organisation resolution; `src/writeEnv/` the env-file
  rules and the ledger of keys this CLI created; `src/approval/` request and poll.
- `skill/` is copied into projects by `skill`; `references/cli.md` is regenerated from the
  command tree.
- `tests/fakeApi.ts` answers the routes the CLI uses; `tests/harness.ts` runs the real program
  in-process against a sandbox.
