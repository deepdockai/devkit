import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from '../src/api/codes.generated.ts'
import { EXIT_CODES } from '../src/api/errors.ts'
import { type FakeApi, startFakeApi } from './fakeApi.ts'
import { errorDocOf, execute, makeSandbox, type Sandbox, signInWith } from './harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
  await signInWith(box, api.url)
  await execute(box, ['org', 'select', 'muster-it'], { baseUrl: api.url })
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

const failWith = async (status: number, body: unknown) => {
  api.state.forced['GET /partner/devices'] = { status, body }
  return execute(box, ['devices', 'list'], { baseUrl: api.url })
}

describe('exit codes over the wire', () => {
  for (const code of API_ERROR_CODES) {
    it(`${code} keeps its code in --json and exits ${code === 'unauthenticated' ? 5 : EXIT_CODES[code]}`, async () => {
      const error = {
        code,
        message: `The API said ${code}.`,
        requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
        extra: { field: 'x' },
      }
      const status = EXIT_CODES[code] === 3 ? 503 : code === 'unauthenticated' ? 403 : 400
      const outcome = await failWith(status, { error })
      expect(outcome.code).toBe(EXIT_CODES[code])
      expect(errorDocOf(outcome.stderr).error).toEqual(error)
    })
  }

  it('answers a bare 401 as sign_in_needed, exit 5', async () => {
    const outcome = await failWith(401, { error: { code: 'unauthenticated', message: 'x' } })
    expect(outcome.code).toBe(5)
    expect(errorDocOf(outcome.stderr).error.code).toBe('sign_in_needed')
  })

  it('exits 0 on success', async () => {
    expect((await execute(box, ['devices', 'list'], { baseUrl: api.url })).code).toBe(0)
  })

  it('falls back on the status for a code from a newer API', async () => {
    expect((await failWith(409, { error: { code: 'brand_new', message: 'x' } })).code).toBe(2)
    expect((await failWith(502, { error: { code: 'brand_new', message: 'x' } })).code).toBe(3)
  })

  it('treats an answer without an error code or without data as a failure', async () => {
    const bare = await failWith(502, 'not json')
    expect(bare.code).toBe(3)
    expect(errorDocOf(bare.stderr).error.code).toBe('internal_error')
    const noData = await failWith(200, { nothing: true })
    expect(noData.code).toBe(3)
    expect(errorDocOf(noData.stderr).error.code).toBe('internal_error')
  })

  it('includes the request id in the human form of an internal error', async () => {
    const outcome = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(0)
    api.state.forced['GET /partner/devices'] = {
      status: 500,
      body: {
        error: {
          code: 'internal_error',
          message: 'Something broke.',
          requestId: 'c0ffee00-0000-4000-8000-000000000002',
        },
      },
    }
    const failed = await execute(box, ['devices', 'list'], { baseUrl: api.url, tty: true })
    expect(failed.code).toBe(3)
    expect(failed.stderr).toContain('Request id: c0ffee00-0000-4000-8000-000000000002')
  })
})
