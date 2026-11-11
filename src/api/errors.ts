import type { ApiErrorCode } from './codes.generated.ts'

export type CliCode =
  | 'invalid_usage'
  | 'org_required'
  | 'sign_in_needed'
  | 'approval_denied'
  | 'approval_expired'
  | 'connection_lost'

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5

// Codes only the dashboard tree (`/partner`) answers, which the CLI calls too. They are not in the
// pinned `/v1` document, so they are listed by hand; the API keeps the same list under the
// name `PARTNER_ERROR_CODES`.
export const PARTNER_API_CODES = [
  'organisation_required',
  'forbidden',
  'conflict',
  'already_member',
] as const
type PartnerApiCode = (typeof PARTNER_API_CODES)[number]

// A new API code fails tsc here until it has a row: the Record is total over the union.
export const EXIT_CODES: Record<ApiErrorCode | PartnerApiCode | CliCode, ExitCode> = {
  invalid_usage: 1,
  org_required: 1,
  organisation_required: 1,
  invalid_request: 2,
  forbidden: 2,
  // Not a retry: Deepdock has to approve the organisation first.
  partner_not_approved: 2,
  // Not a retry: Deepdock has to reactivate the organisation first.
  partner_deactivated: 2,
  not_found: 2,
  device_not_found: 2,
  system_not_on_device: 2,
  action_not_found: 2,
  action_not_configured: 2,
  invalid_input: 2,
  pairing_code_invalid: 2,
  other_partner_build: 2,
  // Not a wait: the PC runs the learning-only client, and only installing the Deepdock service on it
  // changes that.
  device_learning_only: 2,
  // Not a wait: the device sent an answer the API cannot read, which only an update of the
  // Deepdock client on that PC changes.
  device_answer_unreadable: 2,
  // Not a wait: a person at the customer must shut down the copied PC; calls work again about five
  // minutes after only one is connected.
  device_connected_twice: 2,
  rate_limited: 2,
  target_rejected: 2,
  readback_failed: 2,
  // The write landed (the answer names it in `created`); repeating it would write it twice.
  applied_unverified: 2,
  idempotency_conflict: 2,
  conflict: 2,
  already_member: 2,
  record_locked: 2,
  record_not_editable: 2,
  // Not a wait: the customer lifts the restriction (a locked record) in its own system.
  record_restricted: 2,
  too_many_rows: 2,
  payload_too_large: 2,
  // Not a retry: Deepdock has to approve the customer's installed system version for the action first.
  version_not_covered: 2,
  device_offline: 3,
  device_timeout: 3,
  device_syncing: 3,
  // A 409, but not a refusal: it resolves without the caller changing anything (the client
  // updates).
  device_outdated: 3,
  action_paused: 3,
  access_outdated: 3,
  access_missing: 3,
  // Like access_missing: a person at the customer renews the login or confirms the certificate.
  credentials_rejected: 3,
  certificate_changed: 3,
  system_unavailable: 3,
  target_busy: 3,
  temporarily_unavailable: 3,
  internal_error: 3,
  // The CLI runs no action, so an unknown outcome can only be a failed request: retry later.
  outcome_unknown: 3,
  connection_lost: 3,
  cli_outdated: 4,
  unauthenticated: 5,
  sign_in_needed: 5,
  approval_denied: 5,
  approval_expired: 5,
}

/** Exit code for a code the API sent; a code this build does not know falls back on the status. */
export const exitCodeFor = (code: string, status?: number): ExitCode => {
  if (Object.hasOwn(EXIT_CODES, code)) return EXIT_CODES[code as keyof typeof EXIT_CODES]
  return status !== undefined && status >= 500 ? 3 : 2
}

export type ErrorMeta = {
  hint?: string
  organisations?: string[]
}

export type CliErrorInit = {
  code: string
  message: string
  /** The API's error object, kept unchanged for --json. */
  raw?: Record<string, unknown>
  requestId?: string
  status?: number
  hint?: string
  retryAfterMs?: number
  organisations?: string[]
}

export class CliError extends Error {
  readonly code: string
  readonly raw: Record<string, unknown>
  readonly requestId: string | undefined
  readonly status: number | undefined
  hint: string | undefined
  readonly retryAfterMs: number | undefined
  readonly organisations: string[] | undefined

  constructor(init: CliErrorInit) {
    super(init.message)
    this.name = 'CliError'
    this.code = init.code
    this.raw = init.raw ?? { code: init.code, message: init.message }
    this.requestId = init.requestId
    this.status = init.status
    this.hint = init.hint
    this.retryAfterMs = init.retryAfterMs
    this.organisations = init.organisations
  }

  get exitCode(): ExitCode {
    return exitCodeFor(this.code, this.status)
  }
}

export const usageError = (message: string, hint?: string): CliError =>
  new CliError({ code: 'invalid_usage', message, hint })

export const signInNeeded = (): CliError =>
  new CliError({
    code: 'sign_in_needed',
    message: 'Your sign-in is missing or expired.',
    hint: 'Run `deepdock auth login`.',
  })
