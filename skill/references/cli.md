# The `deepdock` CLI

Package `@deepdockai/cli`. Run with `npx @deepdockai/cli <command>` or
`bunx @deepdockai/cli <command>`; installed globally it is `deepdock`. If the CLI is missing,
install it; do not fall back to hand-written HTTP calls with a key in an argument.

The CLI runs with the person's sign-in and manages things: organisations, devices, keys, what a
device offers. It never runs an action and never holds an API key. Actions run from your code with
the API key the CLI wrote to the app's env file.

## Commands

| Command | What it does | Who |
|---|---|---|
| `auth login` | opens a link to the dashboard where the human clicks Approve; prints `Signed in as <email>.` and the person's organisations; the sign-in lasts 90 days | anyone |
| `auth status` | signed-in person, sign-in expiry, organisations, default organisation, the API keys this CLI created (id, prefix, expiry, where it was written); prints the same document and exits 5 when not signed in | anyone |
| `auth logout` | revokes the sign-in and every API key this CLI created, removes the entries it wrote, says what it revoked | anyone |
| `org list` | the person's organisations: slug, name, role, which one is the default | member |
| `org select [slug]` | sets the default organisation; without a slug, a pick-list on a terminal | member |
| `systems list` | the systems and actions assigned to the organisation | member |
| `systems openapi <system>` | the system's OpenAPI document on stdout; redirect it to a file | member |
| `devices list` | paired devices with id, label, status, systems, last seen | member |
| `devices pair <code> [--label <text>]` | claim a device by the code on its screen | member |
| `devices rename <id> <label>` | rename a device | member |
| `devices release <id>` | release a device (asks on a terminal; `--yes` otherwise) | admin |
| `devices systems <id>` | the device's live systems and action state, paused reasons included; `device_offline` is a normal answer | member |
| `actions list <device> <system>` | the action index: every action with its method and field schemas | member |
| `keys list` | the organisation's API keys: name, prefix, created, last used, expires, status | member |
| `keys create <name> --expires <7d\|30d\|90d> --write-env <file>` | create an API key: opens a link, a human approves "Create an API key in <Org>?", the CLI receives the key once and writes `DEEPDOCK_API_KEY=<key>` into the file. It keeps no copy and shows the value to nobody. Answers id, name, prefix, expiry and where it was written | admin |
| `keys revoke <id>` | revoke a key (asks on a terminal; `--yes` otherwise); removes the env entry if this CLI wrote it | admin |
| `incidents list` | incidents of the last 30 days | member |
| `skill [--agent claude\|codex\|cursor\|all]` | writes this skill into the current repository | anyone |

Every command that acts in an organisation uses `--org <slug>` after the command, else
`DEEPDOCK_ORG`, else the default from `org select`; with none it stops with `org_required` and
lists the organisations. Always pass `--org` from an agent: `org select` changes the human's
default in every terminal.

Global flags: `--org <slug>`, `--json`, `--yes`, `-h`, `-v`. Environment: `DEEPDOCK_ORG`,
`DEEPDOCK_BASE_URL`, `NO_COLOR`.

## Waiting for the browser

`auth login` and `keys create` need a human to click Approve. Without a terminal (your shell)
they do not wait: they print the request and exit 0, and you finish it later:

```bash
deepdock auth login --json              # { "data": { "pending": { "request": "rq_…", "url": "…", "expiresAt": "…" } } }
# show the human the url and wait for them to approve, then:
deepdock auth login --wait rq_…
deepdock keys create "<project> dev" --expires 30d --write-env .env.local --org <slug> --json
deepdock keys create --wait rq_… --json
```

A request lives 10 minutes; `--wait` on an expired one answers `approval_expired`. Never try to
approve for the human.

## Output

JSON is the default when stdout is not a terminal; pass `--json` to be sure. One document on
stdout:

```json
{ "data": <the API's data, unchanged>, "meta": { "org": { "slug": "…", "name": "…" }, "requestId": "…" } }
```

`data` is what the API answered, so what you see is what your code will receive. `meta` holds the
organisation the command acted in, the request id, and, where it applies, `written` (`{ file,
name }` from `keys create`) and `pending` (from `--no-wait`). `keys create` builds its `data` from
id, name, prefix, createdAt and expiresAt; the key value is in neither stream.

A failure is one document on stderr: the API's error object unchanged plus what to do:

```json
{ "error": { "code": "device_offline", "message": "…", "requestId": "…" }, "meta": { "org": { "…": "…" }, "hint": "Retry later." } }
```

## Exit codes

| Exit | Meaning | Codes |
|---|---|---|
| 0 | done | |
| 1 | something on the command line to fix | `invalid_usage` (a bad flag, an unknown slug, a question with no terminal and no `--yes`, an env file git does not ignore), `org_required` |
| 2 | the API refused the request; do not repeat it unchanged | `invalid_request`, `not_found`, `device_not_found`, `pairing_code_invalid`, `other_partner_build`, `rate_limited`, `forbidden`, `conflict` and the other refusals |
| 3 | retry later | `device_offline`, `action_paused`, `system_unavailable`, `target_busy`, `temporarily_unavailable`, `internal_error`, `connection_lost` |
| 4 | the CLI is too old for the API: run `npx @deepdockai/cli@latest` | `client_outdated` |
| 5 | sign-in needed: run `deepdock auth login` | `sign_in_needed`, `approval_denied`, `approval_expired` |

Branch on the exit code or on `error.code`, never on `message`.

## What the CLI never does

- It never prints a key value, neither the sign-in nor an API key, under any flag.
- It never runs an action and never holds an API key: `actions list` shows what a device offers;
  your code runs the actions.
- It never names a device by label or picks one for you: a device is its full id, every time.
- It never retries: exit 3 says retry, you decide when.
