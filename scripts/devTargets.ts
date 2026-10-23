import { join } from 'node:path'
import { configBaseDir } from '../src/config/store.ts'

export const TARGETS = ['staging', 'production', 'local'] as const
export type Target = (typeof TARGETS)[number]

export const DEFAULT_TARGET: Target = 'staging'

/** Where a maintainer's three APIs live. `local` is wrangler's default port; DEEPDOCK_BASE_URL overrides it. */
const BASE_URLS: Record<Target, string> = {
  staging: 'https://api.staging.deepdock.ai',
  production: 'https://api.deepdock.ai',
  local: 'http://localhost:8787',
}

export const isTarget = (value: string): value is Target =>
  (TARGETS as readonly string[]).includes(value)

export type Host = {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  homedir: string
}

/**
 * The environment a development run of the CLI gets: the target's API, and a settings directory of
 * its own per target, so a staging sign-in never sits in the file the production sign-in uses and
 * nothing outside the CLI (mise, git, editors) sees a moved config dir.
 */
export const targetEnv = (
  target: Target,
  host: Host,
): { DEEPDOCK_BASE_URL: string; DEEPDOCK_CONFIG_DIR: string } => {
  const override = target === 'local' ? host.env.DEEPDOCK_BASE_URL : undefined
  return {
    DEEPDOCK_BASE_URL: override || BASE_URLS[target],
    DEEPDOCK_CONFIG_DIR: join(configBaseDir(host), 'deepdock-dev', target),
  }
}

/** Splits `--target <name>` (or `--target=<name>`, or DEEPDOCK_TARGET) off the front of the CLI's own arguments. */
export const splitTarget = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { target: Target; rest: string[] } | { error: string } => {
  let name: string | undefined = env.DEEPDOCK_TARGET
  let rest = [...argv]
  if (rest[0]?.startsWith('--target=')) {
    name = rest[0].slice('--target='.length)
    rest = rest.slice(1)
  } else if (rest[0] === '--target') {
    name = rest[1]
    rest = rest.slice(2)
  }
  if (name === undefined) return { target: DEFAULT_TARGET, rest }
  if (!isTarget(name))
    return { error: `Unknown target "${name}". Use one of: ${TARGETS.join(', ')}.` }
  return { target: name, rest }
}
