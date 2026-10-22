import type { Api } from '../api/client.ts'
import { CliError } from '../api/errors.ts'
import { type Answer, parseAnswer } from '../api/schemas.ts'
import type { Runtime } from '../runtime.ts'

export type PollTarget = {
  kind: 'login' | 'key'
  path: string
  pollSecret: string
  expiresAt: string
  /** The command that resumes this request, shown when a wait is cut short. */
  resume: string
  secret?: string
  org?: string
}

type Approved<K extends 'loginPoll' | 'keyPoll'> = Extract<Answer<K>, { status: 'approved' }>

const MAX_CONSECUTIVE_FAILURES = 5
// The request expires on the server's clock; wait a little past it so the server has the last word.
const EXPIRY_GRACE_MS = 15000

const RETRYABLE = new Set(['temporarily_unavailable', 'connection_lost', 'rate_limited'])
const MAX_BACKOFF_MS = 30000

const retryable = (error: unknown): boolean =>
  error instanceof CliError && RETRYABLE.has(error.code)

// A 429 names how long to wait (Retry-After); without it, double the poll interval each time.
const backoffMs = (rt: Runtime, error: unknown, failures: number): number => {
  if (error instanceof CliError && error.code === 'rate_limited') {
    return Math.min(error.retryAfterMs ?? rt.pollIntervalMs * 2 ** failures, MAX_BACKOFF_MS)
  }
  return rt.pollIntervalMs
}

const interrupted = (target: PollTarget, mayHaveKey: boolean): CliError =>
  new CliError({
    code: 'connection_lost',
    message: 'Interrupted while waiting for approval.',
    hint: `The request is still pending; \`${target.resume}\` resumes it.${
      mayHaveKey ? ' A key may already have been created: `deepdock keys list` shows it.' : ''
    }`,
  })

const refusal = (kind: 'login' | 'key', status: 'denied' | 'expired'): CliError => {
  const what = kind === 'login' ? 'The sign-in' : 'The key request'
  const again = kind === 'login' ? '`deepdock auth login`' : '`deepdock keys create`'
  if (status === 'denied') {
    return new CliError({
      code: 'approval_denied',
      message: `${what} was denied in the browser.`,
      hint: `Run ${again} again if that was a mistake.`,
    })
  }
  return new CliError({
    code: 'approval_expired',
    message: `${what} expired before it was approved.`,
    hint: `Run ${again} again.`,
  })
}

/** Expiry is checked before any request, so `--wait` on an old request never calls the API. */
export const assertNotExpired = (rt: Runtime, kind: 'login' | 'key', expiresAt: string): void => {
  if (rt.now().getTime() > Date.parse(expiresAt)) throw refusal(kind, 'expired')
}

export const pollUntilApproved = async <K extends 'loginPoll' | 'keyPoll'>(
  rt: Runtime,
  api: Api,
  schema: K,
  target: PollTarget,
): Promise<{ answer: Approved<K>; requestId?: string }> => {
  let failures = 0
  for (;;) {
    if (rt.signal.aborted) throw interrupted(target, false)
    if (rt.now().getTime() > Date.parse(target.expiresAt) + EXPIRY_GRACE_MS) {
      throw refusal(target.kind, 'expired')
    }
    let answer: Answer<K>
    let requestId: string | undefined
    try {
      const response = await api.request({
        method: 'POST',
        path: target.path,
        body: { pollSecret: target.pollSecret },
        secret: target.secret,
        org: target.org,
      })
      requestId = response.requestId
      answer = (await parseAnswer(schema, response.data)) as Answer<K>
    } catch (error) {
      // The request was cut off mid-flight: the approval may have been collected.
      if (rt.signal.aborted) throw interrupted(target, target.kind === 'key')
      failures += 1
      if (retryable(error) && failures <= MAX_CONSECUTIVE_FAILURES) {
        await rt.sleep(backoffMs(rt, error, failures))
        continue
      }
      if (target.kind === 'key' && error instanceof CliError && error.code === 'connection_lost') {
        throw new CliError({
          code: 'connection_lost',
          message: 'The connection was lost while waiting for the key; a key may exist.',
          hint: `Run \`deepdock keys list\` to check, then \`${target.resume}\` to resume.`,
        })
      }
      throw error
    }
    failures = 0
    if (answer.status === 'approved') return { answer: answer as Approved<K>, requestId }
    if (answer.status === 'denied' || answer.status === 'expired') {
      throw refusal(target.kind, answer.status)
    }
    await rt.sleep(rt.pollIntervalMs)
  }
}
