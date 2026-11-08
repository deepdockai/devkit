/**
 * Minimal Deepdock /v1 client. No dependencies beyond fetch (Node 18+, Bun, Deno, browsers).
 *
 * It does the four things the OpenAPI document cannot tell you: the bearer header, the envelope
 * unwrap, the Idempotency-Key header with replay detection, and a typed error carrying the code.
 * Everything action-specific (fields, types, patterns) comes from the live OpenAPI document.
 */

// Plain fields, no constructor parameter properties: Node runs this file with its default type
// stripping, which refuses syntax that needs a transform.
export class DeepdockError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly systems?: string[]
  /** applied_unverified, outcome_unknown on a system with no rollback: the entry, or `null` when not known. */
  readonly created?: { chartId?: string } | null
  /** outcome_unknown: `true` when the write may or may not have landed. */
  readonly uncertain?: boolean
  /** The `Retry-After` header as sent (seconds), when the answer carried one. */
  retryAfter?: string

  constructor(status: number, code: string, message: string, requestId?: string,
    systems?: string[],
    created?: { chartId?: string } | null,
    uncertain?: boolean,
  ) {
    super(message)
    this.name = 'DeepdockError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.systems = systems
    this.created = created
    this.uncertain = uncertain
  }
}

/** No answer, or not Deepdock's envelope (timeout, network, a proxy page): a write may still have landed. */
export class DeepdockTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepdockTransportError'
  }
}

type ErrorBody = { code: string; message: string; requestId?: string; systems?: string[]; created?: { chartId?: string } | null; uncertain?: boolean }
type Envelope<T> = { data: T; nextCursor?: string | null } | { error: ErrorBody }

/** One page of a `many` read: `items` is the answer's `data` array, `nextCursor` its top-level sibling. */
export type Page<Item> = { items: Item[]; nextCursor: string | null }
export type WriteResult<T> = { data: T; replayed: boolean }
/** A flat JSON value as the action's schema declares it: a number is a number, never its text. */
export type InputValue = string | number | boolean
/** What a write action does, from `operation` in the action index: a create is POST, an update PATCH. */
export type WriteOperation = 'create' | 'update'
export type ActionInput = Record<string, InputValue>

/** `missing`: never found on the PC; `vanished`: found once and not any more. */
export type SystemStatus = 'running' | 'stopped' | 'missing' | 'unknown' | 'vanished'
/** The database access the device last reported; `null` while none is known. */
export type SystemAccess = 'ok' | 'outdated' | 'missing' | 'password_missing' | 'not_set_up' | null

/** Why a system's `version` is missing, when the device says. */
export type VersionIssue = 'not_installed' | 'not_found' | 'unreadable'

export type Device = {
  id: string
  label: string | null
  hostname: string | null
  os: string | null
  clientVersion: string | null
  status: 'connected' | 'offline' | 'inactive'
  lastSeenAt: string | null
  /** While the device is not connected: when it last reported. `null` while connected. */
  lastKnownAt: string | null
  claimedAt: string | null
  /** True when an action assigned to you needs a newer client: that action answers device_outdated. */
  outdated: boolean
  updateAvailable?: string
  systems: {
    system: string
    version: string | null
    versionIssue: VersionIssue | null
    status: SystemStatus
    access: SystemAccess
    /** Set when `access` is the last known value (the device could not read it): when it last did. */
    accessLastCheckedAt: string | null
    lockedActions: string[] | null
    reportedAt: string
    /** Actions the installed version is not yet approved for: they answer version_not_covered. Absent when none. */
    blockedActions?: string[]
  }[]
}

export type PairBody = { code: string; label?: string }

export type ActionState =
  | { action: string; state: 'active' }
  | {
      action: string
      state: 'paused'
      reason: 'structure_changed' | 'readback_failed' | 'credentials_rejected' | 'certificate_changed'
      pausedAt: string
    }

export type DeviceSystem = {
  system: string
  label: string | null
  version?: string
  versionIssue?: VersionIssue
  status: SystemStatus
  access: SystemAccess
  /** Set when `access` is the last known value (the device could not read it): when it last did. */
  accessLastCheckedAt: string | null
  /** Actions the device reports locked because its database account lacks a right they need; `null` when there is no verdict for the spec set it runs now. */
  lockedActions: string[] | null
  actions: ActionState[]
  /** The connectors the device runs for this system, by name and kind. */
  connectors: { name: string; kind: 'database' | 'http' }[]
}

export type DeepdockOptions = {
  /** Default: `DEEPDOCK_BASE_URL` from the environment (the CLI's own variable), else production. */
  base?: string
  /** Per attempt, default 35 s: above the worst answer (up to 10 s for the device's slot, then up to 20 s on the device), so you receive the code instead of timing out first. */
  timeoutMs?: number
  /** Attempts per call on `503 target_busy`, default 3; 1 turns the retry off. The same request is sent again, so a write keeps its idempotency key. */
  maxAttempts?: number
  fetch?: typeof fetch
  /** Waits between attempts; replace it in tests. */
  sleep?: (ms: number) => Promise<void>
}

type SendInit = { method: string; headers?: Record<string, string>; body?: string }

/** A file action's answer: the bytes, the type the action declares, and the name to save it under. */
export type Download = { bytes: Uint8Array; contentType: string; filename: string | null }

const unwrap = async <T>(res: Response): Promise<{ data: T; nextCursor: string | null }> => {
  let body: Envelope<T>
  try {
    body = (await res.json()) as Envelope<T>
  } catch {
    throw new DeepdockTransportError(`non-JSON answer with status ${res.status}`)
  }
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const { code, message, requestId, systems, created, uncertain } = body.error
    const error = new DeepdockError(res.status, code, message, requestId, systems, created, uncertain)
    error.retryAfter = res.headers.get('retry-after') ?? undefined
    throw error
  }
  if (body === null || typeof body !== 'object' || !('data' in body)) {
    throw new DeepdockTransportError(`unexpected body with status ${res.status}`)
  }
  return { data: body.data, nextCursor: body.nextCursor ?? null }
}

// Deepdock sends `filename*` (UTF-8) beside an ASCII `filename`; the name is already safe to save
// on Windows, and can carry personal data (a patient's name in a document title).
const filenameOf = (disposition: string | null): string | null => {
  if (disposition === null) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended.trim())
    } catch {
      // A malformed escape: fall back to the ASCII name.
    }
  }
  return /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null
}

/** Longest wait between two attempts, whatever `Retry-After` asks for. */
const MAX_RETRY_WAIT_MS = 15_000
const DEFAULT_RETRY_WAIT_MS = 1_000

const retryWaitMs = (header: string | null): number => {
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, MAX_RETRY_WAIT_MS)
    : DEFAULT_RETRY_WAIT_MS
}

// `process` is absent in a browser, and Deno throws on `process.env` without --allow-env; then the
// base comes from the options or is production.
const envBase = (): string | undefined => {
  try {
    return process.env.DEEPDOCK_BASE_URL || undefined
  } catch {
    return undefined
  }
}

export class Deepdock {
  private readonly apiKey: string
  private readonly base: string
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  constructor(
    apiKey: string,
    {
      base = envBase() ?? 'https://api.deepdock.ai',
      timeoutMs = 35_000,
      maxAttempts = 3,
      fetch: fetchImpl = fetch,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }: DeepdockOptions = {},
  ) {
    this.apiKey = apiKey
    this.base = base.replace(/\/$/, '')
    this.timeoutMs = timeoutMs
    this.maxAttempts = Math.max(1, Math.floor(maxAttempts))
    this.fetchImpl = fetchImpl
    this.sleep = sleep
  }

  private async retrying<R>(once: () => Promise<R>): Promise<R> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once()
      } catch (err) {
        if (
          attempt >= this.maxAttempts ||
          !(err instanceof DeepdockError) ||
          err.status !== 503 ||
          err.code !== 'target_busy'
        ) {
          throw err
        }
        await this.sleep(retryWaitMs(err.retryAfter ?? null))
      }
    }
  }

  private async fetchOnce(path: string, init: SendInit, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
        body: init.body,
        signal,
      })
    } catch (err) {
      // TimeoutError from AbortSignal.timeout, AbortError, or a network TypeError.
      throw new DeepdockTransportError(`no answer from Deepdock: ${(err as Error).name}`)
    }
  }

  private send<T>(path: string, init: SendInit): Promise<{ data: T; headers: Headers; nextCursor: string | null }> {
    return this.retrying(async () => {
      const res = await this.fetchOnce(path, init, AbortSignal.timeout(this.timeoutMs))
      return { ...(await unwrap<T>(res)), headers: res.headers }
    })
  }

  private async downloadOnce(path: string, init: SendInit): Promise<Download> {
    // The timeout bounds the wait for the answer and then each gap between two chunks, not the
    // whole transfer: a large file streams for longer than one attempt's timeout.
    const deadline = new AbortController()
    let timer = setTimeout(() => deadline.abort(), this.timeoutMs)
    const chunks: Uint8Array[] = []
    let size = 0
    let res: Response
    try {
      res = await this.fetchOnce(path, init, deadline.signal)
      if (!res.ok) {
        await unwrap<unknown>(res)
        throw new DeepdockTransportError(`unexpected body with status ${res.status}`)
      }
      const reader = res.body?.getReader()
      try {
        while (reader) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          size += value.byteLength
          clearTimeout(timer)
          timer = setTimeout(() => deadline.abort(), this.timeoutMs)
        }
      } catch (err) {
        throw new DeepdockTransportError(`download cut off: ${(err as Error).name}`)
      }
    } finally {
      clearTimeout(timer)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    // Once the bytes flow, a failure can only end the body early. Content-Length counts encoded
    // bytes, so it is compared only on a body sent as is.
    const declared = res.headers.get('content-length')
    const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity'
    if (declared !== null && !encoded && Number(declared) !== bytes.byteLength) {
      throw new DeepdockTransportError(`download ended at ${bytes.byteLength} of ${declared} bytes`)
    }
    return {
      bytes,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      filename: filenameOf(res.headers.get('content-disposition')),
    }
  }

  private actionPath(deviceId: string, system: string, action: string): string {
    return `/v1/devices/${encodeURIComponent(deviceId)}/systems/${encodeURIComponent(system)}/actions/${encodeURIComponent(action)}`
  }

  /**
   * Runs a read action with `cardinality: many`: a POST whose JSON body holds the inputs and the paging fields, no
   * Idempotency-Key. Pass `nextCursor` back as `cursor` for the next page.
   */
  async read<Item>(
    deviceId: string,
    system: string,
    action: string,
    input: ActionInput,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Item>> {
    const body: ActionInput = { ...input }
    if (page.limit !== undefined) body.limit = page.limit
    if (page.cursor !== undefined) body.cursor = page.cursor
    const { data, nextCursor } = await this.send<Item[]>(this.actionPath(deviceId, system, action), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { items: data, nextCursor }
  }

  /**
   * Runs a single-record read (`cardinality: one`): the answer's `data` is the record itself. A
   * record that does not exist throws a DeepdockError with status 404 and code `not_found`.
   */
  async readOne<Row>(deviceId: string, system: string, action: string, input: ActionInput): Promise<Row> {
    return (
      await this.send<Row>(this.actionPath(deviceId, system, action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
    ).data
  }

  /** Reads every page of a read action, in order. */
  async *readAll<Item>(
    deviceId: string,
    system: string,
    action: string,
    input: ActionInput,
    limit?: number,
  ): AsyncGenerator<Item> {
    let cursor: string | undefined
    do {
      const page = await this.read<Item>(deviceId, system, action, input, { limit, cursor })
      for (const item of page.items) yield item
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
  }

  /**
   * Runs a file action (`file: true` in the action index): a POST like a read, answered with the
   * file's bytes instead of JSON. A refusal is a DeepdockError as for any action; a body that ends
   * short of its Content-Length is a DeepdockTransportError, and the download can be run again.
   */
  download(deviceId: string, system: string, action: string, input: ActionInput): Promise<Download> {
    return this.retrying(() =>
      this.downloadOnce(this.actionPath(deviceId, system, action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    )
  }

  /**
   * Runs a write action: POST for a `create`, PATCH for an `update`. Take `operation` from the
   * action index; any other method answers 405 with `Allow` naming the right one. `input` values
   * are typed as the action's schema declares. `idempotencyKey` is new per intended write and the
   * same on every retry.
   */
  async write<Result>(
    deviceId: string,
    system: string,
    action: string,
    operation: WriteOperation,
    idempotencyKey: string,
    input: ActionInput,
  ): Promise<WriteResult<Result>> {
    const { data, headers } = await this.send<Result>(this.actionPath(deviceId, system, action), {
      method: operation === 'update' ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    })
    return { data, replayed: headers.get('Idempotent-Replayed') === 'true' }
  }

  /** The device's systems and each action's state. A live call to the device: can answer device_offline. */
  async systems(deviceId: string): Promise<DeviceSystem[]> {
    return (await this.send<DeviceSystem[]>(`/v1/devices/${encodeURIComponent(deviceId)}/systems`, { method: 'GET' })).data
  }

  /** Pairs a device by the pairing code it shows. Keep the returned `id`. */
  async pair(code: string, label?: string): Promise<Device> {
    const body: PairBody = label === undefined ? { code } : { code, label }
    return (
      await this.send<Device>('/v1/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).data
  }

  async release(deviceId: string): Promise<void> {
    await this.send<unknown>(`/v1/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pending writes: one attempt against persisted state. Persist the row BEFORE the first send, so a
 * crash between send and answer cannot produce a second record under a new key. A job retries rows
 * left in `sent` with backoff (seconds, then minutes, for hours if the device stays offline).
 * For device_outdated, poll the device's `outdated` before retrying: it takes longer than minutes.
 * version_not_covered is not retried: Deepdock has to approve the installed version first.
 * ---------------------------------------------------------------------------------------------- */

export type PendingStatus = 'pending' | 'sent' | 'done' | 'unknown' | 'refused'

export type PendingWrite = {
  /** 8 to 128 chars of A-Z a-z 0-9 _ -, stable per business event. */
  key: string
  deviceId: string
  system: string
  action: string
  operation: WriteOperation
  input: ActionInput
  status: PendingStatus
  conflictRetries: number
  result?: unknown
  requestId?: string
  refusedCode?: string
}

/** A running write finishes within seconds; beyond this, treat a conflict as an unknown outcome. */
export const CONFLICT_RETRIES = 5

const RETRY_SAME_KEY = new Set([
  'device_offline',
  'device_syncing',
  'device_outdated',
  'target_busy',
  'temporarily_unavailable',
  'internal_error',
  'action_paused',
  'system_unavailable',
])

/** One attempt; returns the row with its new status. The caller persists it. */
export const attempt = async (dd: Deepdock, row: PendingWrite): Promise<PendingWrite> => {
  try {
    const { data } = await dd.write(row.deviceId, row.system, row.action, row.operation, row.key, row.input)
    return { ...row, status: 'done', result: data }
  } catch (err) {
    if (err instanceof DeepdockTransportError) return { ...row, status: 'sent' }
    if (!(err instanceof DeepdockError)) throw err
    if (RETRY_SAME_KEY.has(err.code)) return { ...row, status: 'sent', requestId: err.requestId }
    if (err.code === 'idempotency_conflict') {
      return row.conflictRetries < CONFLICT_RETRIES
        ? { ...row, status: 'sent', conflictRetries: row.conflictRetries + 1 }
        : { ...row, status: 'unknown' }
    }
    // applied_unverified: the entry exists but was not verified; never write it again under a new
    // key. `result.created` names it for the check.
    if (err.code === 'outcome_unknown' || err.code === 'applied_unverified')
      return {
        ...row,
        status: 'unknown',
        requestId: err.requestId,
        result: { created: err.created, uncertain: err.uncertain },
      }
    // invalid_input, target_rejected, action-specific 422s, not_found, readback_failed, auth and
    // resolution codes: nothing was written. Fix the cause; a changed input gets a new key.
    return { ...row, status: 'refused', refusedCode: err.code, result: { message: err.message } }
  }
}
