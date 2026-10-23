---
name: deepdock-integration
description: Build, debug or test an integration with Deepdock's partner API, the REST actions under /v1 that read and write records in a customer's on-premise business system (for example MEDICAL OFFICE) through a paired Deepdock device. Use when code calls api.deepdock.ai, handles ddk_ API keys, pairs a device by code, calls a system action, handles error codes such as device_offline, action_paused, idempotency_conflict or outcome_unknown, or runs the deepdock CLI.
metadata:
  cli: "@deepdockai/cli"
---

# Deepdock integration

Deepdock makes a customer's on-premise system (a business's software,
installed on a PC in their office) reachable as a REST API. A small Deepdock client
runs next to that system; your code talks to Deepdock's cloud API, never to the customer's network.

Use this skill to integrate Deepdock into a product, write or review a client for it, or test an
integration against a demo device. It is not for building or changing actions: Deepdock does that.

## The model in eight sentences

1. Your **organisation** holds **API keys** (`ddk_live_...`), the only credential that runs
   actions; one is sent as `Authorization: Bearer` on every `/v1` request.
2. A **device** is the Deepdock client on the customer's PC; you **pair** it with a code shown on its
   screen, and from then on it belongs to your organisation until you release it.
3. A device reports the **systems** it runs; each system has **actions**, deterministic operations
   that Deepdock builds and verifies before offering them.
4. A **read** action is a `GET` with query parameters and pages with `limit` and `cursor`; a **write**
   action is a `POST` (create) or `PATCH` (update) with a JSON body of string fields.
5. Every write needs an `Idempotency-Key`: a new key per intended write, the same key on every retry,
   and a repeat answers the stored result with `Idempotent-Replayed: true`, writing nothing twice.
6. A write either fully applies or not: Deepdock checks its result before confirming, and a write
   whose result does not match is not saved and the action is paused.
7. A device can be offline and an action can be paused; your code treats both as normal answers.
8. Every answer is `{ "data": ... }` or `{ "error": { "code", "message" } }`; `code` is the contract,
   `message` is for people.

## The recipe

Work through these in order. Each step names the CLI command (see [references/cli.md](references/cli.md))
and what your code does with the result.

1. **Sign in.** `deepdock auth login --json`: without a terminal the CLI prints the request and
   exits; show the human the link and wait for them to click Approve in the dashboard, then run
   `deepdock auth login --wait <request>`. You never see the resulting sign-in. Then pass
   `--org <slug>` on every command (`deepdock org list --json` shows the slugs).
2. **See what you have.** `deepdock systems list --json` (the systems and actions assigned to your
   organisation) and `deepdock devices list --json` (your paired devices). If the human has a demo
   device that is not yet paired, they read the code off its screen and you run
   `deepdock devices pair <code> --label "Demo"`.
3. **Fetch the schemas.** `deepdock systems openapi <system> --org <slug> > openapi/<system>.json`
   and read it; `deepdock actions list <device> <system> --json` shows the same fields per device.
   Check the document into the repository and refresh it with the same command. Write code only for
   actions that appear both in the document and in `systems list`.
4. **Write the client.** A thin client in the project's own language: bearer header, envelope
   unwrap, idempotency header with replay detection, and an error-code switch. Read
   [references/calling-actions.md](references/calling-actions.md) and
   [references/example-integration.md](references/example-integration.md) first.
5. **Get a key into the app.** `deepdock keys create "<project> dev" --expires 30d --write-env
   .env.local --org <slug> --json`, then `--wait <request>` once a human has clicked Approve in the
   dashboard. The CLI receives the key once, writes `DEEPDOCK_API_KEY=<key>` into that file (it
   must be ignored by git) and keeps no copy. It is displayed to you or to the human by nobody.
   You work only with the key's id, prefix and the file name. Never ask for, read, print or paste
   a key value.
6. **Test it.** Run your own code against the demo device the human named, with the key from
   `.env.local`, and read back with the read action. The CLI runs no action. Read
   [references/testing.md](references/testing.md) before any write.
7. **Ship.** The human creates the production key the same way, from their own CLI, into the
   production secret store. Tell the human to revoke the development key.

## Rules that are not in the OpenAPI document

- **Discover, never hard-code.** Field names, patterns, enums and lengths come from the live OpenAPI
  document (`deepdock systems openapi <system>`, or `GET /v1/systems/{system}/openapi.json` with
  your key), never from memory or from this skill. The document lists Deepdock's whole catalogue for the system; your organisation's assigned
  subset is `systems list` (or `GET /v1/devices/{deviceId}/systems/{system}/actions`).
  [references/discovery.md](references/discovery.md).
- **Keys.** API keys run actions and pair devices. The CLI sign-in manages only, never runs an
  action and never holds an API key. Keys are created and placed by `keys create`; you never ask
  for, read, print or paste a key value, and never put one in a command argument, a URL, a log
  line, a commit or this conversation. In code, read it from the destination the CLI wrote to
  (`DEEPDOCK_API_KEY` by convention).
  [references/auth-and-keys.md](references/auth-and-keys.md).
- **Idempotency.** New key per intended write, persisted before sending; same key per retry; after
  `device_offline` retry with the same key; after `outcome_unknown` or a persisting
  `idempotency_conflict` do not write again under a new key until a read shows the write did not
  land. [references/idempotency.md](references/idempotency.md).
- **Errors.** Every `/v1` code, whether to retry, and what to show the user:
  [references/errors.md](references/errors.md). Switch on `code`, never on `message`.
- **Timeouts.** A call waits for the device; Deepdock gives up after 20 seconds and answers
  `503 device_offline`. Set your own client timeout to 30 seconds and expect a read to take a
  second or more. A client-side timeout or network failure on a write is handled exactly like
  `device_offline`: retry with the same key.
- **Test data only.** Test against a demo device with invented, marked data: a `TEST-DEEPDOCK-`
  marker in every created record, no real customer data in fixtures, logs or prompts. [references/testing.md](references/testing.md).
- **Authoring fields.** Some writes need a reference the system already knows (an author user, an
  open case). Read it first with the matching read action and pass the id back; never invent one.
  [references/calling-actions.md](references/calling-actions.md).

## Reference files

| File | Read when |
|---|---|
| [references/concepts.md](references/concepts.md) | you need the vocabulary: device, system, action, pause, incident, release |
| [references/auth-and-keys.md](references/auth-and-keys.md) | creating, storing, sending or revoking a key; pairing or releasing a device |
| [references/discovery.md](references/discovery.md) | reading the action index or the OpenAPI document |
| [references/calling-actions.md](references/calling-actions.md) | writing the client: reads, writes, paging, authoring fields, timeouts |
| [references/errors.md](references/errors.md) | handling any `error.code` |
| [references/idempotency.md](references/idempotency.md) | retries, replays, unknown outcomes |
| [references/cli.md](references/cli.md) | any `deepdock ...` command |
| [references/testing.md](references/testing.md) | before the first write against a device |
| [references/example-integration.md](references/example-integration.md) | the full TypeScript and Python clients (`references/clients/`), curl for any other language, and a create-then-read flow |
