import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'
import type { Readable } from 'node:stream'
import { VERSION } from './version.ts'

export type OutStream = {
  write: (text: string) => void
  isTTY: boolean
}

/** Everything a command touches outside its own arguments; tests replace it. */
export type Runtime = {
  version: string
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  cwd: string
  homedir: string
  hostname: string
  stdout: OutStream
  stderr: OutStream
  stdin: { isTTY: boolean; stream: Readable }
  now: () => Date
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  pollIntervalMs: number
  requestTimeoutMs: number
  /** Resolves true once the opener process started, false when it could not. */
  openBrowser: (url: string) => Promise<boolean>
  /** Aborted by the first Ctrl-C; waits and requests stop at their next check. */
  signal: AbortSignal
}

export const DEFAULT_BASE_URL = 'https://api.deepdock.ai'

export const browserCommand = (
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } => {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  // No shell: the URL is one argv element, so & | ^ and quotes in it mean nothing to Windows.
  if (platform === 'win32')
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

const openInBrowser = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const { command, args } = browserCommand(process.platform, url)
    try {
      const child = spawn(command, args, { stdio: 'ignore', detached: true })
      // The link is always printed; a missing browser opener must never fail the command.
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })

export const defaultRuntime = (): Runtime => {
  const interrupt = new AbortController()
  process.once('SIGINT', () => interrupt.abort())
  return {
    version: VERSION,
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    homedir: homedir(),
    hostname: hostname(),
    stdout: {
      write: (text: string): void => {
        process.stdout.write(text)
      },
      isTTY: process.stdout.isTTY === true,
    },
    stderr: {
      write: (text: string): void => {
        process.stderr.write(text)
      },
      isTTY: process.stderr.isTTY === true,
    },
    stdin: { isTTY: process.stdin.isTTY === true, stream: process.stdin },
    now: (): Date => new Date(),
    fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init),
    sleep: (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        interrupt.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      }),
    pollIntervalMs: 2000,
    requestTimeoutMs: 45000,
    openBrowser: openInBrowser,
    signal: interrupt.signal,
  }
}
