# Changelog

## 1.0.17

- A device whose identity is held by two PCs (a copied PC or VM snapshot) answers every call with `409 device_connected_twice`; nothing runs and the `Idempotency-Key` is free. The skill's error reference lists it, and the CLI exits with 2 for it.

## 1.0.16

- A new organisation waits for Deepdock's approval before it can act as a partner: until then every call with its keys answers `403 partner_not_approved`. The skill's error reference lists it, and the CLI exits with 2 for it.

## 1.0.15

- `device_offline` also covers a call cut off by a Deepdock restart or deploy (retry a write with the same key). `temporarily_unavailable` is also sent, with `Retry-After: 5`, when Deepdock cannot reach its database. The skill's error reference, idempotency and concepts pages say so.

## 1.0.14

- A system's `access` can be `password_missing`: the database account exists, but its stored password is not on the PC. Like `missing`, every action of the system is refused with `access_missing` (its message names the password) and the customer repeats "Erneut einrichten" in the Deepdock client. The agent skill's TypeScript client types it, and its concepts reference explains it.

## 1.0.13

- A device carries `lastKnownAt`: the time of its last report while it is not connected, `null` while it is connected. Every system of a device carries `lockedActions`: the actions the device reports locked because its database account lacks a right they need, under the spec set it runs now, or `null` when there is no verdict or the verdict is for an older spec set. Both are in the device list and, for `lockedActions`, in `GET /v1/devices/{deviceId}/systems`. The agent skill's TypeScript client types them, and its concepts reference explains them.

## 1.0.12

- The agent skill describes `rate_limited` for action calls: 600 calls and 120 writes per minute per API key, answered with `Retry-After: 60` and `retryAfterSeconds: 60`. It named only the pairing limit before.

## 1.0.11

- Every system of a device carries `accessLastCheckedAt`, in the device list and in `GET /v1/devices/{deviceId}/systems`. It is set when `access` is the last known value because the device could not read it (its database stopped or unreachable), and then says when the device last read it. It is `null` whenever the latest report read the access. The agent skill's TypeScript client types it, and its concepts reference explains it.

## 1.0.10

- `GET /v1/devices` and `GET /v1/incidents` page with a cursor: the answer is `{ items, nextCursor }`, with `limit` (1 to 500, default 100) and `cursor` query parameters. The agent skill's key and pairing reference says how to loop over the pages, and the pinned device API carries the new shape. The CLI lists devices through `/partner`, which is unchanged.
- The pinned device API documents the per-key `429 rate_limited` (600 calls and 120 writes per minute per API key, `Retry-After`).

## 1.0.9

- The CLI knows `device_learning_only` (exit code 2, refused): the PC runs the Deepdock client for learning only, which runs no actions, so action calls and the systems list on it are refused before anything is sent. It changes only when the Deepdock service is installed on that PC; retrying does not help. The skill's error reference lists it.

## 1.0.8

- The CLI knows `system_version_unverified` (exit code 3, retry later): a write on a customer system whose vendor version Deepdock has not verified yet is refused before anything is sent, and works once Deepdock has verified that version (`reason: unverified_version`). A version the API cannot parse (`reason: unparseable`) does not clear by waiting: contact Deepdock. Reads are unaffected.
- A device's systems carry `writes` (`verified`, `unknown`, `partial`, or `unverified` with a `reason`) in the agent skill's TypeScript client, and the skill's error, idempotency and concepts references describe the refusal.

## 1.0.7

- The CLI knows `device_syncing` and `device_outdated` (exit code 3, retry later) instead of falling back on the HTTP status.
- The agent skill's error reference and both clients' pending-write helpers retry them with the same key.
- `--help`, the README and the skill's CLI and idempotency references list every exit-3 code, `outcome_unknown` and the access codes included.

## 1.0.6

- The agent skill's TypeScript client types a device's `hostname`, `os` and `clientVersion` as `string | null`, as the API answers them before the device has reported them. The skill names `GET /v1/devices` and `GET /v1/devices/{deviceId}`.

## 1.0.5

- The agent skill's clients: `systems()` is typed as the list of systems the API answers, and a paired `Device` lists its systems as objects, with `outdated` and a `claimedAt` that can be `null`.
- The TypeScript client runs with plain `node file.ts` (Node 22.18+, or 22.13+ with `--experimental-strip-types`).
- Both clients take their base URL from `DEEPDOCK_BASE_URL` when it is set, like the CLI.
- The agent skill holds nothing specific to one system: the recipe for one system is gone, and the skill points to the system's behaviour notes in its OpenAPI document instead.

## 1.0.4

- `DEEPDOCK_CONFIG_DIR` moves the settings file (and only it) to a directory of your choice, on every platform; it must be an absolute path. Useful for keeping separate sign-ins apart, for example one per project or account.

## 1.0.3

- `auth logout --keep-keys` revokes only the sign-in. On a terminal, plain `auth logout` lists the API keys and asks before revoking them (default: keep); with `--json`, `--yes` or no terminal it still revokes them. `keys create` says so.
- `keys create` no longer advises revoking the key "when you ship"; it prints the expiry and how to revoke.
- With exactly one organisation it is used automatically (and named), and `auth login` selects it. With several and none chosen, `org_required` stays.
- The approval page opens in your browser on a terminal (not in CI, without a display, with `--no-browser` or `DEEPDOCK_NO_BROWSER=1`). The line says "Opening the approval page in your browser" when it does.
- `Organisation:` is printed once per command, not again after the wait.
- Output colours by role: warning and error labels, success verbs, bold organisation and approval prompt, dim waiting line.
- The approval link is blue and underlined, and clickable in terminals that support links. Plain text when output is piped, under `--json`, or with `NO_COLOR`.

## 1.0.2

- The install commands no longer pin a major version: `npx @deepdockai/cli auth login`, `npm install -g @deepdockai/cli`.

## 1.0.1

- The agent skill: page with `nextCursor` until it is `null` (a short page can carry a cursor), and cover the codes `access_outdated`, `access_missing`, `record_locked`, `record_not_editable`, `unknown_provider`, `payload_too_large` and the system status `unknown`, in the skill and the CLI's exit-code table.
- The agent skill: one statement on how to fetch the OpenAPI document, and a recipe for one system with its action names.
- The agent skill states the id rule in full: reads and creates answer ids as integers, a create's new id included; every id you send is a string of digits without a leading zero, at most 10 characters, in a query string and a write body alike.

## 1.0.0

First release of `@deepdockai/cli`, the `deepdock` command.
- Sign in from the terminal with approval in the browser: `deepdock auth login`, `auth status`, `auth logout`.
- Organisations: `org list`, `org select`, and `--org` or `DEEPDOCK_ORG` on every command that acts in one.
- Devices, systems, actions and incidents: `devices list|pair|rename|release|systems`, `systems list|openapi`, `actions list`, `incidents list`.
- API keys that never pass through the terminal: `keys create` (approved in the browser, written straight to your env file), `keys list`, `keys revoke`.
- The agent skill for Claude Code, Codex and Cursor: `deepdock skill`.
- Output built for scripts and coding agents: JSON when stdout is not a terminal, stable exit codes 0 to 5.
- Runs on Linux, macOS and Windows with Node 22.13 or newer.
