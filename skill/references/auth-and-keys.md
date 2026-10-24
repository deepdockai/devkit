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
  `DEEPDOCK_BASE_URL` is set; when it is (`deepdock auth status --json` shows it as `baseUrl`), put
  the same `DEEPDOCK_BASE_URL=<url>` line next to the key. The bundled clients read it too.
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
3. Claim it:

```bash
curl -X POST "$BASE/v1/devices" \
  -H "Authorization: Bearer $DEEPDOCK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"K7Q-4MX","label":"Reception PC"}'
```

`label` is optional, 1 to 100 characters. The device must be online. Answer: `201` with the device
(`id`, `label`, `hostname`, `os`, `clientVersion`, `status`, `lastSeenAt`, `claimedAt`, `systems`,
and `updateAvailable` when it runs an older build). Keep `id`: it is the `deviceId` of every later
call, and there is no `/v1` call to list devices (use `deepdock devices list` or the dashboard).

4. Release with `DELETE /v1/devices/{deviceId}`; the device then shows a new code.

Pairing answers:

| Code | Status | Do |
|---|---|---|
| `invalid_request` | 400 | the code is malformed; fix the input |
| `pairing_code_invalid` | 404 | unknown, expired, replaced, already used, or the device is offline; ask for a fresh code |
| `other_partner_build` | 409 | the device runs another partner's branded client; only that partner can claim it |
| `rate_limited` | 429 | more than 5 failed claim attempts in 60 seconds with this key; wait up to a minute |

Successful claims do not count against the limit; malformed codes are refused before counting.

With the CLI: `deepdock devices pair <code> [--label <text>]`, `deepdock devices release <id>`
(admin).
