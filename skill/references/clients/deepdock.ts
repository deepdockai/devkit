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
  /** system_version_unverified: the version the system last reported, `null` when it reported none. */
  readonly version?: string | null
  /** system_version_unverified: `unverified_version`, `unparseable` or `unreported`. */
  readonly reason?: string
  /** applied_unverified, outcome_unknown on a system with no rollback: the entry, or `null` when not known. */
  readonly created?: { chartId?: string } | null
  /** outcome_unknown: `true` when the write may or may not have landed. */
  readonly uncertain?: boolean
  /** The `Retry-After` header as sent (seconds), when the answer carried one. */
  retryAfter?: string

  constructor(status: number, code: string, message: string, requestId?: string,
    systems?: string[],
    version?: string | null,
    reason?: string,
    created?: { chartId?: string } | null,
    uncertain?: boolean,
  ) {
    super(message)
    this.name = 'DeepdockError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.systems = systems
    this.version = version
    this.reason = reason
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

type ErrorBody = { code: string; message: string; requestId?: string; systems?: string[]; version?: string | null; reason?: string; created?: { chartId?: string } | null; uncertain?: boolean }
type Envelope<T> = { data: T } | { error: ErrorBody }

export type Page<Item> = { items: Item[]; nextCursor: string | null }
export type WriteResult<T> = { data: T; replayed: boolean }
/** A flat JSON value as the action's schema declares it: a number is a number, never its text. */
export type InputValue = string | number | boolean
/** What a write action does, from `operation` in the action index: a create is POST, an update PATCH. */
export type WriteOperation = 'create' | 'update'
export type ActionInput = Record<string, InputValue>

export type SystemStatus = 'running' | 'stopped' | 'missing' | 'unknown'
/** The database access the device last reported; `null` while none is known. */
export type SystemAccess = 'ok' | 'outdated' | 'missing' | 'password_missing' | 'not_set_up' | null

/**
 * Whether writes on the system run. `unverified` makes writes answer system_version_unverified:
 * `unverified_version` clears once Deepdock verifies the version; `unparseable` does not clear by
 * waiting (contact Deepdock); `unreported` clears once the device reports the system's version (a
 * write verified for one exact release needs it).
 */
export type SystemWrites =
  | { state: 'verified' | 'unknown' | 'partial' }
  | { state: 'unverified'; reason: 'unverified_version' | 'unparseable' | 'unreported' }

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
    status: SystemStatus
    access: SystemAccess
    /** Set when `access` is the last known value (the device could not read it): when it last did. */
    accessLastCheckedAt: string | null
    lockedActions: string[] | null
    reportedAt: string
    writes: SystemWrites
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

  private async send<T>(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ data: T; headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.sendOnce<T>(path, init)
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

  private async sendOnce<T>(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ data: T; headers: Headers }> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (err) {
      // TimeoutError from AbortSignal.timeout, AbortError, or a network TypeError.
      throw new DeepdockTransportError(`no answer from Deepdock: ${(err as Error).name}`)
    }
    let body: Envelope<T>
    try {
      body = (await res.json()) as Envelope<T>
    } catch {
      throw new DeepdockTransportError(`non-JSON answer with status ${res.status}`)
    }
    if (body !== null && typeof body === 'object' && 'error' in body) {
      const { code, message, requestId, systems, version, reason, created, uncertain } = body.error
      const error = new DeepdockError(res.status, code, message, requestId, systems, version, reason, created, uncertain)
      error.retryAfter = res.headers.get('retry-after') ?? undefined
      throw error
    }
    if (body === null || typeof body !== 'object' || !('data' in body)) {
      throw new DeepdockTransportError(`unexpected body with status ${res.status}`)
    }
    return { data: body.data, headers: res.headers }
  }

  private actionPath(deviceId: string, system: string, action: string): string {
    return `/v1/devices/${encodeURIComponent(deviceId)}/systems/${encodeURIComponent(system)}/actions/${encodeURIComponent(action)}`
  }

  /**
   * Runs a read action: a POST whose JSON body holds the inputs and the paging fields, no
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
    return (
      await this.send<Page<Item>>(this.actionPath(deviceId, system, action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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

  /** Claims a device by the pairing code it shows. Keep the returned `id`. */
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
 * For system_version_unverified and device_outdated, poll the device's `writes` / `outdated` before
 * retrying: they take longer than minutes.
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
  'system_version_unverified',
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
