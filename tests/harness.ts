import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { runCli } from '../src/program.ts'
import type { Runtime } from '../src/runtime.ts'

export type Sandbox = {
  home: string
  work: string
  configFile: string
  cleanup: () => void
}

/** What a child program needs on Windows to start at all (git, node); empty elsewhere. */
export const systemEnv = (): Record<string, string> =>
  Object.fromEntries(
    ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec']
      .map((key): [string, string | undefined] => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )

export const makeSandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), 'deepdock-test-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  mkdirSync(home, { recursive: true })
  mkdirSync(work, { recursive: true })
  return {
    home,
    work,
    configFile:
      process.platform === 'win32'
        ? join(home, 'AppData', 'Roaming', 'deepdock', 'config.json')
        : join(home, '.config', 'deepdock', 'config.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export const initRepo = (dir: string, gitignore?: string): void => {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore)
}

export type RunOptions = {
  baseUrl?: string
  env?: Record<string, string>
  tty?: boolean
  stdin?: string
  cwd?: string
  version?: string
  now?: () => Date
  hostname?: string
  pollIntervalMs?: number
  colour?: boolean
  /** Pretends to run on this platform, for logic that branches on it (paths, warnings). */
  platform?: NodeJS.Platform
  /** Called each time the program would sleep between polls. */
  onSleep?: (ms: number) => void | Promise<void>
  /** Replaces fetch, e.g. to drop a connection. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  /** Aborts the interrupt signal at the first sleep. */
  interruptAtSleep?: boolean
}

export type Outcome = { code: number; stdout: string; stderr: string; opened: string[] }

/** Runs the real program in-process against a sandbox; `tty` makes both streams terminals. */
export const execute = async (
  sandbox: Sandbox,
  argv: string[],
  options: RunOptions = {},
): Promise<Outcome> => {
  const interrupt = new AbortController()
  const opened: string[] = []
  let stdout = ''
  let stderr = ''
  const tty = options.tty === true
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    ...systemEnv(),
    APPDATA: join(sandbox.home, 'AppData', 'Roaming'),
    ...(options.colour ? {} : { NO_COLOR: '1' }),
    ...(options.baseUrl ? { DEEPDOCK_BASE_URL: options.baseUrl } : {}),
    ...options.env,
  }
  const rt: Runtime = {
    version: options.version ?? '0.1.0',
    env,
    platform: options.platform ?? process.platform,
    cwd: options.cwd ?? sandbox.work,
    homedir: sandbox.home,
    hostname: options.hostname ?? 'test-host',
    stdout: {
      write: (text) => {
        stdout += text
      },
      isTTY: tty,
    },
    stderr: {
      write: (text) => {
        stderr += text
      },
      isTTY: tty,
    },
    stdin: {
      isTTY: tty,
      stream: Readable.from(options.stdin === undefined ? [] : [options.stdin]),
    },
    now: options.now ?? (() => new Date()),
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    sleep: async (ms: number) => {
      await options.onSleep?.(ms)
      if (options.interruptAtSleep) interrupt.abort()
    },
    pollIntervalMs: options.pollIntervalMs ?? 0,
    requestTimeoutMs: 5000,
    openBrowser: (url) => {
      opened.push(url)
    },
    signal: interrupt.signal,
  }
  const code = await runCli(argv, rt)
  return { code, stdout, stderr, opened }
}

export const readConfigText = (sandbox: Sandbox): string => {
  try {
    return readFileSync(sandbox.configFile, 'utf8')
  } catch {
    return ''
  }
}

export const signInWith = async (
  sandbox: Sandbox,
  baseUrl: string,
  extra: RunOptions = {},
): Promise<Outcome> =>
  execute(sandbox, ['auth', 'login', '--json'], { baseUrl, ...extra, tty: false }).then(
    async (started) => {
      if (started.code !== 0) return started
      return execute(
        sandbox,
        ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6', '--json'],
        { baseUrl, ...extra, tty: false },
      )
    },
  )

export type ErrorShape = {
  error: { code: string; message: string; [key: string]: unknown }
  meta: {
    hint?: string
    organisations?: string[]
    org?: { slug: string; name: string }
    [key: string]: unknown
  }
}

/** The error document is the last JSON line on stderr; plain context lines may precede it. */
export const errorDocOf = (stderr: string): ErrorShape => {
  const line = stderr
    .trim()
    .split('\n')
    .reverse()
    .find((entry) => entry.startsWith('{'))
  return JSON.parse(line ?? '{}') as ErrorShape
}
