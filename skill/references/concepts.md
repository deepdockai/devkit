# Concepts

The words the API, the CLI and the dashboard use. Use them unchanged in code and copy.

## Organisation and partner

You, the partner, are an **organisation** in Deepdock. Everything you own (keys, devices,
incidents) is scoped to it. Members of your organisation see the dashboard; admins manage keys,
release devices.

## Keys

- **API key** (`ddk_live_` on production; a `ddk_test_` key belongs to a test deployment): your product's
  credential on `/v1`. It runs actions, pairs and releases devices, and reads incidents. Created by an
  admin in the dashboard (shown once) or from the CLI, which writes it straight into the app's env
  file, keeps no copy and shows it to nobody; optionally expiring.
- **CLI sign-in**: one person's credential, used only by the `deepdock` CLI after `deepdock auth
  login`. Valid 90 days. It manages (devices, keys, listing systems) and never runs an action.

Details: [auth-and-keys.md](auth-and-keys.md).

## Device

The Deepdock client installed on the customer's Windows PC next to their system. It connects
outwards to Deepdock; nothing in the customer's network is opened to the internet. A device is
identified by a UUID (`id`), carries a `label`, `hostname`, `os`, `clientVersion`, `status`
(`connected`, `offline` or `inactive`), `lastSeenAt`, `lastKnownAt`, `claimedAt` (may be `null`), `outdated` (an
assigned action needs a newer client: it answers `device_outdated`) and the `systems` it reported (each with a `writes` state; reads always work). `verified`: writes run. `unknown`: no version was reported, and writes go through. `partial`: some writes run and some are refused. `unverified`: a write answers `system_version_unverified`; with `reason: unverified_version` it works once Deepdock has verified that version, with `reason: unparseable` retrying does not help and you contact Deepdock.

- **Pair**: claim a device for your organisation with the 6-character code it shows while unpaired.
- **Release**: `DELETE /v1/devices/{deviceId}` gives the device back; it shows a new code.
- **Inactive**: a paired device that has not connected for 7 days. It stays yours and is active again
  when it connects.
- **Update**: the client updates itself. A device on an older build than Deepdock ships reports
  `updateAvailable`.

## System

A program on the device that Deepdock has made reachable, named by a slug such as `example-erp`. Each
has a display `label` (may be `null`), a `version` the device reported (may be absent), a `status`, and actions.
`GET /v1/devices/{deviceId}/systems` is a live call to the device, so it can answer
`device_offline`.

### Every status value and what it means for you

| Field | Value | Meaning | What to do |
|---|---|---|---|
| device `status` | `connected` | the device is online and can run actions | normal |
| device `status` | `offline` | the device is not connected right now (PC off, no network) | calls answer `device_offline`; retry later, show "offline" |
| device `status` | `inactive` | not connected for 7 days; still paired | as offline; check with the site whether the PC still exists |
| device `lastKnownAt` | ISO time or `null` | the time of the device's last report while it is not connected. `null` while it is connected | show the last known state with this time; it may be out of date |
| system `status` | `running` | the customer's program is running on the device | normal |
| system `status` | `stopped` | the program is installed but not running | calls answer `system_unavailable`; the site starts the program |
| system `status` | `missing` | the program was not found where the device expects it | calls answer `system_unavailable`; contact the site and Deepdock |
| system `status` | `unknown` | the device could not tell whether the program runs (its probe failed or is unavailable on that PC) | do not read it as stopped; the device decides when a call arrives |
| system `access` | `ok`, `outdated`, `missing`, `password_missing`, `not_set_up`, or `null` | the database access the device last reported (`null`: none known yet) | `outdated` refuses the actions that need the missing right with `access_outdated`, `missing` (the account cannot log in) and `password_missing` (the account exists but its stored password is not on the PC) refuse every action with `access_missing`; the customer repeats "Erneut einrichten" in the Deepdock client, the incident closes by itself once `access` is `ok`, nothing to resume |
| system `accessLastCheckedAt` | ISO time or `null` | set when `access` is the last known value because the device could not read it (its database stopped or unreachable): when it last read it. `null` when the latest report read it | show the access as last known, with this time; nothing to do until the device reads it again |
| system `lockedActions` | list of action names or `null` | the actions the device reports locked because its database account lacks a right they need, under the spec set it runs now. `null`: no verdict yet, or the verdict is for an older spec set | do not offer a locked action as available; it answers `access_outdated` until the customer repeats "Erneut einrichten" |
| action state | `active` | the action can be called | normal |
| action state | `paused` | the action is paused with a `reason` and `pausedAt` | calls answer `action_paused`; show the feature as paused, poll `GET .../systems` at a low rate |
| pause `reason` | `structure_changed` | the system changed in a way the action depends on (for example a vendor update); Deepdock reviews and resumes | wait; nothing to do on your side |
| pause `reason` | `check_failed` | a write's result did not match, so nothing was saved | wait; tell the user the change was not saved |
| pause `reason` | `system_stopped`, `system_missing` | as the system statuses above; these need no resume and clear when the system is back | as above |

Switch on these values; any value you do not know is shown as it is.

## Action

One deterministic, validated operation on a system: for example search customers by surname prefix,
create a note, update a note's text. Deepdock builds and verifies each action before
offering it; it then runs the same way every time. Actions are
**assigned** to your organisation by Deepdock, so the set you can call is yours, not the whole
catalogue.

- A **read** is `GET` with query parameters and pages.
- A **write** is `POST` (creates a record, answers `201`) or `PATCH` (updates a record, answers
  `200`), with a JSON body of string fields and an `Idempotency-Key` header.
- A write **either fully applies or not**: Deepdock checks the result before confirming, and if the check fails it saves nothing
  and pauses the action (`409 check_failed`).
- An action is **active** or **paused**. `GET /v1/devices/{deviceId}/systems` shows each action's
  state with `reason` and `pausedAt`.

## Pause and incident

Deepdock pauses an action instead of guessing when the customer's system no longer looks the way
the action expects:

| Reason | What you get | Meaning |
|---|---|---|
| `structure_changed` | `503 action_paused` | the system changed (for example a vendor update); Deepdock reviews and resumes |
| `check_failed` | that call `409 check_failed`, later calls `503 action_paused` | a write's result did not match, so nothing was saved |
| `system_stopped`, `system_missing` | `503 system_unavailable` | the customer's program is stopped or not found on the device |

Each pause opens an **incident** (`GET /v1/incidents`). Only Deepdock lifts a pause; staff at the
customer's site see that an action is paused but cannot resume it; there is no partner call to
resume. A stopped or missing system needs no resume: its incident closes once the system is back.

An incident has `id`, `system`, `version`, `action` (`null` for a system-level incident), `reason`,
`openedAt`, `closedAt`, and `devices` with `deviceId`, `pausedAt`, `resumedAt` and `inactiveAt`. It
closes once none of its devices is still paused. `GET /v1/incidents` lists incidents that are open
or closed within the last 30 days, newest first, at most 100.
