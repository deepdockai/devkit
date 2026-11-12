# Auth, keys and pairing

| Environment | Base URL | API key prefix |
|---|---|---|
| Production | `https://api.deepdock.ai` | `ddk_live_` |

A deployment accepts only its own environment's keys. Test against a demo device of your own with
invented, marked data ([testing.md](testing.md)).

## API keys

- Format: the prefix, then 43 characters from `A-Z a-z 0-9 _ -`, then a 6-character checksum. Treat
  it as opaque; never parse it beyond the prefix.
- Created by an organisation admin in the dashboard (Keys page), where it is shown **once**, or
  with `deepdock keys create <name> --expires <d> --write-env <file>`, where the CLI writes it
  straight into the app's env file and shows it to nobody. Deepdock stores only a hash. The key list shows the
  first 8 characters after the prefix so keys can be told apart.
- Expiry is optional in the dashboard. A key created from the CLI must expire within 90 days; the
  skill's default is `--expires 30d` with a name that says what it is for (`"<project> dev"`).
- Revoked by an admin in the dashboard or with `deepdock keys revoke <id>`, immediately.
- Sent on every `/v1` request, the OpenAPI document included:

```http
Authorization: Bearer ddk_live_<your key>
```

Every reason a key is refused (missing, malformed, wrong environment, bad checksum, unknown,
revoked, expired) answers the same `401 unauthenticated` with `WWW-Authenticate: Bearer`. Your code
cannot tell them apart and should not try: surface "the Deepdock API key was refused; check the key
in the dashboard" and stop retrying.

### Handling the key in code

- Read it from the environment or a secret store (`DEEPDOCK_API_KEY` is the convention the
  dashboard's examples use). Never a literal in source, a test fixture, a log or a URL.
- One key per deployment is enough; there is no per-device key.
- A key works only against the API it was created on. The CLI uses production unless
  `DEEPDOCK_BASE_URL` is set; when it is (`deepdock auth status --json` shows it as `baseUrl`),
  `keys create --write-env` writes the same `DEEPDOCK_BASE_URL=<url>` line next to the key, and a
  production key points such a line at production. The bundled clients read it too.
- Getting a key into the app is the CLI's job: `deepdock keys create <name> --expires <d>
  --write-env <file>` opens a link to the dashboard; a human clicks Approve (or Deny); the CLI
  receives the key once and writes `DEEPDOCK_API_KEY=<key>` into the file, which must be ignored
  by git (if git cannot answer, the CLI writes the file and warns on stderr). It is displayed to nobody, neither you nor the human, and the CLI keeps no copy. The
  CLI answers with the key's id, prefix, name, expiry and the file; that is all you work with.
- Never ask for, read, print or paste a key value, and never try to extract it from the file.
  Code reads it at runtime from where the CLI put it.
- A development key reaches every device of the organisation until it expires or is revoked; keep
  the expiry short (`30d`), use it only against the demo device, and tell the human its expiry
  date and that `deepdock keys revoke <id>` ends it. The live key is created the same way,
  by the human from their own CLI, into the live secret store.

## The CLI sign-in (CLI only)

`deepdock auth login` opens a link to the dashboard; the human clicks Approve. The CLI then holds
the sign-in for that person, valid 90 days, stored in the CLI's own config with owner-only
permissions. The sign-in belongs to the person, not to an organisation: every command takes
`--org <slug>`. It does what that person can do in the dashboard (members read, pair and rename;
admins also release devices, create and revoke API keys) and never runs an action.
`deepdock auth status` shows the signed-in person, organisations and expiry (exit 5 when not signed in); `deepdock auth
logout` revokes the sign-in and every API key the CLI created, unless `--keep-keys` is passed (it then revokes only the sign-in). On a terminal it lists the keys and asks first; with `--json` or without a terminal it revokes them unless `--keep-keys` is passed.

Without a terminal `auth login` prints the request and exits; show the human the link, wait for
them to approve, then run `deepdock auth login --wait <request>`. Do not try to answer for them.
There is no sign-in from an environment variable.

## Pairing a device

A device is the Deepdock client installed next to the customer's system. The installer is at
`/public/client/download` under the base URL (production:
`https://api.deepdock.ai/public/client/download`); the link carries no credential, so it can be
sent to a new site as is. The pairing code is what ties the device to your organisation.

1. While unpaired, the client shows a code such as `K7Q-4MX`: 6 characters from
   `ABCDEFGHJKMNPQRSTVWXYZ23456789`. Case and the dash do not matter.
2. A code is valid for 10 minutes and is replaced shortly before it expires: read it off the screen
   when you pair.
3. Pair it:

```bash
curl -X POST "$BASE/v1/devices" \
  -H "Authorization: Bearer $DEEPDOCK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"K7Q-4MX","label":"Reception PC"}'
```

`label` is optional, 1 to 100 characters. The device must be online. Answer: `201` with the device
(`id`, `label`, `hostname`, `os`, `clientVersion`, `status`, `lastSeenAt`, `lastKnownAt`, `claimedAt`, `outdated`, `systems`,
and `updateAvailable` when it runs an older build); `hostname`, `os` and `clientVersion` are `null`
until the device has reported them. Keep `id`: it is the `deviceId` of every later call.
`GET /v1/devices` lists your devices a page at a time (`{ data: [...], nextCursor }`; pass `nextCursor` back as `cursor` until it is `null`, `limit` 1 to 500, default 100), and `GET /v1/devices/{deviceId}` reads one; each device has the same shape. `GET /v1/incidents` pages the same way.

4. Release with `DELETE /v1/devices/{deviceId}`; the device then shows a new code.

Pairing answers:

| Code | Status | Do |
|---|---|---|
| `invalid_request` | 400 | the code is malformed; fix the input |
| `pairing_code_invalid` | 404 | unknown, expired, replaced, already used, or the device is offline; ask for a fresh code |
| `other_partner_build` | 409 | the device runs another partner's branded client; only that partner can pair it |
| `rate_limited` | 429 | more than 5 failed pairing attempts in 60 seconds with this key; wait up to a minute |

Successful pairings do not count against the limit; malformed codes are refused before counting.

With the CLI: `deepdock devices pair <code> [--label <text>]`, `deepdock devices release <deviceId>`
(admin).

### Pairing from a shell

Only on the partner's own test PC, with an elevated administrator shell (an SSH session of an
administrator usually is; exit 2 below says yours is not). The program is Deepdock's unbranded build
`%ProgramFiles%\com.deepdock.client\Deepdock-Client.exe`; a branded build is
`%ProgramFiles%\com.deepdock.client.<slug>\<Name>-Client.exe`. A customer's PC goes the screen path:
a person there reads the access notice with the customer.

1. `& "$env:ProgramFiles\com.deepdock.client\Deepdock-Client.exe" --admin pairing-code | Out-String; $LASTEXITCODE`.
   The program opens no console of its own: pipe it as shown (then read `$LASTEXITCODE`), or
   `$p = Start-Process <exe> -ArgumentList '--admin','pairing-code' -Wait -PassThru -NoNewWindow; $p.ExitCode`;
   otherwise its output and exit code are lost. It prints `Pairing code: K7Q-4MX`; take the part
   after the colon. Exit codes: 0 code printed; 2 your shell is not elevated; 3 refused (right
   after an install: no code yet, retry in a minute); 4 the client's service is not running;
   5 already paired.
2. `deepdock devices pair <code> --label "<label>" --org <slug> --json` straight away. The code is
   short-lived (about 10 minutes, replaced before it expires, so claim it at once) and the first
   claim wins. On `pairing_code_invalid`, run step 1 again for a fresh code.

**Set up the access** the same way, after pairing:

1. `--admin consent <system> --json` until it exits 0. It prints
   `{ system, hash, notice, noticeEn? }`. Exit 7 with `No target is held for <system>.`: the PC
   has not received its targets yet, so wait a minute; if it persists, check the system name
   against `deepdock systems list`. Exit 7 with `The stored targets cannot be read`: stop and
   tell the human.
2. Show the human the `notice` (or `noticeEn`) and say that the database may restart. **Ask the
   human to close the program on every workstation first** and wait for their yes.
3. `--admin setup <system> <hash>`. Exit 6: the access changed since step 1, run consent again.
   Exit 3: refused, the message names why. Then poll as in the recipe: every 10 seconds for at most
   1 minute from the exit 0, until the system's `access` is `ok` (`deepdock devices list --json`),
   and ask the human what the client window shows on timeout. Then
   `deepdock actions list <device> <system> --json`.

A system that signs in over HTTP still needs the client's window for that
login: the credential is never accepted on a command line.

