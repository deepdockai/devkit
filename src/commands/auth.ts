import type { Command } from '@commander-js/extra-typings'
import { CliError, usageError } from '../api/errors.ts'
import { parseAnswer } from '../api/schemas.ts'
import { assertNotExpired, pollUntilApproved } from '../approval/poll.ts'
import { startLogin } from '../approval/request.ts'
import { requestedSlug, selectableOrgs } from '../config/orgSelection.ts'
import type { KeyEntry, PendingRequest } from '../config/store.ts'
import { assertSameBaseUrl, type Ctx, type Result } from '../context.ts'
import { AUTH_LOGIN_HELP } from '../help.ts'
import { orgTable, renderTable } from '../output/human.ts'
import type { Run } from '../program.ts'
import { DEFAULT_BASE_URL } from '../runtime.ts'
import { displayPath } from '../writeEnv/ledger.ts'
import { type Removal, describeRemoval, settleWrittenLine } from '../writeEnv/removal.ts'

const minutesLeft = (ctx: Ctx, expiresAt: string): number =>
  Math.max(1, Math.ceil((Date.parse(expiresAt) - ctx.rt.now().getTime()) / 60000))

export const announceApproval = (
  ctx: Ctx,
  what: string,
  url: string,
  expiresAt: string,
  extra?: string,
): void => {
  ctx.note(
    `Open this link to approve ${what} (it expires in ${minutesLeft(ctx, expiresAt)} minutes):`,
  )
  ctx.note(`  ${url}`)
  ctx.note(
    extra ??
      "The page shows this computer's name and the CLI version: check them before you approve.",
  )
  ctx.note('Waiting for approval in the browser.')
}

export const pendingResult = (pending: PendingRequest, url: string, text: string): Result => ({
  data: { pending: { request: pending.request, url, expiresAt: pending.expiresAt } },
  text,
})

export const upsertPending = async (ctx: Ctx, pending: PendingRequest): Promise<void> => {
  // Keyed by request id: several requests can be pending at once.
  await ctx.update((config) => {
    config.pending = [
      ...config.pending.filter((entry) => entry.request !== pending.request),
      pending,
    ]
  })
}

const finishLogin = async (ctx: Ctx, pending: PendingRequest): Promise<Result> => {
  const { answer, requestId } = await pollUntilApproved(ctx.rt, ctx.api, 'loginPoll', {
    kind: 'login',
    path: '/public/cli/logins/poll',
    pollSecret: pending.pollSecret,
    expiresAt: pending.expiresAt,
    resume: `deepdock auth login --wait ${pending.request}`,
  }).catch((error: unknown) => {
    if (error instanceof CliError && error.code === 'not_found') {
      error.hint =
        'The request is unknown or was already collected. Run `deepdock auth login` again.'
    }
    throw error
  })
  const now = ctx.rt.now().toISOString()
  const slugs = selectableOrgs(answer.organisations).map((org) => org.slug)
  const config = await ctx.update((current) => {
    current.signIn = {
      id: answer.id,
      secret: answer.key,
      baseUrl: ctx.baseUrl,
      email: answer.user.email,
      firstName: answer.user.firstName ?? undefined,
      expiresAt: answer.expiresAt,
      createdAt: now,
      hostname: ctx.rt.hostname,
      environment: answer.environment,
    }
    current.organisations = answer.organisations
    if (current.defaultOrg && !slugs.includes(current.defaultOrg)) current.defaultOrg = undefined
    current.pending = current.pending.filter((entry) => entry.request !== pending.request)
  })

  const lines = [`Signed in as ${answer.user.email}.`, '']
  if (answer.organisations.length === 0) {
    lines.push('You are not a member of an organisation yet.')
  } else {
    lines.push(
      'Your organisations:',
      indented(orgTable(answer.organisations, config.defaultOrg, ctx.out)),
      '',
    )
    lines.push('Choose one with `deepdock org select <slug>` or pass --org to each command.')
  }
  return {
    data: {
      email: answer.user.email,
      expiresAt: answer.expiresAt,
      defaultOrg: config.defaultOrg ?? null,
      organisations: answer.organisations,
    },
    meta: requestId ? { requestId } : {},
    text: lines.join('\n'),
  }
}

type LoginOptions = { wait?: string | false }

const login = async (ctx: Ctx, options: LoginOptions): Promise<Result> => {
  const config = await ctx.config()
  if (typeof options.wait === 'string') {
    const pending = config.pending.find(
      (entry) => entry.kind === 'login' && entry.request === options.wait,
    )
    if (!pending) {
      throw usageError(
        `There is no pending sign-in request ${options.wait}.`,
        'Start one with `deepdock auth login --no-wait`.',
      )
    }
    assertSameBaseUrl(pending.baseUrl, ctx.baseUrl, 'request')
    assertNotExpired(ctx.rt, 'login', pending.expiresAt)
    ctx.note('Waiting for approval in the browser.')
    return finishLogin(ctx, pending)
  }

  const started = await startLogin(ctx.api, ctx.rt)
  const pending: PendingRequest = {
    kind: 'login',
    baseUrl: ctx.baseUrl,
    request: started.request,
    pollSecret: started.pollSecret,
    expiresAt: started.expiresAt,
  }
  await upsertPending(ctx, pending)
  if (options.wait === false || !ctx.interactive) {
    return pendingResult(
      pending,
      started.url,
      [
        `Open this link to approve the sign-in: ${started.url}`,
        `Then run \`deepdock auth login --wait ${started.request}\`.`,
      ].join('\n'),
    )
  }
  announceApproval(ctx, 'the sign-in', started.url, started.expiresAt)
  ctx.rt.openBrowser(started.url)
  return finishLogin(ctx, pending)
}

const keyRows = (ctx: Ctx, keys: KeyEntry[]): string[][] =>
  keys.map((key) => [
    key.org,
    key.id,
    key.name,
    `${key.prefix}…`,
    key.expiresAt.slice(0, 10),
    displayPath(ctx.rt, key.file),
  ])

const keyJson = (ctx: Ctx, key: KeyEntry): Record<string, unknown> => ({
  org: key.org,
  id: key.id,
  name: key.name,
  prefix: key.prefix,
  expiresAt: key.expiresAt,
  written: { file: displayPath(ctx.rt, key.file), name: key.variable },
})

const indented = (table: string): string =>
  table
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')

const status = async (ctx: Ctx): Promise<Result> => {
  const config = await ctx.config()
  const baseUrl = ctx.baseUrl
  let signedIn = false
  let requestId: string | undefined
  if (config.signIn && Date.parse(config.signIn.expiresAt) > ctx.rt.now().getTime()) {
    try {
      const response = await ctx.call({ method: 'GET', path: '/partner/orgs' })
      const orgs = await parseAnswer('orgs', response.data)
      await ctx.update((current) => {
        current.organisations = orgs
      })
      config.organisations = orgs
      requestId = response.requestId
      signedIn = true
    } catch (error) {
      if (!(error instanceof CliError && error.code === 'sign_in_needed')) throw error
    }
  }
  const apiKeysCreated = config.keys.map((key) => keyJson(ctx, key))
  const data = {
    signedIn,
    email: config.signIn?.email ?? null,
    expiresAt: config.signIn?.expiresAt ?? null,
    baseUrl,
    defaultOrg: config.defaultOrg ?? null,
    organisations: signedIn ? (config.organisations ?? []) : [],
    apiKeysCreated,
  }
  const defaultOrg = requestedSlug(ctx.opts.org, ctx.rt.env, config)
  const lines: string[] = []
  if (signedIn && config.signIn) {
    lines.push(
      `Signed in as ${config.signIn.email} (sign-in valid until ${config.signIn.expiresAt.slice(0, 10)}).`,
    )
    if (baseUrl !== DEFAULT_BASE_URL)
      lines.push(ctx.out('yellow', `API: ${baseUrl} (not production)`))
    if (data.organisations.length > 0) {
      lines.push(
        '',
        'Organisations:',
        indented(orgTable(data.organisations, defaultOrg, ctx.out)),
        '',
        defaultOrg
          ? 'Switch the default with `deepdock org select <slug>`.'
          : 'No default yet: choose one with `deepdock org select <slug>`.',
      )
    }
  } else {
    lines.push(
      config.signIn
        ? 'Your sign-in has expired. Run `deepdock auth login`.'
        : 'Not signed in. Run `deepdock auth login`.',
    )
  }
  if (config.keys.length > 0) {
    lines.push(
      '',
      'API keys this CLI created:',
      renderTable(
        ['ORG', 'ID', 'NAME', 'PREFIX', 'EXPIRES', 'FILE'],
        keyRows(ctx, config.keys),
        ctx.out,
      )
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    )
  }
  if (!signedIn) ctx.note('Run `deepdock auth login`.')
  return {
    data,
    meta: requestId ? { requestId } : {},
    text: lines.join('\n'),
    // Like `gh auth status`: the state is printed, and the exit code says it is not signed in.
    ...(signedIn ? {} : { exit: 5 as const }),
  }
}

type KeyFacts = { org: string; id: string; name: string; prefix: string }
type RevokedKey = KeyFacts & { removed: Removal }
type UnrevokedKey = KeyFacts & { error: { code: string; message: string } }

const factsOf = (entry: KeyEntry): KeyFacts => ({
  org: entry.org,
  id: entry.id,
  name: entry.name,
  prefix: entry.prefix,
})

const revokeRecordedKey = async (ctx: Ctx, entry: KeyEntry): Promise<RevokedKey | UnrevokedKey> => {
  try {
    await ctx.call({
      method: 'DELETE',
      path: `/partner/keys/${encodeURIComponent(entry.id)}`,
      org: entry.org,
    })
  } catch (error) {
    // not_found: the key is already gone, which is what logout wants.
    if (!(error instanceof CliError)) throw error
    if (error.code === 'connection_lost') throw error
    if (error.code !== 'not_found') {
      return { ...factsOf(entry), error: { code: error.code, message: error.message } }
    }
  }
  // Logout clears local state, so a failed removal is reported and the entry is dropped too.
  return { ...factsOf(entry), removed: await settleWrittenLine(ctx, entry, false) }
}

const revokeSignInById = async (ctx: Ctx, id: string): Promise<void> => {
  try {
    await ctx.call({ method: 'DELETE', path: `/partner/cli-keys/${encodeURIComponent(id)}` })
  } catch (error) {
    // not_found: already revoked, which is what logout wants.
    if (!(error instanceof CliError && error.code === 'not_found')) throw error
  }
}

const logout = async (ctx: Ctx): Promise<Result> => {
  const config = await ctx.config()
  const signIn = config.signIn
  const email = signIn?.email ?? null
  const usable =
    Boolean(signIn) &&
    Date.parse(signIn?.expiresAt ?? '') > ctx.rt.now().getTime() &&
    (signIn?.baseUrl ?? DEFAULT_BASE_URL) === ctx.baseUrl
  const revokedKeys: RevokedKey[] = []
  const failedKeys: UnrevokedKey[] = []
  let signInRevoked = false

  if (usable) {
    for (const entry of [...config.keys]) {
      const outcome = await revokeRecordedKey(ctx, entry)
      if ('error' in outcome) failedKeys.push(outcome)
      else revokedKeys.push(outcome)
    }
    if (signIn?.id) {
      await revokeSignInById(ctx, signIn.id)
      signInRevoked = true
    }
  } else {
    for (const entry of config.keys) {
      failedKeys.push({
        ...factsOf(entry),
        error: { code: 'sign_in_needed', message: 'Your sign-in is missing or expired.' },
      })
    }
  }

  await ctx.update((current) => {
    current.signIn = undefined
    current.defaultOrg = undefined
    current.organisations = undefined
    current.pending = []
  })

  const lines: string[] = []
  if (!email) lines.push('Not signed in.')
  else if (signInRevoked) lines.push(`Signed out ${email}. The sign-in is revoked.`)
  else if (usable) {
    lines.push(
      `Signed out ${email}. The stored sign-in has no id (the settings file is damaged), so it was only removed from this computer; revoke it in the Deepdock dashboard.`,
    )
  } else {
    lines.push(
      `Signed out ${email}. The sign-in was only removed from this computer; revoke it in the Deepdock dashboard.`,
    )
  }
  if (revokedKeys.length > 0) {
    lines.push('Revoked the API keys this CLI created:')
    for (const key of revokedKeys) {
      const where = key.removed.removal === 'done' ? `   ${describeRemoval(key.removed)}` : ''
      lines.push(`  ${key.org}   "${key.name}"   ${key.prefix}…   ${key.id}${where}`)
    }
    lines.push('Programs still using one of them stop working now.')
  }
  for (const key of failedKeys) {
    lines.push(
      `Could not revoke "${key.name}" (${key.id}): run \`deepdock keys revoke ${key.id}\` after \`deepdock auth login\`.`,
    )
  }
  const hints = [
    ...(failedKeys.length > 0
      ? ['Revoke the remaining keys with `deepdock keys revoke <id>`.']
      : []),
    ...revokedKeys
      .filter((key) => key.removed.removal === 'failed')
      .map((key) => `Delete ${key.removed.name} from ${key.removed.file} by hand.`),
  ]
  return {
    data: {
      revoked: signInRevoked,
      email,
      apiKeysRevoked: revokedKeys,
      ...(failedKeys.length > 0 ? { apiKeysNotRevoked: failedKeys } : {}),
    },
    meta: hints.length > 0 ? { hint: hints.join(' ') } : {},
    text: lines.join('\n'),
  }
}

export const registerAuth = (program: Command, run: Run): void => {
  const auth = program
    .command('auth')
    .description('Sign in to Deepdock as yourself, see who is signed in, sign out')

  const loginCommand = auth
    .command('login')
    .description('Sign in to Deepdock as yourself')
    .option('--wait <request>', 'finish a request started with --no-wait')
    .option('--no-wait', 'print the request and exit')
    .action((options, cmd) => run(cmd, (ctx) => login(ctx, options)))
  loginCommand.helpInformation = (): string => AUTH_LOGIN_HELP

  auth
    .command('status')
    .description('Show who is signed in')
    .action((_options, cmd) => run(cmd, status))

  auth
    .command('logout')
    .description('Revoke the sign-in and the API keys this CLI created')
    .action((_options, cmd) => run(cmd, logout))
}
