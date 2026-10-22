import type { Config } from '../config/store.ts'
import type { Runtime } from '../runtime.ts'
import type { Styler } from './styles.ts'
import { isInteractive } from './terminal.ts'

const parts = (version: string): number[] =>
  (version.split('-')[0] ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0)

/** True when `candidate` is a higher x.y.z than `current`. */
export const isNewer = (candidate: string, current: string): boolean => {
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/**
 * Returns the notice line to print, or undefined. Terminal only, never under --json or CI, and at
 * most once per UTC day; the caller stores `config.lastNoticeOn` when a line is returned.
 */
export const updateNotice = (
  rt: Runtime,
  config: Config,
  latest: string | undefined,
  json: boolean,
  style: Styler,
): string | undefined => {
  if (!latest || !isNewer(latest, rt.version)) return undefined
  if (!isInteractive(rt, json) || !rt.stderr.isTTY || rt.env.CI) return undefined
  const today = rt.now().toISOString().slice(0, 10)
  if (config.lastNoticeOn === today) return undefined
  config.lastNoticeOn = today
  return style('dim', `A newer CLI is available (${latest}): npx @deepdockai/cli@latest`)
}
