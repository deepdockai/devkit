import type { Runtime } from '../runtime.ts'
import { DEFAULT_BASE_URL } from '../runtime.ts'
import { CliError, signInNeeded, usageError } from './errors.ts'

export type ApiRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  /** The sign-in secret, sent as Bearer. Omitted for the two unauthenticated login routes. */
  secret?: string
  /** Organisation slug for org-scoped routes. */
  org?: string
}

export type ApiResponse = {
  data: unknown
  requestId?: string
}

export type Api = {
  request: (req: ApiRequest) => Promise<ApiResponse>
  /** The newest CLI version the API announced on any answer so far. */
  latest: () => string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The API origin: https, or plain http only for a loopback host (tests, local development). */
export const baseUrlFor = (rt: Pick<Runtime, 'env'>): string => {
  const configured = rt.env.DEEPDOCK_BASE_URL || DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(configured)
  } catch {
    throw usageError('DEEPDOCK_BASE_URL is not a URL.', 'Unset it to use the production API.')
  }
  const secure = parsed.protocol === 'https:'
  if (!secure && !(parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname))) {
    throw usageError(
      'DEEPDOCK_BASE_URL must be an https URL (http is allowed only for localhost).',
      'Unset DEEPDOCK_BASE_URL to use the production API.',
    )
  }
  return configured.replace(/\/+$/, '')
}

const toError = (
  status: number,
  json: unknown,
  headerRequestId: string | undefined,
  retryAfter: string | null,
): CliError => {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN
  const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
  const raw = isRecord(json) && isRecord(json.error) ? json.error : undefined
  const code = raw && typeof raw.code === 'string' ? raw.code : undefined
  const message = raw && typeof raw.message === 'string' ? raw.message : undefined
  const bodyRequestId = raw && typeof raw.requestId === 'string' ? raw.requestId : undefined
  if (code) {
    return new CliError({
      code,
      message: message ?? `The API answered ${status} (${code}).`,
      raw,
      requestId: bodyRequestId ?? headerRequestId,
      status,
      retryAfterMs,
    })
  }
  return new CliError({
    code:
      status === 503
        ? 'temporarily_unavailable'
        : status >= 500
          ? 'internal_error'
          : 'invalid_request',
    message: `The API answered HTTP ${status} without an error code.`,
    requestId: headerRequestId,
    status,
  })
}

export const createApi = (rt: Runtime): Api => {
  const baseUrl = baseUrlFor(rt)
  let latest: string | undefined

  const request = async (req: ApiRequest): Promise<ApiResponse> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-deepdock-cli': rt.version,
    }
    if (req.secret) headers.authorization = `Bearer ${req.secret}`
    if (req.org) headers['x-deepdock-org'] = req.org
    if (req.body !== undefined) headers['content-type'] = 'application/json'

    let response: Response
    let text: string
    try {
      response = await rt.fetch(`${baseUrl}${req.path}`, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.any([AbortSignal.timeout(rt.requestTimeoutMs), rt.signal]),
      })
      text = await response.text()
    } catch {
      throw new CliError({
        code: 'connection_lost',
        message: 'The request did not complete (network error or timeout).',
        hint: 'Retry later.',
      })
    }

    const announced = response.headers.get('x-deepdock-cli-latest')
    if (announced) latest = announced
    const headerRequestId = response.headers.get('x-request-id') ?? undefined
    const json = parseJson(text)

    if (response.status === 401) throw signInNeeded()
    if (!response.ok)
      throw toError(response.status, json, headerRequestId, response.headers.get('retry-after'))
    if (!isRecord(json) || !('data' in json)) {
      throw new CliError({
        code: 'internal_error',
        message: `The API answered HTTP ${response.status} without a data field.`,
        requestId: headerRequestId,
        status: response.status,
      })
    }
    return { data: json.data, requestId: headerRequestId }
  }

  return { request, latest: () => latest }
}
