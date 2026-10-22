import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { CliError, usageError } from '../api/errors.ts'
import { renameWithRetry } from '../atomicRename.ts'
import type { Runtime } from '../runtime.ts'

export type SignIn = {
  /** The sign-in's own id, absent in a store written before the API returned it. */
  id?: string
  secret: string
  /** The API origin the sign-in was made against; it is never sent anywhere else. */
  baseUrl?: string
  email: string
  firstName?: string
  expiresAt: string
  createdAt: string
  hostname: string
  environment?: string
}

export type OrgInfo = { slug: string | null; name: string; role: string }

/** An API key this CLI created: its id and where it went, never its value. */
export type KeyEntry = {
  org: string
  id: string
  name: string
  prefix: string
  expiresAt: string
  file: string
  variable: string
}

export type PendingRequest = {
  kind: 'login' | 'key'
  baseUrl?: string
  request: string
  pollSecret: string
  expiresAt: string
  org?: string
  name?: string
  keyExpiresAt?: string
  file?: string
  variable?: string
}

export type Config = {
  signIn?: SignIn
  defaultOrg?: string
  organisations?: OrgInfo[]
  keys: KeyEntry[]
  pending: PendingRequest[]
  lastNoticeOn?: string
}

// A request is kept this long past its expiry so `--wait` can still say it expired.
const PENDING_KEPT_MS = 60 * 60 * 1000

export const emptyConfig = (): Config => ({ keys: [], pending: [] })

export const configPath = (rt: Runtime): string => {
  if (rt.platform === 'win32') {
    const base = rt.env.APPDATA ?? join(rt.homedir, 'AppData', 'Roaming')
    return join(base, 'deepdock', 'config.json')
  }
  const xdg = rt.env.XDG_CONFIG_HOME
  if (xdg && !isAbsolute(xdg)) {
    throw usageError('XDG_CONFIG_HOME must be an absolute path.', 'Unset it or give a full path.')
  }
  const base = xdg || join(rt.homedir, '.config')
  return join(base, 'deepdock', 'config.json')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const pickSignIn = (value: unknown): SignIn | undefined => {
  if (!isRecord(value)) return undefined
  const secret = text(value.secret)
  const email = text(value.email)
  const expiresAt = text(value.expiresAt)
  const createdAt = text(value.createdAt)
  const hostname = text(value.hostname)
  if (!secret || !email || !expiresAt || !createdAt || !hostname) return undefined
  return {
    secret,
    email,
    expiresAt,
    createdAt,
    hostname,
    id: text(value.id),
    baseUrl: text(value.baseUrl),
    firstName: text(value.firstName),
    environment: text(value.environment),
  }
}

const pickKey = (value: unknown): KeyEntry | undefined => {
  if (!isRecord(value)) return undefined
  const entry = {
    org: text(value.org),
    id: text(value.id),
    name: text(value.name),
    prefix: text(value.prefix),
    expiresAt: text(value.expiresAt),
    file: text(value.file),
    variable: text(value.variable),
  }
  const { org, id, name, prefix, expiresAt, file, variable } = entry
  if (!org || !id || !name || !prefix || !expiresAt || !file || !variable) return undefined
  return { org, id, name, prefix, expiresAt, file, variable }
}

const pickPending = (value: unknown): PendingRequest | undefined => {
  if (!isRecord(value)) return undefined
  const kind = value.kind === 'login' || value.kind === 'key' ? value.kind : undefined
  const request = text(value.request)
  const pollSecret = text(value.pollSecret)
  const expiresAt = text(value.expiresAt)
  if (!kind || !request || !pollSecret || !expiresAt) return undefined
  return {
    kind,
    baseUrl: text(value.baseUrl),
    request,
    pollSecret,
    expiresAt,
    org: text(value.org),
    name: text(value.name),
    keyExpiresAt: text(value.keyExpiresAt),
    file: text(value.file),
    variable: text(value.variable),
  }
}

const pickOrg = (value: unknown): OrgInfo | undefined => {
  if (!isRecord(value)) return undefined
  const name = text(value.name)
  const role = text(value.role)
  if (!name || !role) return undefined
  return { slug: text(value.slug) ?? null, name, role }
}

const present = <T>(item: T | undefined): item is T => item !== undefined

const normalise = (value: unknown): Config => {
  if (!isRecord(value)) return emptyConfig()
  return {
    signIn: pickSignIn(value.signIn),
    defaultOrg: text(value.defaultOrg),
    organisations: Array.isArray(value.organisations)
      ? value.organisations.map(pickOrg).filter(present)
      : undefined,
    keys: Array.isArray(value.keys) ? value.keys.map(pickKey).filter(present) : [],
    pending: Array.isArray(value.pending) ? value.pending.map(pickPending).filter(present) : [],
    lastNoticeOn: text(value.lastNoticeOn),
  }
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

export const loadConfig = async (rt: Runtime): Promise<Config> => {
  const path = configPath(rt)
  let contents: string
  try {
    if (rt.platform !== 'win32') {
      const stats = await fs.stat(path)
      if ((stats.mode & 0o077) !== 0) {
        throw usageError(
          `The settings file ${path} can be read by other users.`,
          `Run \`chmod 600 ${path}\`, then try again.`,
        )
      }
    }
    contents = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return emptyConfig()
    throw error
  }
  try {
    const config = normalise(JSON.parse(contents))
    config.pending = config.pending.filter(
      (entry) => Date.parse(entry.expiresAt) + PENDING_KEPT_MS > rt.now().getTime(),
    )
    return config
  } catch {
    throw usageError(
      `The settings file ${path} is not valid JSON.`,
      'Delete it and run `deepdock auth login`.',
    )
  }
}

const writeConfig = async (rt: Runtime, config: Config): Promise<void> => {
  const path = configPath(rt)
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`)
    await handle.chmod(0o600)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await fs.rm(temp, { force: true })
    throw error
  }
  await handle.close()
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true })
    if (error instanceof CliError) throw error
    throw new CliError({
      code: 'internal_error',
      message: `Could not write the settings file ${path}.`,
      hint: error instanceof Error ? error.message : undefined,
    })
  }
}

export const deleteConfig = async (rt: Runtime): Promise<void> => {
  await fs.rm(configPath(rt), { force: true })
}

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const withLock = async <T>(rt: Runtime, work: () => Promise<T>): Promise<T> => {
  const lockPath = `${configPath(rt)}.lock`
  await fs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  const token = randomBytes(8).toString('hex')
  const started = Date.now()
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(token)
      await handle.close()
      break
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      try {
        const age = Date.now() - (await fs.stat(lockPath)).mtimeMs
        // A crashed process leaves its lock behind; after 30 s nobody is still inside the section.
        if (age > LOCK_STALE_MS) await fs.rm(lockPath, { force: true })
      } catch {
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new CliError({
          code: 'internal_error',
          message: `The settings file ${configPath(rt)} is locked by another deepdock process.`,
          hint: 'Retry in a moment.',
        })
      }
      await pause(15 + Math.floor(Math.random() * 25))
    }
  }
  try {
    return await work()
  } finally {
    // Remove only our own lock: after a stale steal the file belongs to someone else.
    try {
      if ((await fs.readFile(lockPath, 'utf8')) === token) await fs.rm(lockPath, { force: true })
    } catch {
      // already gone
    }
  }
}

/**
 * Read-modify-write under a lock: re-reads the file inside the lock, applies `change` to what is
 * there now, writes it and returns it. The lock is held only for this section, never across a
 * network call or a wait, so two CLI processes both keep their changes.
 */
export const updateConfig = (rt: Runtime, change: (config: Config) => void): Promise<Config> =>
  withLock(rt, async () => {
    const config = await loadConfig(rt)
    change(config)
    await writeConfig(rt, config)
    return config
  })
