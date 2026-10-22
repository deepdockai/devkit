# Deepdock CLI

[Deepdock](https://deepdock.ai) makes your customers' business systems reachable as
an API. A small Deepdock client runs on the customer's PC next to their system; your code calls
Deepdock's REST API, and Deepdock runs the action on the device. Nothing in the customer's
network is opened to the internet, and every action is built and verified by Deepdock before it
is offered to you.

This repository holds the partner CLI, published as [`@deepdockai/cli`](https://www.npmjs.com/package/@deepdockai/cli)
with the command `deepdock`, and the skill it installs for coding agents.

```bash
npx @deepdockai/cli@1 auth login
```

The CLI manages: your organisations, the devices paired to them, and your API keys, and it lists
the systems and actions a device offers. It never runs an action and never keeps or uses an API
key. Actions run from your own code with a key the CLI wrote into your env file.

Node 22.13 or newer. Installed globally (`npm install -g @deepdockai/cli@1`) the command is
`deepdock`; the examples below use that form.

## Before you start

You need a Deepdock partner organisation and a member account in it; Deepdock sets the
organisation up with you (get in touch at [deepdock.ai](https://deepdock.ai)). To try things out
you need a demo device: a Windows machine of your own running the same system as your customers,
with the Deepdock client installed from `https://api.deepdock.ai/public/client/download` and
holding only invented, marked data. While unpaired, the client shows a pairing code on its screen.

## Quick start

Sign in. The CLI prints a link; open it, check that the page names your computer and CLI version,
and click Approve. No password is typed into the terminal.

```
$ deepdock auth login
Open this link to approve the sign-in (it expires in 10 minutes):
  https://dash.deepdock.ai/cli?request=rq_...
The page shows this computer's name and the CLI version: check them before you approve.
Waiting for approval in the browser.

Signed in as anna.mueller@muster-it.example.
```

Choose the organisation to work in, then look around:

```bash
deepdock org select muster-it           # the default for every later command
deepdock devices list                   # paired devices, their status and systems
deepdock systems list                   # the systems and actions assigned to you
deepdock systems openapi example-erp > example-erp.openapi.json
```

Pair your demo device with the code on its screen:

```bash
deepdock devices pair K7Q-4MX --label "Demo PC"
```

Create the API key your code runs actions with. You need the admin role in the organisation; a
human approves the key in the browser, and the CLI writes it straight into the env file, keeps
no copy and shows the value to nobody. The file must be ignored by git, together with the CLI's
temporary file: a `.gitignore` line `.env*` covers both, and where git can tell, the CLI refuses otherwise.

```bash
deepdock keys create "myapp dev" --expires 30d --write-env .env.local
```

From here your code reads `DEEPDOCK_API_KEY` from `.env.local`, sends it as
`Authorization: Bearer` on every request to `https://api.deepdock.ai/v1` and calls the
actions described in the OpenAPI document. The API itself (pairing, writes with
`Idempotency-Key`, every error code, pauses and incidents) is described per system by
`deepdock systems openapi <system>` and shown in the dashboard; the skill below carries the same
knowledge into your coding agent.

## Commands

```
deepdock auth      login | status | logout
deepdock org       list | select [slug]
deepdock systems   list | openapi <system>
deepdock devices   list | pair <code> | rename <id> <label> | release <id> | systems <id>
deepdock actions   list <device> <system>
deepdock keys      list | create <name> | revoke <id>
deepdock incidents list
deepdock skill
```

| Command                                               | What it does                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth login`                                          | sign in as yourself, approved in the browser; the sign-in lasts 90 days                                                                                                 |
| `auth status`                                         | who is signed in, the organisations, and the keys this CLI created (id, name, prefix, expiry, file; never the value); exits 5 when not signed in, like `gh auth status` |
| `auth logout`                                         | revoke the sign-in and every key this CLI created                                                                                                                       |
| `org list`, `org select [slug]`                       | your organisations; set the default one                                                                                                                                 |
| `systems list`                                        | the systems and actions assigned to your organisation                                                                                                                   |
| `systems openapi <system>`                            | a system's OpenAPI document on stdout; redirect it to a file                                                                                                            |
| `devices list`                                        | paired devices with id, label, status, systems and last seen                                                                                                            |
| `devices pair <code> [--label <text>]`                | claim a device by the code on its screen                                                                                                                                |
| `devices rename <id> <label>`, `devices release <id>` | rename a device; unpair it from the organisation (admin)                                                                                                                |
| `devices systems <id>`                                | a device's live systems and action state, paused reasons included                                                                                                       |
| `actions list <device> <system>`                      | every action a device offers, with its method and fields                                                                                                                |
| `keys list`, `keys create <name>`, `keys revoke <id>` | the organisation's API keys (create and revoke: admin)                                                                                                                  |
| `incidents list`                                      | open incidents, and those closed within the last 30 days                                                                                                                |
| `skill [--agent claude\|codex\|cursor\|all]`          | install the agent skill into the current directory                                                                                                                      |

Global flags: `--org <slug>` and `--json` on every command, `--yes` to confirm `devices release`
and `keys revoke` without a question, `-h, --help` everywhere and `-v, --version` at the root.
`deepdock <command> --help` has the details, `deepdock help exit-codes` the exit codes.

Two things are never guessed. A device is always named by its full id: no default device, no
lookup by label. The organisation comes from `--org`, then `DEEPDOCK_ORG`, then the default
chosen with `deepdock org select`; with none the command stops and lists your organisations.

## The approval flow

`auth login` and `keys create` never ask for a password or a key. They print a link, a human
opens it and clicks Approve in the Deepdock dashboard, and the CLI collects the result. The page
shows the requesting computer's name and the CLI version, so you can tell the request is yours.
Approving gives the approver nothing: only the CLI that started the request can collect the
result. A request lives 10 minutes.

Without a terminal (a coding agent's shell, a script) both commands print the request and exit;
a human approves, and the request is finished later:

```bash
deepdock auth login --no-wait --json      # data.pending.request and data.pending.url
deepdock auth login --wait <request>
deepdock keys create "myapp dev" --expires 30d --write-env .env.local --no-wait --json
deepdock keys create --wait <request>
```

Ctrl-C during a wait leaves the request pending; `--wait <request>` resumes it.

## JSON mode for agents and scripts

On a terminal you get tables and plain sentences. When stdout is not a terminal, or with
`--json`, every command prints one document on stdout:

```json
{
  "data": { "...": "the API's data, unchanged" },
  "meta": { "org": { "slug": "muster-it", "name": "Muster IT" }, "requestId": "..." }
}
```

For list and show commands `data` is the API's answer unchanged, so what the CLI shows is what
your code will receive; `auth`, `org select` and `keys create` build it from named fields. A
failure is one document on stderr, `{ "error": { "code", "message" }, "meta": { "hint" } }`,
with the API's error object unchanged. Switch on `code` or on the exit code, never on `message`.

| Exit | Meaning                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | done                                                                                                                                                 |
| 1    | something on the command line to fix (`invalid_usage`, `org_required`)                                                                               |
| 2    | the API refused the request; do not repeat it unchanged (`invalid_request`, `not_found`, `forbidden`, `rate_limited` and the other refusals)         |
| 3    | retry later (`device_offline`, `action_paused`, `system_unavailable`, `target_busy`, `temporarily_unavailable`, `internal_error`, `connection_lost`) |
| 4    | the CLI is too old for the API (`client_outdated`): run `npx @deepdockai/cli@latest`                                                                 |
| 5    | sign-in needed (`sign_in_needed`, `approval_denied`, `approval_expired`); `auth status` when nobody is signed in                                     |

The CLI never retries on its own: exit 3 says retry, you decide when. `deepdock commands --json`
prints the whole command tree.

## The skill for coding agents

[`skill/`](skill/) is a skill for Claude Code, Codex and Cursor. It teaches an agent the
Deepdock model (organisation, API key, device, system, action), the recipe from sign-in to a
tested integration, how to read the OpenAPI document instead of guessing field names, writes
with `Idempotency-Key`, every error code and whether to retry it, and the rule that it never
asks for, reads or prints an API key value. It ships with reference clients in TypeScript and
Python.

```bash
deepdock skill                      # all three agents
deepdock skill --agent claude       # .claude/skills/deepdock/
deepdock skill --agent codex        # a marked section in AGENTS.md
deepdock skill --agent cursor       # .cursor/rules/deepdock.mdc
```

Codex and Cursor share the reference files under `.deepdock/references/`. Commit what it writes,
so every clone and agent sees the same skill. Run the command again after updating the CLI; it
rewrites the files it installs.

The skill insists on testing against a demo device with invented, marked data: your code puts a
`TEST-DEEPDOCK-<6 random characters>` marker in every record it creates, and no real customer data reaches a fixture, a log or a prompt.

## Windows

macOS and Linux need nothing special. On Windows:
- `npx @deepdockai/cli` needs Node 22.13 or newer.
- Git for Windows must be installed for the ignore checks on `--write-env`. Without it the key is
  still written, with a warning on stderr that the CLI could not check with git.
- The settings file lives under `%APPDATA%\deepdock\config.json` and the env file wherever you
  point `--write-env`. Windows has no POSIX file modes: both files keep the permissions of their
  folder. Under `C:\Users\<you>` only you can read them; in other folders other users of the PC
  may be able to. For that reason every run that writes the env file prints a line saying so. The
  settings file holds your sign-in and lives under `%APPDATA%`, which only you can read by
  default.
- In PowerShell, quote a path with spaces and use the same quotes for the whole argument:
  `deepdock keys create "myapp dev" --expires 30d --write-env ".\my app\.env.local"`. Backslashes
  and forward slashes both work.

## Security

- **No key is ever shown.** The CLI prints neither the CLI sign-in nor an API key value, under
  any flag, in any stream. `auth status` and `keys list` show ids, prefixes and expiries. A report
  that a key value reached stdout, stderr, the settings file or a log is a security report.
- **A key goes straight to your env file.** `keys create` writes `DEEPDOCK_API_KEY=<key>` into the
  file named by `--write-env` and keeps no copy. Inside a git repository the file must be ignored
  by git and not tracked; a symbolic link is refused. Outside a repository the key is written with
  a warning; if git cannot answer (not installed, a permission or ownership error, any other
  failure) the key is still written, with a warning on stderr naming the file and the reason, and
  you make sure it is not committed. An existing `DEEPDOCK_API_KEY=` line is replaced in place and the file is set to mode
  600. While the key is written it sits in a mode 600 temporary file next to the target (for
  `.env.local`, `.env.local.deepdock-tmp-<random>`); a `.gitignore` line `.env*` or
  `*.deepdock-tmp*` covers it; where git answers and the name is not ignored, the CLI refuses before anything is
  created.
- **The approval link is not a credential.** It names the request; the result is collected with
  a secret the CLI generated and keeps.
- **Keys expire and can be revoked.** A key reaches every device of the organisation until it
  expires (at most 90 days from the CLI) or is revoked. `deepdock keys revoke <id>` revokes it and
  removes the line the CLI wrote; `deepdock auth logout` revokes the sign-in and every key this
  CLI created. In `--json`, `data.removed` says what happened to the line: `null` for a key this
  CLI never wrote, otherwise `{ file, name, removal }` with `removal` `done`, `absent` (the line
  was already gone or holds another value) or `failed` (with a `reason`). If the file is held open
  by another program (a dev server watching it, on Windows), the key is still revoked and the
  command exits 0, with a warning that the line is still in the file and must be deleted by hand.
  `keys revoke` then keeps its ledger entry, so running `keys revoke <id>` again once the file is
  free removes the line (the API's "not found" for that key's own organisation counts as already
  revoked, and `data.alreadyRevoked` says so). `auth logout` reports the failure in
  `apiKeysRevoked[].removed` and in `meta.hint`, and clears its local records either way.
- **Local state** lives in `$XDG_CONFIG_HOME/deepdock/config.json`, else
  `~/.config/deepdock/config.json` (`%APPDATA%\deepdock\config.json` on Windows), mode 600 in a
  mode 700 directory. It holds the sign-in, the default organisation, the ids of the keys this
  CLI created (never their values) and a pending approval request. A file other users can read
  is refused with the `chmod` to run.
- **Environment:** `DEEPDOCK_ORG`, `DEEPDOCK_BASE_URL` (https, or http for localhost only),
  `NO_COLOR`. A sign-in or pending request is never sent to a different base URL than the one it
  was made against.

Report a vulnerability by email to torben@deepdock.ai, not in a public issue: [SECURITY.md](SECURITY.md).

## Development

```bash
bun install
bun run build         # dist/deepdock.js, one ESM file with no runtime dependencies
bun run test          # builds, then runs vitest under Bun
bun run test:node     # the same tests under Node (needs dist/ from the build)
bun run format && bun run lint && bun run typecheck && bun run check:public
```

`tests/fakeApi.ts` is a local HTTP server answering the routes the CLI uses:

```bash
bun scripts/fakeServer.ts &              # prints its URL
DEEPDOCK_BASE_URL=http://127.0.0.1:<port> node dist/deepdock.js auth login
```

## Licence

[MIT](LICENSE).
