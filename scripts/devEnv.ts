import { join } from 'node:path'
import { baseUrlFor } from '../src/api/client.ts'
import { configBaseDir } from '../src/config/store.ts'

export type Host = {
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  homedir: string
}

export type DevEnv = { DEEPDOCK_BASE_URL: string; DEEPDOCK_CONFIG_DIR: string }

/**
 * The environment a development run gets: the API DEEPDOCK_BASE_URL names (the production one by
 * default) and a settings directory of its own per API host, so a sign-in made against one API never
 * sits in another's file, and nothing outside the CLI (mise, git, editors) sees a moved config dir.
 * `host`, not `hostname`: two local APIs on different ports stay apart too.
 */
export const devEnv = (host: Host): DevEnv => {
  const baseUrl = baseUrlFor(host)
  return {
    DEEPDOCK_BASE_URL: baseUrl,
    DEEPDOCK_CONFIG_DIR: join(configBaseDir(host), 'deepdock-dev', new URL(baseUrl).host),
  }
}

/** A usage failure outside the CLI's own error document: message and hint to stderr, exit 2. */
export const reportFailure = (error: unknown): void => {
  const described = error as { message?: unknown; hint?: unknown }
  process.stderr.write(
    `${typeof described.message === 'string' ? described.message : String(error)}\n`,
  )
  if (typeof described.hint === 'string') process.stderr.write(`${described.hint}\n`)
  process.exitCode = 2
}
