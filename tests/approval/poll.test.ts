import { describe, expect, it } from 'vitest'
import type { Api, ApiRequest } from '../../src/api/client.ts'
import { CliError } from '../../src/api/errors.ts'
import { pollUntilApproved } from '../../src/approval/poll.ts'
import type { Runtime } from '../../src/runtime.ts'

const runtime = (now: () => Date): Runtime =>
  ({
    now,
    sleep: async () => undefined,
    pollIntervalMs: 0,
    signal: new AbortController().signal,
  }) as unknown as Runtime

const apiAnswering = (answers: (CliError | unknown)[]): { api: Api; calls: ApiRequest[] } => {
  const calls: ApiRequest[] = []
  const api: Api = {
    latest: () => undefined,
    request: async (req) => {
      calls.push(req)
      const next = answers[Math.min(calls.length - 1, answers.length - 1)]
      if (next instanceof CliError) throw next
      return { data: next }
    },
  }
  return { api, calls }
}

const target = {
  kind: 'login' as const,
  path: '/public/cli/logins/poll',
  pollSecret: 's',
  resume: 'deepdock auth login --wait abc',
  expiresAt: new Date(Date.now() + 600000).toISOString(),
}
const approved = {
  status: 'approved',
  key: 'k',
  expiresAt: 'x',
  user: { email: 'a@b.example' },
  organisations: [],
}
const unavailable = (): CliError =>
  new CliError({ code: 'temporarily_unavailable', message: 'x', status: 503 })

describe('pollUntilApproved', () => {
  it('keeps polling while pending and returns the approved answer', async () => {
    const { api, calls } = apiAnswering([{ status: 'pending' }, { status: 'pending' }, approved])
    const result = await pollUntilApproved(
      runtime(() => new Date()),
      api,
      'loginPoll',
      target,
    )
    expect(result.answer.user.email).toBe('a@b.example')
    expect(calls).toHaveLength(3)
  })

  it('retries a 503 and a lost connection, then gives up after five in a row', async () => {
    const retried = apiAnswering([
      unavailable(),
      new CliError({ code: 'connection_lost', message: 'x' }),
      approved,
    ])
    await expect(
      pollUntilApproved(
        runtime(() => new Date()),
        retried.api,
        'loginPoll',
        target,
      ),
    ).resolves.toBeDefined()
    const hopeless = apiAnswering([unavailable()])
    await expect(
      pollUntilApproved(
        runtime(() => new Date()),
        hopeless.api,
        'loginPoll',
        target,
      ),
    ).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    })
    expect(hopeless.calls).toHaveLength(6)
  })

  it('does not retry an API refusal', async () => {
    const { api, calls } = apiAnswering([
      new CliError({ code: 'forbidden', message: 'x', status: 403 }),
    ])
    await expect(
      pollUntilApproved(
        runtime(() => new Date()),
        api,
        'loginPoll',
        target,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(calls).toHaveLength(1)
  })

  it('stops with approval_expired once the request is past its expiry', async () => {
    const { api, calls } = apiAnswering([{ status: 'pending' }])
    const late = runtime(() => new Date(Date.now() + 3600000))
    await expect(pollUntilApproved(late, api, 'loginPoll', target)).rejects.toMatchObject({
      code: 'approval_expired',
    })
    expect(calls).toHaveLength(0)
  })

  it('reports an answer in an unknown shape without echoing it', async () => {
    const { api } = apiAnswering([{ status: 'approved', key: 12345 }])
    const error = await pollUntilApproved(
      runtime(() => new Date()),
      api,
      'loginPoll',
      target,
    ).catch((caught: Error) => caught)
    expect(error).toMatchObject({ code: 'internal_error' })
    expect((error as Error).message).not.toContain('12345')
  })
})
