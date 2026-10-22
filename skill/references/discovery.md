# Discovering systems and actions

Never hard-code an action's fields. Three sources, each authoritative for one thing:

| Question | Source | Key |
|---|---|---|
| Which systems and actions does my organisation have? | `deepdock systems list --json` | CLI sign-in |
| What does this device run, and is each action active or paused? | `GET /v1/devices/{deviceId}/systems` | organisation |
| Which actions can I call on this device's system, with which schemas? | `GET /v1/devices/{deviceId}/systems/{system}/actions` | organisation |
| The exact paths, methods, fields, patterns, enums, lengths, responses | `deepdock systems openapi <system>` or `deepdock actions list <device> <system>` (or `GET /v1/systems/{system}/openapi.json`) | CLI sign-in or API key |

## The OpenAPI document

```bash
deepdock systems openapi example-erp --org <slug> > openapi/example-erp.json
# from your backend, with the API key:
curl "$BASE/v1/systems/example-erp/openapi.json" -H "Authorization: Bearer $DEEPDOCK_API_KEY"
```

OpenAPI 3.1, one document per system, cacheable for 60 seconds. Discover through the CLI; check the
document into the repository and refresh it with the same command when you touch the integration.

What to read off it:

- **`paths`**: one operation per action at
  `/v1/devices/{deviceId}/systems/{system}/actions/{action}`; the HTTP method is the action's
  kind (`get` read, `post` create, `patch` update). Use the method the document gives; the other
  write method answers `405 invalid_request` with an `Allow` header.
- **`summary` and `description`**: what the action does and what it changes in the system, what
  an omitted optional input becomes, action-specific refusals (`code` and when), and what the
  system only warns about and what the action does then. Read the description before mapping your
  fields.
- **Read inputs** are query parameters, all `type: string`, each with `maxLength` and possibly
  `minLength`, `pattern`, `enum` and a `description` such as "prefix match: case, punctuation and
  umlaut spelling are ignored". Plus `limit` (integer, 1 to 250, default 25) and `cursor` (opaque).
  An optional parameter is not in `required` and its description says what an omitted value
  becomes.
- **Write inputs** are the `requestBody` object schema: `additionalProperties: false`, every
  property `type: string`, `required` lists the mandatory ones. The `Idempotency-Key` header
  parameter carries its own pattern (8 to 128 characters of `A-Z a-z 0-9 _ -`).
- **Responses**: a read's `200` is `{ data: { items: [...], nextCursor } }`; a create's `201` and a
  replayed `200`; an update's `200`. Item and result fields are typed `string`, `integer` or `number`,
  often nullable (`["integer", "null"]`). The `Error` schema's `code` enum is the full list of codes.
- **`servers`**: the base URL of the API.

The document describes **Deepdock's whole catalogue** for the system. Your organisation may be
assigned a subset. Write code only for actions that appear in both the document and `systems list`
(or the device's action index); an action in the document but not assigned to you answers
`404 action_not_found`.

## The action index

```bash
curl "$BASE/v1/devices/$DEVICE/systems/example-erp/actions" \
  -H "Authorization: Bearer $DEEPDOCK_API_KEY"
```

Answers `{ data: [ { name, method, description, input, output } ] }`, filtered to your assigned
actions, with the same JSON Schemas the OpenAPI document carries. Use it at runtime to confirm an
action exists before offering it in your UI, or to validate input client-side before sending.

## The device's systems

```bash
curl "$BASE/v1/devices/$DEVICE/systems" -H "Authorization: Bearer $DEEPDOCK_API_KEY"
```

A live call to the device. Each system: `label`, `version`, `status`, and per action `active` or
`paused` with `reason` and `pausedAt`. Answers `503 device_offline` when the device is not
connected: that is a normal state, not an error in your code. Do not poll it tightly; it reaches the
customer's PC.

## Generated clients

If the project already uses an OpenAPI generator (`openapi-typescript`, `openapi-generator`,
`kiota`), generating from the document is fine. The generator will not produce the envelope unwrap,
the idempotency rule or the error-code reactions; those come from this skill. Remember the
document is the whole catalogue, not your assigned set.
