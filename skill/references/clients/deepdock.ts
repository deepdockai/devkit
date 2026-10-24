/**
 * Minimal Deepdock /v1 client. No dependencies beyond fetch (Node 18+, Bun, Deno, browsers).
 *
 * It does the four things the OpenAPI document cannot tell you: the bearer header, the envelope
 * unwrap, the Idempotency-Key header with replay detection, and a typed error carrying the code.
 * Everything action-specific (paths, fields, methods) comes from the live OpenAPI document.
 */

// Plain fields, no constructor parameter properties: Node runs this file with its default type
// stripping, which refuses syntax that needs a transform.
export class DeepdockError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string
  readonly systems?: string[]

  constructor(status: number, code: string, message: string, requestId?: string, systems?: string[]) {
    super(message)
    this.name = 'DeepdockError'
    this.status = status
    this.code = code
    this.requestId = requestId
    this.systems = systems
  }
}

/** No answer, or not Deepdock's envelope (timeout, network, a proxy page): a write may still have landed. */
export class DeepdockTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeepdockTransportError'
  }
}

type ErrorBody = { code: string; message: string; requestId?: string; systems?: string[] }
type Envelope<T> = { data: T } | { error: ErrorBody }

export type Page<Item> = { items: Item[]; nextCursor: string | null }
export type WriteResult<T> = { data: T; replayed: boolean }
export type WriteMethod = 'POST' | 'PATCH'

export type SystemStatus = 'running' | 'stopped' | 'missing' | 'unknown'
/** The database access the device last reported; `null` while none is known. */
export type SystemAccess = 'ok' | 'outdated' | 'missing' | 'not_set_up' | null

export type Device = {
  id: string
  label: string | null
  hostname: string
  os: string
  clientVersion: string
  status: 'connected' | 'offline' | 'inactive'
  lastSeenAt: string | null
  claimedAt: string | null
  /** True when an action assigned to you needs a newer client: that action answers device_outdated. */
  outdated: boolean
  updateAvailable?: string
  systems: { system: string; version: string | null; status: SystemStatus; access: SystemAccess; reportedAt: string }[]
}

export type ActionState =
  | { action: string; state: 'active' }
  | { action: string; state: 'paused'; reason: 'structure_changed' | 'check_failed'; pausedAt: string }

export type DeviceSystem = {
  system: string
  label: string | null
  version?: string
  status: SystemStatus
  access: SystemAccess
  actions: ActionState[]
}

export type DeepdockOptions = {
  /** Default: `DEEPDOCK_BASE_URL` from the environment (the CLI's own variable), else production. */
  base?: string
  /** Above Deepdock's 20 s device wait, so you receive device_offline instead of timing out first. */
  timeoutMs?: number
  fetch?: typeof fetch
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
  private readonly fetchImpl: typeof fetch

  constructor(
    apiKey: string,
    { base = envBase() ?? 'https://api.deepdock.ai', timeoutMs = 30_000, fetch: fetchImpl = fetch }: DeepdockOptions = {},
  ) {
    this.apiKey = apiKey
    this.base = base.replace(/\/$/, '')
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetchImpl
  }

  private async send<T>(
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
      const { code, message, requestId, systems } = body.error
      throw new DeepdockError(res.status, code, message, requestId, systems)
    }
    if (body === null || typeof body !== 'object' || !('data' in body)) {
      throw new DeepdockTransportError(`unexpected body with status ${res.status}`)
    }
    return { data: body.data, headers: res.headers }
  }

  private actionPath(deviceId: string, system: string, action: string): string {
    return `/v1/devices/${encodeURIComponent(deviceId)}/systems/${encodeURIComponent(system)}/actions/${encodeURIComponent(action)}`
  }

  /** Runs a read action. Pass `nextCursor` back as `cursor` for the next page. */
  async read<Item>(
    deviceId: string,
    system: string,
    action: string,
    input: Record<string, string>,
    page: { limit?: number; cursor?: string } = {},
  ): Promise<Page<Item>> {
    const query = new URLSearchParams(input)
    if (page.limit !== undefined) query.set('limit', String(page.limit))
    if (page.cursor !== undefined) query.set('cursor', page.cursor)
    const suffix = query.size > 0 ? `?${query}` : ''
    return (await this.send<Page<Item>>(`${this.actionPath(deviceId, system, action)}${suffix}`, { method: 'GET' })).data
  }

  /** Reads every page of a read action, in order. */
  async *readAll<Item>(
    deviceId: string,
    system: string,
    action: string,
    input: Record<string, string>,
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
   * Runs a write action. `method` comes from the action index or the OpenAPI document; `input`
   * values are all strings. `idempotencyKey` is new per intended write and the same on every retry.
   */
  async write<Result>(
    deviceId: string,
    system: string,
    action: string,
    method: WriteMethod,
    idempotencyKey: string,
    input: Record<string, string>,
  ): Promise<WriteResult<Result>> {
    const { data, headers } = await this.send<Result>(this.actionPath(deviceId, system, action), {
      method,
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
    return (
      await this.send<Device>('/v1/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(label === undefined ? { code } : { code, label }),
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
 * ---------------------------------------------------------------------------------------------- */

export type PendingStatus = 'pending' | 'sent' | 'done' | 'unknown' | 'refused'

export type PendingWrite = {
  /** 8 to 128 chars of A-Z a-z 0-9 _ -, stable per business event. */
  key: string
  deviceId: string
  system: string
  action: string
  method: WriteMethod
  input: Record<string, string>
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
  'target_busy',
  'temporarily_unavailable',
  'internal_error',
  'action_paused',
  'system_unavailable',
])

/** One attempt; returns the row with its new status. The caller persists it. */
export const attempt = async (dd: Deepdock, row: PendingWrite): Promise<PendingWrite> => {
  try {
    const { data } = await dd.write(row.deviceId, row.system, row.action, row.method, row.key, row.input)
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
    if (err.code === 'outcome_unknown') return { ...row, status: 'unknown', requestId: err.requestId }
    // invalid_input, target_rejected, action-specific 422s, not_found, check_failed, auth and
    // resolution codes: nothing was written. Fix the cause; a changed input gets a new key.
    return { ...row, status: 'refused', refusedCode: err.code, result: { message: err.message } }
  }
}
