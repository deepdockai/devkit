import type { ApiErrorCode } from './codes.generated.ts'

export type CliCode =
  | 'invalid_usage'
  | 'org_required'
  | 'sign_in_needed'
  | 'approval_denied'
  | 'approval_expired'
  | 'connection_lost'

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5

// A new API code fails tsc here until it has a row: the Record is total over the union.
export const EXIT_CODES: Record<ApiErrorCode | CliCode, ExitCode> = {
  invalid_usage: 1,
  org_required: 1,
  organization_required: 1,
  invalid_request: 2,
  forbidden: 2,
  not_found: 2,
  device_not_found: 2,
  system_not_on_device: 2,
  action_not_found: 2,
  action_not_configured: 2,
  invalid_input: 2,
  pairing_code_invalid: 2,
  other_partner_build: 2,
  rate_limited: 2,
  target_rejected: 2,
  check_failed: 2,
  idempotency_conflict: 2,
  conflict: 2,
  already_member: 2,
  no_open_case: 2,
  unknown_author: 2,
  unknown_provider: 2,
  record_locked: 2,
  record_not_editable: 2,
  payload_too_large: 2,
  device_offline: 3,
  device_syncing: 3,
  // A 409, but not a refusal: it resolves once the device's client updates.
  device_outdated: 3,
  // A 409, but not a refusal: it resolves once Deepdock has verified the system's reported version.
  system_version_unverified: 3,
  action_paused: 3,
  access_outdated: 3,
  access_missing: 3,
  system_unavailable: 3,
  target_busy: 3,
  temporarily_unavailable: 3,
  internal_error: 3,
  // The CLI runs no action, so an unknown outcome can only be a failed request: retry later.
  outcome_unknown: 3,
  connection_lost: 3,
  client_outdated: 4,
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
