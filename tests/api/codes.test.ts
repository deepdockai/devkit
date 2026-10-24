import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractCodes, renderCodes } from '../../scripts/errorCodes.ts'
import { API_ERROR_CODES } from '../../src/api/codes.generated.ts'
import { EXIT_CODES, exitCodeFor } from '../../src/api/errors.ts'
import { EXIT_CODES_HELP } from '../../src/help.ts'

// The exit-code table of the design (section 4), row by row: a row here that EXIT_CODES maps
// differently fails.
const DESIGN_TABLE: Record<number, string[]> = {
  1: ['invalid_usage', 'org_required'],
  2: [
    'invalid_request',
    'forbidden',
    'not_found',
    'device_not_found',
    'system_not_on_device',
    'action_not_found',
    'action_not_configured',
    'invalid_input',
    'pairing_code_invalid',
    'other_partner_build',
    'rate_limited',
    'target_rejected',
    'check_failed',
    'idempotency_conflict',
    'conflict',
    'already_member',
    'no_open_case',
    'unknown_author',
    'unknown_provider',
    'record_locked',
    'record_not_editable',
    'payload_too_large',
  ],
  3: [
    'device_offline',
    'device_syncing',
    'device_outdated',
    'action_paused',
    'access_outdated',
    'access_missing',
    'system_unavailable',
    'target_busy',
    'temporarily_unavailable',
    'internal_error',
    'connection_lost',
  ],
  4: ['client_outdated'],
  5: ['sign_in_needed', 'approval_denied', 'approval_expired'],
}

describe('error codes', () => {
  it('holds exactly the Error.code enum of the pinned device API', () => {
    const pin = JSON.parse(
      readFileSync(new URL('../skill/devices.openapi.json', import.meta.url), 'utf8'),
    )
    expect([...API_ERROR_CODES]).toEqual(extractCodes(pin))
    const designCodes = Object.values(DESIGN_TABLE).flat()
    for (const code of designCodes.filter((c) => !isCliOwn(c)))
      expect(API_ERROR_CODES).toContain(code)
  })

  it('gives every code the exit code the design table gives it', () => {
    for (const [exit, codes] of Object.entries(DESIGN_TABLE)) {
      for (const code of codes)
        expect(EXIT_CODES[code as keyof typeof EXIT_CODES]).toBe(Number(exit))
    }
  })

  it('names every retry-later code wherever the exit codes are listed', () => {
    const retryLater = Object.keys(EXIT_CODES).filter(
      (code) => EXIT_CODES[code as keyof typeof EXIT_CODES] === 3,
    )
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
    const cliDoc = readFileSync(new URL('../../skill/references/cli.md', import.meta.url), 'utf8')
    const rowOf = (text: string): string =>
      text.split('\n').find((line) => /^\| 3 /.test(line)) ?? ''
    for (const code of retryLater) {
      expect(EXIT_CODES_HELP, code).toContain(code)
      expect(rowOf(readme), code).toContain(`\`${code}\``)
      expect(rowOf(cliDoc), code).toContain(`\`${code}\``)
    }
  })

  it('maps the codes the design table leaves out explicitly', () => {
    expect(EXIT_CODES.unauthenticated).toBe(5)
    expect(EXIT_CODES.organization_required).toBe(1)
    expect(EXIT_CODES.outcome_unknown).toBe(3)
  })

  it('falls back on the status for a code this build does not know', () => {
    expect(exitCodeFor('brand_new_code', 409)).toBe(2)
    expect(exitCodeFor('brand_new_code', 502)).toBe(3)
  })

  it('keeps the checked-in file identical to what the generator writes', () => {
    const file = readFileSync(new URL('../../src/api/codes.generated.ts', import.meta.url), 'utf8')
    expect(file).toBe(renderCodes(API_ERROR_CODES))
  })

  it('reads the Error.code enum out of an OpenAPI document', () => {
    const document = {
      components: {
        schemas: {
          Error: { properties: { error: { properties: { code: { enum: ['a_b', 'c_d'] } } } } },
        },
      },
    }
    expect(extractCodes(document)).toEqual(['a_b', 'c_d'])
    expect(() => extractCodes({})).toThrow('no Error.code enum')
  })
})

const isCliOwn = (code: string): boolean =>
  [
    'invalid_usage',
    'org_required',
    'connection_lost',
    'sign_in_needed',
    'approval_denied',
    'approval_expired',
  ].includes(code)
