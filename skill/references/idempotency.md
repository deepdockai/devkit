# Idempotency for writes

Every `POST` or `PATCH` to an action carries an `Idempotency-Key` header. Without it the request is
refused with `400 invalid_request`.

## The key

- 8 to 128 characters from `A-Z a-z 0-9 _ -`.
- **One key per intended write.** Derive it from your own business event (an order id, a form
  submission id, a job id plus the action name), or generate a UUID and persist it with the pending
  write before sending. The key must survive a crash of your process, or a restart will write twice.
- **The same key for every retry of that write.** Never regenerate it on retry.
- Keys are remembered **per device**. The same key on another device is a different write.
- A successful key is remembered for at least 7 days.
- A write that was refused before anything was written (`invalid_input`, `target_rejected`, an
  action-specific 422 such as `unknown_author`, `not_found`) or undone (`check_failed`) frees its
  key: you may retry with the same key. After changing the input, use a new key; the old one may
  still be remembered with the old input. `idempotency_conflict` does **not** free a key.

## What a repeat answers

| Situation | Answer |
|---|---|
| same key, same input, earlier write succeeded | `200` with the original `data` and `Idempotent-Replayed: true`; nothing written again |
| same key, different input | `409 idempotency_conflict` |
| same key, the earlier write is still running | `409 idempotency_conflict`; wait, then retry with the same key and input |
| same key, the earlier write's outcome is unknown | `409 idempotency_conflict`; the key stays blocked |

The three `idempotency_conflict` causes share one code and `message` is not to be parsed. One rule
covers all three: retry with the same key and the same input a bounded number of times with
backoff (a running write finishes within seconds); if it still conflicts, treat it as
`outcome_unknown` below.

Treat a replayed `200` as success. Read the header if you need to know it was a replay, for
example to avoid double-logging.

## The three outcomes you must plan for

### `503 device_offline` on a write

The device did not answer within 20 seconds, or was not connected. **The write may still have
landed.** Retry with the **same key**: you get either the stored result (replayed) or a fresh run,
never two writes. Back off between retries (seconds, then minutes); a device can be off for hours,
so the retry runs from the persisted pending write in a job or queue, not inside the request that
started it. A client-side timeout or a network failure on a write is the same case: same key.

### `500 outcome_unknown`

The customer's system did not confirm the write. Deepdock cannot tell whether it landed. The key is
blocked: any reuse answers `409 idempotency_conflict`.

Do not write again under a new key until you know. Read the record back with a read action (for a
create, search by the value you wrote; for an update, read the record by id) and decide:

- found with the written values: treat as done, record it, move on;
- not found: write again under a **new** key;
- cannot tell (the read action does not expose the field): stop and hand the case to a human with
  the record identifiers.

### `409 check_failed`

The write was undone because its result did not match, and the action is now paused. Do not retry;
the next calls answer `503 action_paused` until Deepdock resumes it. Tell the user the change was not
saved.

## Persisting state

A robust integration keeps, per intended write: the idempotency key, the device id, the action, the
input, a status (`pending`, `sent`, `done`, `unknown`, `refused`) and the result. Transitions:

```
pending ──send──▶ sent ──2xx (fresh or replayed)──────────────▶ done
                   │  ──device_offline, timeout, network error, target_busy, temporarily_unavailable, internal_error ▶ sent  (retry later, same key)
                   │  ──idempotency_conflict, retries left ───▶ sent     (retry, same key, same input)
                   │  ──idempotency_conflict, retries spent ──▶ unknown  (read back before anything else)
                   │  ──outcome_unknown ──────────────────────▶ unknown  (read back before anything else)
                   │  ──invalid_input, target_rejected, action-specific 422, not_found, check_failed ▶ refused  (key is free; new input gets a new key)
                   │  ──action_paused, system_unavailable ────▶ sent     (retry once the action is active again)
```

## Example

```ts
const key = `order-${order.id}-create-note` // stable per business event, 8 to 128 chars

const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Idempotency-Key': key,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(30_000),
})
const replayed = res.headers.get('Idempotent-Replayed') === 'true'
```
