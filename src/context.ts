import { type Api, type ApiRequest, type ApiResponse, baseUrlFor, createApi } from './api/client.ts'
import { CliError, signInNeeded } from './api/errors.ts'
import { parseAnswer } from './api/schemas.ts'
import { type ResolvedOrg, requestedSlug, resolveOrg } from './config/orgSelection.ts'
import { type Config, loadConfig, type OrgInfo, updateConfig } from './config/store.ts'
import type { Meta, OrgRef } from './output/envelope.ts'
import { makeStyler, type Styler } from './output/styles.ts'
import { isInteractive, wantsJson } from './output/terminal.ts'
import { DEFAULT_BASE_URL, type Runtime } from './runtime.ts'

export type GlobalOptions = { org?: string; json: boolean; yes: boolean }

export type Result = {
  data: unknown
  /** The human rendering; unused under JSON. */
  text: string
  meta?: Meta
  /** A non-zero exit code for a command that succeeded in printing but reports a failed state. */
  exit?: 5
}

export type Ctx = {
  rt: Runtime
  opts: GlobalOptions
  json: boolean
  interactive: boolean
  api: Api
  out: Styler
  err: Styler
  org: OrgRef | undefined
  /** The API origin this run talks to (validated). */
  baseUrl: string
  config: () => Promise<Config>
  /** Locked read-modify-write of the settings file; `change` sees the file as it is now. */
  update: (change: (config: Config) => void) => Promise<Config>
  note: (line: string) => void
  /** The sign-in secret, or sign_in_needed when none is stored or it has expired. */
  signInSecret: () => Promise<string>
  /** A request signed with the sign-in. */
  call: (req: Omit<ApiRequest, 'secret'>) => Promise<ApiResponse>
  /** The organisations of the person, from the stored copy unless `refresh` asks the API. */
  organisations: (refresh?: boolean) => Promise<OrgInfo[]>
  /** Resolves the organisation for this command and says which one on stderr. */
  resolveOrg: () => Promise<ResolvedOrg>
  /** A request signed with the sign-in for the resolved organisation. */
  callInOrg: (req: Omit<ApiRequest, 'secret' | 'org'>) => Promise<ApiResponse>
}

/** A secret made against one API is never sent to another; a stale one is made on purpose again. */
export const assertSameBaseUrl = (
  stored: string | undefined,
  current: string,
  what: 'sign-in' | 'request',
): void => {
  const origin = stored ?? DEFAULT_BASE_URL
  if (origin === current) return
  throw new CliError({
    code: 'sign_in_needed',
    message: `The ${what} was made against ${origin}, not ${current}, so it is not sent there.`,
    hint: 'Run `deepdock auth login` again, or unset DEEPDOCK_BASE_URL.',
  })
}

export const createContext = (rt: Runtime, opts: GlobalOptions): Ctx => {
  const json = wantsJson(rt, opts.json)
  const baseUrl = baseUrlFor(rt)
  const api = createApi(rt)
  let loaded: Config | undefined

  const config = async (): Promise<Config> => {
    loaded ??= await loadConfig(rt)
    return loaded
  }

  const ctx: Ctx = {
    rt,
    opts,
    json,
    interactive: isInteractive(rt, json),
    api,
    out: makeStyler(rt, rt.stdout),
    err: makeStyler(rt, rt.stderr),
    org: undefined,
    baseUrl,
    config,
    update: async (change: (config: Config) => void): Promise<Config> => {
      loaded = await updateConfig(rt, change)
      return loaded
    },
    note: (line: string): void => {
      rt.stderr.write(`${line}\n`)
    },
    signInSecret: async () => {
      const { signIn } = await config()
      if (!signIn || Date.parse(signIn.expiresAt) <= rt.now().getTime()) throw signInNeeded()
      assertSameBaseUrl(signIn.baseUrl, baseUrl, 'sign-in')
      return signIn.secret
    },
    call: async (req: Omit<ApiRequest, 'secret'>): Promise<ApiResponse> =>
      api.request({ ...req, secret: await ctx.signInSecret() }),
    organisations: async (refresh = false) => {
      const current = await config()
      if (!refresh && current.organisations) return current.organisations
      const response = await ctx.call({ method: 'GET', path: '/partner/orgs' })
      const orgs = await parseAnswer('orgs', response.data)
      await ctx.update((config) => {
        config.organisations = orgs
      })
      return orgs
    },
    resolveOrg: async () => {
      const current = await config()
      const requested = requestedSlug(opts.org, rt.env, current)
      const fromStoredDefault = !opts.org && !rt.env.DEEPDOCK_ORG
      let orgs = await ctx.organisations()
      if (requested && !orgs.some((org) => org.slug === requested)) {
        // The stored list can be older than a new membership; ask once before refusing.
        orgs = await ctx.organisations(true)
      }
      const resolved = resolveOrg(requested, orgs, fromStoredDefault)
      ctx.org = { slug: resolved.slug, name: resolved.name }
      ctx.note(ctx.err('dim', `Organisation: ${resolved.name} (${resolved.slug})`))
      return resolved
    },
    callInOrg: async (req: Omit<ApiRequest, 'secret' | 'org'>): Promise<ApiResponse> => {
      const org = await ctx.resolveOrg()
      try {
        return await ctx.call({ ...req, org: org.slug })
      } catch (error) {
        // The stored list may still hold an organisation the person has since lost: refresh it
        // and, if that is the cause, explain it instead of passing on the bare API refusal.
        if (error instanceof CliError && error.code === 'organization_required') {
          const refreshed = await ctx.organisations(true)
          const current = await config()
          const requested = requestedSlug(opts.org, rt.env, current)
          resolveOrg(requested, refreshed, !opts.org && !rt.env.DEEPDOCK_ORG)
        }
        throw error
      }
    },
  }
  return ctx
}
