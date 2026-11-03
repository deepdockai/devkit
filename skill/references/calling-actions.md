# Calling actions

All paths are under `/v1/devices/{deviceId}/systems/{system}/actions/{action}`. `deviceId` is the
UUID from pairing; `system` and `action` are the slugs from the action index.

## Calling an action: POST, or PATCH for an update

Every action is called with a flat JSON object as the body. A read and a create are `POST`, an
update is `PATCH`. What the action does is its `operation` (`read`, `create` or `update`), and its
`method` (`POST` or `PATCH`), in the action index and the OpenAPI document. Any other method
answers `405 invalid_request` with `Allow` naming the action's one method, so a `POST` to an update
is refused, not run.

Inputs are typed as the action's schema declares them and are never sent as text when they are not:
an integer is a JSON number (`"patientId": 4711`, not `"4711"`; the text form is refused with
`400 invalid_request`). Text is normalised to Unicode NFC before anything else happens; a composed
and a decomposed spelling are the same value.

**Never put an input in the URL.** A value in a URL reaches request logs, proxies and browser
history, which is where a patient's name or id must not end up. Any query string on an action
path, whatever it holds, answers `400 invalid_request` ("inputs go in the JSON body, not in the
URL") without repeating a name or a value. Because the body is JSON, a `+` or a non-ASCII letter
needs no escaping.

### Reads

A read takes its inputs, and `limit` (a JSON integer from 1 to 250, default 25) and `cursor` (a
string) for paging, in the same body. No `Idempotency-Key`: a repeated read changes nothing, and the
header is ignored.

```bash
curl -X POST "$BASE/v1/devices/$DEVICE/systems/example-erp/actions/searchCustomers" \
  -H "Authorization: Bearer $DEEPDOCK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"lastName":"Müller","limit":50}'
```

```json
{ "data": { "items": [ { "customerId": 1001, "lastName": "Müller", "city": "Beispielstadt" } ], "nextCursor": null } }
```

- Pass `nextCursor` back as `cursor` unchanged while it is not `null`, and stop only on `null`,
  never on a short page: a page of long entries (notes) ends before `limit` rows to keep the
  device's answer under 1 MiB and still carries a cursor. It is opaque: never parse, build or store
  it beyond the next request.
- Items are the customer's records. Values can be `null` where the schema says so. Dates and other
  non-numeric values arrive as text in the system's own format (the schema and description say
  which); numbers as JSON numbers.
- A read's description may say a field is a **prefix match** and what it ignores (case,
  punctuation, umlaut spelling). Design your search UI around that rule rather than filtering
  client-side.

### Writes (create and update)

Body: a flat JSON object with only the fields the schema lists (`additionalProperties: false`) and
all of its `required` ones, each typed as the schema declares. Header `Idempotency-Key`, required.

```bash
curl -X POST "$BASE/v1/devices/$DEVICE/systems/example-erp/actions/createNote" \
  -H "Authorization: Bearer $DEEPDOCK_API_KEY" \
  -H "Idempotency-Key: order-8f1c2a-create-note" \
  -H "Content-Type: application/json" \
  -d '{"text":"TEST-DEEPDOCK-K3M9QA","orderNumber":"1001"}'
```

- A create answers `201` with `{ data: { <returned fields> } }`, typically the new record's id. A
  replay of the same key answers `200` with the same data and `Idempotent-Replayed: true`.
- An update is a `PATCH` to the same path, with the same body rules, and answers `200` whether it ran now or is a replay; the header tells
  you which.
- The returned id is the system's own id (for example `noteId`). Store it as the system gave it;
  do not predict or re-key it. Result field types come from each action's own output schema: do not
  reuse one action's result type for another.
- Each update under a new key writes again and may add an entry to the system's own change log,
  even when values are unchanged. Do not "update" to no-op.

Full idempotency rules: [idempotency.md](idempotency.md).

## Authoring and reference fields

Some writes need a reference the system already knows: an author user for an entry, an open case
of a customer, the note id of an update. The pattern is always the same:

1. Read the reference with the matching read action (for example a users read, a case read, a
   customer search).
2. Pass its id back in the type the write's schema declares, usually the integer the read returned.
3. Handle the action-specific refusal the description names: for example `422 unknown_author` when
   the user is not one the system lists, or `422 no_open_case` when the customer has no open case and
   the action does not open one. Both mean nothing was written; fix the reference, do not retry
   blindly.

Never invent an id, copy one from another device, or hard-code one from a test run.

## Easy to get wrong

- **Send each input as the type its schema declares.** An id the schema declares as an integer goes
  in as a JSON number (`"customerId": 1001`), one it declares as text goes in as text
  (`"customerId": "1001"`: digits only, no leading zero, at most 10 characters). A value of the
  wrong type is refused with `400 invalid_request`, never converted. Result field types also come
  from the action's own output schema.
- **Mark every test text `TEST-DEEPDOCK-<id>`** on the demo device only, and list what you created
  ([testing.md](testing.md)).
- A call with a query string, or with a method other than the action's own, is refused (`400` and `405`), so a
  client library that puts parameters in the URL for you needs its body mode.

## Refusals specific to the call shape

| Answer | Cause | Fix |
|---|---|---|
| `405 invalid_request`, `Allow: POST` or `Allow: PATCH` | a method other than the action's own (for example `POST` to an update, or `PATCH` to a read or create) | use the method `Allow` names: `POST` for a read or create, `PATCH` for an update |
| `400 invalid_request` | a query string on an action path | move every value into the JSON body |
| `400 invalid_request` | an input of the wrong type, such as `"4711"` where an integer is declared | send the type the schema declares |

## Timeouts and latency

- Every action call is sent to the customer's PC and run there. Expect a read to take from a few
  hundred milliseconds to a few seconds; a write about the same plus its verification.
- Deepdock waits at most 20 seconds for the device, then answers `503 device_offline`. Set your HTTP
  client timeout to 30 seconds so you receive the code instead of timing out first. A write that
  timed out or failed on the network on your side may still have landed: retry with the same
  `Idempotency-Key`.
- An answer that is not JSON (a proxy's 502 or 504 page) is a transport failure: for a write, the
  same rule, retry with the same key; never treat it as refused.
- Run calls sequentially per device where order matters; there is no documented concurrency limit,
  but the device is one PC in one office.
- `GET /v1/devices/{deviceId}/systems` is a live call too; cache it for the duration of a user
  session rather than calling it per request.

## Rate limits

Each API key has its own budget on every `/v1` call: 600 calls per minute, and 120 writes per
minute. A write (an action run that needs an `Idempotency-Key`) counts against both. Over a budget
the call answers `429 rate_limited` with `Retry-After: 60` and `retryAfterSeconds: 60` in the error
body. Honour it, back off and do not loop; a retried write keeps its `Idempotency-Key`. The numbers
can change, so treat them as approximate. Pairing has a tighter limit of its own: 5 failed claim
attempts per key per rolling 60 seconds, whose `429` carries neither the header nor the field.

## Response headers worth reading

| Header | When | Meaning |
|---|---|---|
| `Idempotent-Replayed: true` | a write's `200` | the stored result of an earlier run; nothing written again |
| `Allow` | `405 invalid_request` | the action's one method: `POST` for a read or create, `PATCH` for an update |
| `WWW-Authenticate: Bearer` | `401` | the key was refused |
| `Retry-After` | `429` | seconds to wait, when present |

## The envelope

```ts
type Ok<T> = { data: T }
type Err = { error: { code: string; message: string; requestId?: string; systems?: string[] } }
```

`requestId` comes with a `500`: give it to Deepdock support. `systems` comes with
`system_not_on_device`: the systems this device reported or you were assigned. Unwrap once in one
place; never read `message` in code paths, only show it or log it.
