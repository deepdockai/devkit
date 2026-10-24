# Worked example: the clients and one flow

Two full, tested clients ship with this skill; every other language gets `curl` below and ports
one of the two. Each client does the four things the OpenAPI document cannot tell you: the bearer
header, the envelope unwrap, the `Idempotency-Key` header with replay detection, and a typed error
carrying the code. Both also carry `attempt()`, one try of a persisted pending write that returns
the row's new status. Field names in the flow below are illustrative: read them from the live
document for your system.

| Language | File | Needs |
|---|---|---|
| TypeScript | [clients/deepdock.ts](clients/deepdock.ts) | `fetch` (Node 18+, Bun, Deno, browsers); no dependencies |
| Python | [clients/deepdock.py](clients/deepdock.py) | Python 3.9+, `httpx` |
| anything else | the `curl` calls below | port either client, keeping its shape |

Copy the file into the project; do not reach into the skill directory at runtime.

## What the clients give you

```ts
import { Deepdock, DeepdockError, DeepdockTransportError, attempt, type PendingWrite } from './deepdock'

const dd = new Deepdock(process.env.DEEPDOCK_API_KEY!, { base: process.env.DEEPDOCK_BASE_URL }) // unset: production; 30 s timeout
const page = await dd.read<Note>(deviceId, 'example-erp', 'searchNotes', { text: 'TEST-DEEPDOCK-' }, { limit: 50 })
for await (const p of dd.readAll<Note>(deviceId, 'example-erp', 'searchNotes', { text: 'TEST-DEEPDOCK-' })) { /* every page */ }
const { data, replayed } = await dd.write<{ noteId: number }>(deviceId, 'example-erp', 'createNote', 'POST', key, input)
const systems = await dd.systems(deviceId)                      // live; can throw device_offline
const device = await dd.pair('K7Q-4MX', 'Demo')                 // keep device.id
```

```python
from deepdock import Deepdock, DeepdockError, DeepdockTransportError, PendingWrite, attempt

dd = Deepdock(os.environ["DEEPDOCK_API_KEY"], base=os.environ.get("DEEPDOCK_BASE_URL", "https://api.deepdock.ai"))
page = dd.read(device_id, "example-erp", "searchNotes", {"text": "TEST-DEEPDOCK-"}, limit=50)
res = dd.write(device_id, "example-erp", "createNote", "POST", key, body)   # res.data, res.replayed
```

Errors: `DeepdockError` has `status`, `code`, `requestId`, `systems`; switch on `code`
([errors.md](errors.md)). `DeepdockTransportError` means no answer or not Deepdock's envelope
(timeout, network, a proxy page): for a write, retry with the same key.

## Sending a write: persist first, then one attempt at a time

Persist the pending write (key, device, action, method, input, status) **before** the first send,
so a crash between send and answer cannot produce a second record under a new key. `attempt()`
moves the row to `done`, `sent` (retry later, same key), `unknown` (read back before anything
else) or `refused` (nothing was written; a changed input gets a new key). A job retries `sent`
rows with backoff: seconds, then minutes, for hours if the device stays offline.

```ts
const row: PendingWrite = {
  key: `order-${order.id}-create-note`, // 8 to 128 chars of A-Z a-z 0-9 _ -, stable per business event
  deviceId, system: 'example-erp', action: 'createNote', method: 'POST',
  input, status: 'pending', conflictRetries: 0,
}
await store.save(row)                      // before the first send
const next = await attempt(dd, row)        // one try
await store.save(next)                     // the job picks up 'sent' rows later
```

## One flow: create a record on the demo device and read it back

```ts
import { randomUUID } from 'node:crypto'
import { Deepdock, attempt, type PendingWrite } from './deepdock'

const dd = new Deepdock(process.env.DEEPDOCK_API_KEY!, { base: process.env.DEEPDOCK_BASE_URL })
const deviceId = process.env.DEEPDOCK_TEST_DEVICE!   // the demo device the human named
const system = 'example-erp'
type Note = { noteId: number; text: string }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const run = async (store: { save: (row: PendingWrite) => Promise<void> }) => {
  const marker = `TEST-DEEPDOCK-${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`
  let row: PendingWrite = {
    key: `demo-${marker}-create`, deviceId, system, action: 'createNote', method: 'POST',
    input: { text: marker, orderNumber: '1001' },
    status: 'pending', conflictRetries: 0,
  }
  await store.save(row)

  // The demo retries inline a few times; a product retries from the store in a job.
  for (let delay = 2_000; row.status === 'pending' || row.status === 'sent'; delay = Math.min(delay * 2, 60_000)) {
    row = await attempt(dd, row)
    await store.save(row)
    if (row.status === 'sent') await sleep(delay)
  }
  if (row.status === 'refused') throw new Error(`refused: ${row.refusedCode}`)

  if (row.status === 'unknown') {
    // Read back before deciding: the write may have landed.
    const page = await dd.read<Note>(deviceId, system, 'searchNotes', { text: marker })
    const landed = page.items.find((p) => p.text === marker)
    if (!landed) throw new Error('write did not land; resend under a NEW key from the store')
    row = { ...row, status: 'done', result: { noteId: landed.noteId } }
    await store.save(row)
  }

  const created = row.result as { noteId: number }
  const page = await dd.read<Note>(deviceId, system, 'searchNotes', { text: marker })
  if (!page.items.some((p) => p.noteId === created.noteId)) throw new Error('created record not found by search')

  // Cleanup list for the PR: record id, device, time.
  console.log(`CREATED ${system} noteId=${created.noteId} on device ${deviceId} at ${new Date().toISOString()}`)
}
```

## curl, for any other language

```bash
BASE=${DEEPDOCK_BASE_URL:-https://api.deepdock.ai}
AUTH="Authorization: Bearer $DEEPDOCK_API_KEY"

# Pair a device (keep data.id)
curl -sS -X POST "$BASE/v1/devices" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"code":"K7Q-4MX","label":"Demo"}'

# The device's systems and action states (live; can answer device_offline)
curl -sS "$BASE/v1/devices/$DEVICE/systems" -H "$AUTH"

# The action index (your assigned actions, with schemas)
curl -sS "$BASE/v1/devices/$DEVICE/systems/example-erp/actions" -H "$AUTH"

# A read, paged: pass data.nextCursor back as cursor
curl -sS "$BASE/v1/devices/$DEVICE/systems/example-erp/actions/searchNotes?text=TEST-DEEPDOCK-&limit=50" -H "$AUTH"

# A create: new Idempotency-Key per intended write, the same on every retry; 201, or 200 with
# Idempotent-Replayed: true on a replay (-i shows the headers)
curl -sS -i -X POST "$BASE/v1/devices/$DEVICE/systems/example-erp/actions/createNote" \
  -H "$AUTH" -H "Idempotency-Key: demo-$(date +%s)-create" -H 'Content-Type: application/json' \
  -d '{"text":"TEST-DEEPDOCK-K3M9QA","orderNumber":"1001"}'

# An update: PATCH, same rules
curl -sS -i -X PATCH "$BASE/v1/devices/$DEVICE/systems/example-erp/actions/updateNote" \
  -H "$AUTH" -H "Idempotency-Key: demo-$(date +%s)-update" -H 'Content-Type: application/json' \
  -d '{"noteId":"1001","text":"TEST-DEEPDOCK-K3M9QA edited"}'

# Release a device
curl -sS -X DELETE "$BASE/v1/devices/$DEVICE" -H "$AUTH"
```

A port in another language keeps the clients' shape: one `send` that sets the bearer header,
parses the envelope, throws a typed error with `code` on `{ error }` and a transport error on no
answer or non-JSON; `read` with `limit` and `cursor`; `write` with `Idempotency-Key` and the
`Idempotent-Replayed` header; `attempt` over a persisted pending write.

## Mapping the user's intent to a call (checklist)

1. Which device? From your product's configuration for that customer site; never from the
   user's free text.
2. Is the action active? `systems()` once per session; show paused features as paused.
3. Which action and method? From the stored index for that system.
4. Does the write need a reference (author user, open case, record id)? Read it first.
5. Build the input as strings; validate against the schema (`pattern`, `minLength`, `maxLength`,
   `enum`) before sending so the user sees the rule where they typed.
6. Choose the idempotency key from your business event and persist it with the pending write.
7. Send; map the code with the reaction table; show the user the right sentence.
8. Store the returned id as the system gave it.
