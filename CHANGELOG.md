# Changelog

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
