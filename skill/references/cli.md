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
| `auth logout [--keep-keys]` | revokes the sign-in and, unless `--keep-keys`, every API key this CLI created (on a terminal it lists them and asks, default keep; with `--json` or no terminal it revokes them unless `--keep-keys`); removes the entries it wrote, says what it revoked or kept | anyone |
| `orgs list` | the person's organisations: slug, name, role, which one is the default | member |
| `orgs select [slug]` | sets the default organisation; without a slug, a pick-list on a terminal | member |
| `systems list` | the systems and actions assigned to the organisation | member |
| `systems openapi <system>` | the system's OpenAPI document on stdout; redirect it to a file | member |
| `devices list` | paired devices with id, label, status, last seen, and each system with its access | member |
| `devices pair <code> [--label <text>]` | pair a device by the code on its screen, or the code `--admin pairing-code` prints on it (see [auth-and-keys.md](auth-and-keys.md#pairing-from-a-shell)) | member |
| `devices rename <deviceId> <label>` | rename a device | member |
| `devices release <deviceId>` | release a device (asks on a terminal; `--yes` otherwise) | admin |
| `devices systems <deviceId>` | the device's live systems and action state, paused reasons included; `device_offline` is a normal answer | member |
| `actions list <deviceId> <system>` | the action index: every action with its operation and field schemas | member |
| `keys list` | the organisation's API keys: name, prefix, created, last used, expires, status | member |
| `keys create <name> --expires <7d\|30d\|90d> --write-env <file>` | create an API key: opens a link, a human approves "Create an API key in <Org>?", the CLI receives the key once and writes `DEEPDOCK_API_KEY=<key>` into the file. It keeps no copy and shows the value to nobody. Answers id, name, prefix, expiry and where it was written | admin |
| `keys revoke <id>` | revoke a key (asks on a terminal; `--yes` otherwise); removes the env entry if this CLI wrote it | admin |
| `incidents list` | incidents of the last 30 days | member |
| `webhooks list` / `webhooks get <id>` / `webhooks events` | the organisation's webhook endpoints; one endpoint with its 7-day statistics; the event types of the triggers assigned to the organisation. Until Deepdock assigns a first trigger, every `webhooks` command fails with `not_found` (exit 2, "Webhooks are not available for this organisation yet"): ask Deepdock | member |
| `webhooks create <url> (--event <type>... \| --all-events) [--description <text>] [--write-env <file>]` | create an endpoint. `--all-events` sends every assigned type that exists now as an explicit list; a type added later reaches the endpoint only after `webhooks update`. An endpoint always has at least one type, and every type must be one of `webhooks events`: another is refused with `invalid_input` (exit 2) naming it. The signing secret is written as `DEEPDOCK_WEBHOOK_SECRET=<secret>` into the `--write-env` file and shown to nobody; without the flag, fetch it with `webhooks secret` | admin |
| `webhooks update <id> [--url <url>] [--description <text>] [--event <type>... \| --all-events]` | change what is given; the event types given replace the old ones | admin |
| `webhooks delete <id>` | delete an endpoint and its stored deliveries (asks on a terminal; `--yes` otherwise) | admin |
| `webhooks disable <id>` / `webhooks enable <id>` | stop sending; send again and resume what waited | admin |
| `webhooks secret <id> --write-env <file>` | write the signing secret into the file | admin |
| `webhooks rotate-secret <id> --write-env <file>` | make a new signing secret and write it; the old one signs for 24 more hours (asks on a terminal; `--yes` otherwise) | admin |
| `webhooks test <id> --event <type>` | send one example now; answers `data.attempt` (`outcome`, `statusCode`, `durationMs`, `responseBody`, the receiver's first KiB). Nothing is stored. Exit 0 means the example was sent, `outcome` says what the receiver did; `webhook_disabled` (exit 2) on a disabled endpoint | admin |
| `skill [--agent claude\|codex\|cursor\|all]` | writes this skill into the current repository | anyone |

Every command that acts in an organisation uses `--org <slug>` after the command, else
`DEEPDOCK_ORG`, else the default from `orgs select`; if you belong to exactly one organisation it is used and named on
stderr; with several and none chosen it stops with `org_required` and lists them. Always pass `--org` from an agent: `orgs select` changes the human's
default in every terminal.

`auth login` and `keys create` also open the approval link in the human's browser on a terminal, unless `--no-browser`, `DEEPDOCK_NO_BROWSER=1`, `CI` or a missing display says otherwise.

Global flags: `--org <slug>`, `--json`, `--yes`, `-h`, `-v`. Environment: `DEEPDOCK_ORG`, `DEEPDOCK_NO_BROWSER`,
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
id, name, prefix, createdAt and expiresAt; the key value is in neither stream. `webhooks secret` and
`webhooks rotate-secret` build theirs from id, secretCreatedAt and previousSecretExpiresAt; the secret is in neither stream.

A failure is one document on stderr: the API's error object unchanged plus what to do:

```json
{ "error": { "code": "device_offline", "message": "…", "requestId": "…" }, "meta": { "org": { "…": "…" }, "hint": "Retry later." } }
```

## Exit codes

| Exit | Meaning | Codes |
|---|---|---|
| 0 | done | |
| 1 | something on the command line to fix | `invalid_usage` (a bad flag, an unknown slug, a question with no terminal and no `--yes`, an env file git does not ignore), `org_required` |
| 2 | the API refused the request; do not repeat it unchanged | `invalid_request`, `not_found`, `device_not_found`, `pairing_code_invalid`, `other_partner_build`, `rate_limited`, `forbidden`, `conflict` and the other refusals (not `access_outdated` and `access_missing`, see exit 3) |
| 3 | retry later (`access_outdated` and `access_missing`: after the customer sets up the access again in the Deepdock client ("Zugang erneut einrichten", Set up access again)) | `device_offline`, `device_timeout`, `device_syncing`, `device_outdated`, `upload_incomplete`, `action_paused`, `access_outdated`, `access_missing`, `credentials_rejected`, `certificate_changed`, `system_unavailable`, `target_busy`, `temporarily_unavailable`, `internal_error`, `outcome_unknown`, `connection_lost` |
| 4 | the CLI is too old for the API: run `npx @deepdockai/cli@latest` | `cli_outdated` |
| 5 | sign-in needed: run `deepdock auth login` | `sign_in_needed`, `approval_denied`, `approval_expired` |

Branch on the exit code or on `error.code`, never on `message`.

## What the CLI never does

- It never prints a key value or a webhook signing secret, neither the sign-in nor an API key, under any flag.
- It never runs an action and never holds an API key: `actions list` shows what a device offers;
  your code runs the actions.
- It never names a device by label or picks one for you: a device is its full id, every time.
- It never retries: exit 3 says retry, you decide when.
