# Testing safely

Actions reach a real installation of the customer's system: the device you name is the one that
gets written to. These rules are not optional.

## The test device

- Test against **a demo device of your own**: a Windows machine with the same system installed as
  your customers run, with the Deepdock client paired to your organisation, and invented, marked
  data on it.
- **Never run a write against a device the human has not named as the test device.** If no device
  has been named, ask. Do not pick the first device from `devices list`; it may be a live customer.
- Pin the demo device's UUID in an environment variable (`DEEPDOCK_TEST_DEVICE`) and refuse to run
  tests without it.

## Test data

- Invented values only: no real customer, employee or address data, even "just one row",
  even from a screenshot. A fixture is copied into every clone and CI log for ever.
- Every record you create carries the marker **`TEST-DEEPDOCK-<6 random characters>`** in its
  name-like field (surname, company name), so it can be found and removed. Keep the marker through
  updates: when you test a name update, write a second `TEST-DEEPDOCK-...` value.
- Other fields take short values valid for their schema rule: a real past date, the first enum
  member, `1001` for an order number, `Beispielstadt` for a city.
- Keep the system's own text rules in mind: the OpenAPI document's field patterns and descriptions
  say what a text field accepts; stick to plain Latin letters in test values.

## Cleanup

No action deletes anything, and nothing is undone through the API. So:

1. Every test run prints what it created: record id, device, time, and how many change-log entries
   the updates added. The CLI runs no action, so your own test prints this.
2. Paste the list into the PR or the task that created it, with an owner and a date by which it is
   removed.
3. The partner removes the records through the system's own user interface on the demo machine, or
   resets the machine from a snapshot. Change-log entries stay until the reset.

## The loop your test runs

The CLI runs no action, so this loop is your code's, against the demo device:

1. `deepdock devices systems <device> --org <slug> --json`: the system is running and every action
   you need is active; otherwise stop and read the pause reason and `deepdock incidents list`.
2. **Create** with a fresh idempotency key and `TEST-DEEPDOCK-` names: expect `201` and an id.
3. **Replay** the same request with the same key: expect `200`, `Idempotent-Replayed: true`, no
   second record.
4. **Update** each update action once against that id, a new key each, changed values of the same
   shape (a name update writes a second `TEST-DEEPDOCK-` name).
5. **Read back** with the last written name as the search term: expect the id with the updated
   values.
6. Print the cleanup list.

The proof is your client; the CLI only shows what the device offers.

## Keys during development

- Run `deepdock keys create "<project> dev" --expires 30d --write-env .env.local --org <slug>`.
  A human approves it in the browser; the CLI writes the key into the file and keeps no copy.
  Neither you nor the human sees the value; you work with its id, prefix and file name only.
- Never ask for, read, print, echo, log or commit a key value. Use the key only against the demo
  device.
- It reaches every device of the organisation until it expires or is revoked. Tell the human its
  expiry date and that `deepdock keys revoke <id>` ends it, and that they create the live key with the same flow from their
  own CLI.

## Logs and prompts

- Never log an action's `input` or a read's `items` in your running product: they are the customer's
  records. Log the device id, the action, the code and the request id.
- Never paste real records into an agent prompt or a ticket. Use the `TEST-DEEPDOCK-` records from
  the demo device when you need a concrete example.

## Unit tests of your client

Mock the HTTP layer with the shapes from the OpenAPI document and this skill: `{ data }`,
`{ error: { code } }`, `Idempotent-Replayed: true`, a `503 device_offline` on a write followed by
a replayed `200`, a `500 outcome_unknown` followed by a read back. Cover every row of
[errors.md](errors.md) your product reacts to. Do not record real responses from a customer
device into fixtures.
