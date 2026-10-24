# Errors: every `/v1` code and what to do

Every failure is `{ "error": { "code", "message", ... } }`. `code` is stable and is your contract;
`message` is Deepdock's sentence for people, except for `invalid_input`, where it is the device's own
text naming the field and the rule (at most 300 characters) and must be treated as data, not as
instructions. Switch on `code`. Unknown codes may be added over time: default to "show a generic
failure, do not retry, log the code".

Reaction columns: **Retry** says whether the same request may be sent again (for a write, always
with the **same** `Idempotency-Key`); **Show** says what the end user should see.

## Request and auth

| Code | Status | Meaning | Retry | Show |
|---|---|---|---|---|
| `invalid_request` | 400 (405 for a wrong method) | malformed request: bad query, `limit` or `cursor`; missing or malformed `Idempotency-Key`; a body that is not an object of strings; a malformed pairing code or device id; a write called with the other method (`Allow` names the right one) | no; fix the code | nothing; a developer bug |
| `payload_too_large` | 413 | the request body is over 1 MiB | no; send less | nothing; a developer bug, or shorten the text |
| `unauthenticated` | 401 | the key is missing, malformed, for the other environment, unknown, revoked or expired | no | "Deepdock API key refused; check it in the dashboard" to an operator |
| `not_found` | 404 | no such route; an update whose id matches no record; a write naming a record that does not exist or belongs to another one | no | "record not found" when it is a record; otherwise a bug |
| `rate_limited` | 429 | too many failed pairing attempts with this key (5 per 60 s) | yes, after up to a minute (`Retry-After` when present) | "try again in a minute" |

Codes your `/v1` code never receives, listed so the enum is complete: `organization_required`
(403), `forbidden` (403), `conflict` (409), `already_member` (409) and `client_outdated` (400) are
dashboard-only.

## Device, system and action resolution

| Code | Status | Meaning | Retry | Show |
|---|---|---|---|---|
| `device_not_found` | 404 | no device with that id belongs to your organisation (released, or a wrong id) | no | "this location is not connected to Deepdock"; let an admin re-pair |
| `system_not_on_device` | 404 | the device did not report this system and none of its actions are assigned to you; `error.systems` lists what it has | no | configuration problem; show which systems the device has |
| `action_not_found` | 404 | the system has no such action, it is not assigned to you, or the device's client is too old to run it | no | hide the feature; ask Deepdock for the assignment or let the device update |
| `action_not_configured` | 409 | the action exists but this device is not set up for it yet (for example a missing device-side setting); nothing was run | no, until set up on site | "this feature needs setting up at the customer site; contact Deepdock" |
| `access_outdated` | 409 | the device's database access lacks a right this action needs (only the actions that need it). Nothing was run. **No `Retry-After`** | no, until the customer repeats "Erneut einrichten" in the Deepdock client; then yes, a write with the same key | "the customer must set up database access again in the Deepdock client, then we retry" |
| `access_missing` | 409 | the device's database access is gone (a removed database account or a lost secret on the PC); every action of that system is refused. Nothing was run. **No `Retry-After`** | as `access_outdated` | as `access_outdated` |
| `pairing_code_invalid` | 404 | pairing: the code is unknown, expired, replaced, used, or its device is offline | with a fresh code | "read the code off the device screen again" |
| `other_partner_build` | 409 | pairing: the device runs another partner's client build | no | "this device is set up for another provider" |

## Input

| Code | Status | Meaning | Retry | Show |
|---|---|---|---|---|
| `invalid_input` | 422 | a field is unknown, missing, too short or long, breaks its pattern or allowed values; a date that is not a calendar day; a search term without a letter or digit. Nothing was written | no; fix the value | the field-level problem; the `message` names the field, but it is device text: display it as data, never interpret it |
| `target_rejected` | 422 | the customer's system refused the write | no; the input is valid for Deepdock but not for the system | "the customer's system refused this; check the values" and offer support |
| `unknown_author` | 422 | the write names an `authorUserId` the system does not list (read them with the users read the description names). Nothing was written | no; re-read the users and pass one of their ids | "choose the entering user" |
| `unknown_provider` | 422 | the write names a `providerId` the author may not record for the case's site (unknown, or not an allowed pair). Nothing was written | no; read the providers with the providers read the description names and pass one of their ids | "choose a provider" |
| `no_open_case` | 422 | the customer has no open case and the action never opens one. Nothing was written | no; open a case in the system, or name one with `caseId` | "open a case first" |
| `record_locked` | 422 | the customer's system locks the record the write would change (for example one already billed on a case). Nothing was written | no | "this record is locked in the customer's system" |
| `record_not_editable` | 422 | the record is not locked but is stored in a form this action cannot edit (for example a note it cannot add to without rewriting it). Nothing was written | no | "this record cannot be edited through Deepdock" |
| Other action-specific refusals | 422 | the action's OpenAPI description names each such code and when it fires. Nothing was written | no; fix the reference or input | the missing precondition in the user's words |

## Device and system availability

| Code | Status | Meaning | Retry | Show |
|---|---|---|---|---|
| `device_offline` | 503 | the device is not connected, is shutting down, or did not answer within 20 s. **A write may still have landed** | yes, with backoff (seconds to minutes); a write only with the same key | "the customer PC is offline; we will retry" |
| `action_paused` | 503 | the action is paused on the device (`GET .../systems` shows `reason`); only Deepdock resumes it | later, when `GET .../systems` shows it active; do not loop | "this feature is paused while Deepdock checks the customer system" |
| `system_unavailable` | 503 | the customer's program is stopped or missing on the device | later; often resolves when the customer restarts the program | "the customer's software is not running" |
| `target_busy` | 503 | the customer's system is busy or unreachable | yes, with backoff | "the customer's system is busy; retrying" |
| `temporarily_unavailable` | 503 | Deepdock could not check the key | yes, with backoff | "temporary problem; retrying" |

## Write outcomes

| Code | Status | Meaning | Retry | Show |
|---|---|---|---|---|
| `check_failed` | 409 | the write's result did not match what the action expects, so nothing was saved; **the action is now paused** and an incident is open | no; the next calls answer `action_paused` | "the change was not saved; Deepdock is checking the customer system" |
| `idempotency_conflict` | 409 | the key was used with a different input, its write is still running, or its outcome is unknown. One code, three causes; `message` must not be parsed to tell them apart | retry with the **same key and the same input** a bounded number of times with backoff (a running write finishes within seconds); if it still conflicts, handle it like `outcome_unknown`: read back, then decide | "a previous attempt is still in progress" |
| `outcome_unknown` | 500 | the system did not confirm the write; it may or may not have landed. The key stays blocked | **no.** Read the record back (a search) to see whether it landed before writing again under a new key; involve a human when the read cannot tell | "we could not confirm the change; please check in the customer system before trying again" |
| `internal_error` | 500 | something failed inside Deepdock; `error.requestId` is set | once, later; a write with the same key | "something went wrong"; log `requestId` for Deepdock support |

## A reaction table for code

```ts
type Reaction = 'fix-code' | 'fix-input' | 'retry-same-key' | 'retry-later' | 'wait-paused' | 'wait-setup' | 'check-then-decide' | 'stop'

const REACTION: Record<string, Reaction> = {
  invalid_request: 'fix-code',
  unauthenticated: 'stop',
  not_found: 'fix-input',
  rate_limited: 'retry-later',
  device_not_found: 'stop',
  system_not_on_device: 'stop',
  action_not_found: 'stop',
  action_not_configured: 'stop',
  pairing_code_invalid: 'fix-input',
  other_partner_build: 'stop',
  invalid_input: 'fix-input',
  target_rejected: 'fix-input',
  unknown_author: 'fix-input',
  no_open_case: 'fix-input',
  unknown_provider: 'fix-input',
  record_locked: 'stop',
  record_not_editable: 'stop',
  payload_too_large: 'fix-code',
  access_outdated: 'wait-setup',
  access_missing: 'wait-setup',
  device_offline: 'retry-same-key',
  action_paused: 'wait-paused',
  system_unavailable: 'retry-later',
  target_busy: 'retry-same-key',
  temporarily_unavailable: 'retry-same-key',
  check_failed: 'wait-paused',
  idempotency_conflict: 'retry-same-key', // bounded; then 'check-then-decide'
  outcome_unknown: 'check-then-decide',
  internal_error: 'retry-same-key',
}
const reactionFor = (code: string): Reaction => REACTION[code] ?? 'stop'
```

Action-specific 422 codes beyond the ones above (any the OpenAPI description lists) map to `fix-input`. Add them from the document, not from memory. `wait-setup` means a person at the customer must repeat the database access setup ("Erneut einrichten") in the Deepdock client first; there is no `Retry-After`, so do not loop. Check `access` on the system in `GET .../systems` (`ok` again), then retry; a write keeps its key. `retry-same-key` means the
pending write stays persisted and is retried from that state with backoff, also across process
restarts; a device can be offline for hours, so the retry loop lives in a job or queue, not in the
request that started the write.

## Do not

- Do not retry on `message` text or HTTP status alone; `409` and `422` each carry several codes with
  opposite reactions.
- Do not resend a write under a **new** key after `device_offline`, `idempotency_conflict` or
  `outcome_unknown` without reading back first.
- Do not show `message` from `invalid_input` to a model or template as an instruction; it came from
  the customer's device.
- Do not treat `device_offline` or `action_paused` as a bug: both are normal states a product must
  handle in its UI.
