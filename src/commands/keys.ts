import type { Command } from '@commander-js/extra-typings'
import { CliError, usageError } from '../api/errors.ts'
import { assertNotExpired, pollUntilApproved } from '../approval/poll.ts'
import { startKeyRequest } from '../approval/request.ts'
import { EXPIRY_DAYS, expiryArg, keyIdArg } from '../args.ts'
import { type PendingRequest, configPath } from '../config/store.ts'
import { assertSameBaseUrl, type Ctx, type Result } from '../context.ts'
import { KEYS_CREATE_HELP } from '../help.ts'
import { confirm } from '../output/confirm.ts'
import { genericTable, isRecord, KEY_COLUMNS, stripControl } from '../output/human.ts'
import type { Run } from '../program.ts'
import { addKey, displayPath, findKey, removeKey } from '../writeEnv/ledger.ts'
import { describeRemoval, settleWrittenLine } from '../writeEnv/removal.ts'
import {
  API_KEY_VARIABLE,
  checkDestination,
  windowsFileWarning,
  writeEnvValue,
} from '../writeEnv/writeEnv.ts'
import { announceApproval, pendingResult, upsertPending } from './auth.ts'

const DAY_MS = 86400000

type CreateOptions = { expires?: string; writeEnv?: string; wait?: string | false }

const list = async (ctx: Ctx): Promise<Result> => {
  const response = await ctx.callInOrg({ method: 'GET', path: '/partner/keys' })
  const items = Array.isArray(response.data) ? response.data : []
  return {
    data: response.data,
    meta: { requestId: response.requestId },
    text: items.length === 0 ? 'No API keys.' : genericTable(items, ctx.out, KEY_COLUMNS),
  }
}

const finishKey = async (ctx: Ctx, pending: PendingRequest, warned: boolean): Promise<Result> => {
  if (!pending.org || !pending.name || !pending.file || !pending.variable) {
    throw usageError(
      'The pending key request is incomplete.',
      'Start it again with `deepdock keys create`.',
    )
  }
  assertSameBaseUrl(pending.baseUrl, ctx.baseUrl, 'request')
  assertNotExpired(ctx.rt, 'key', pending.expiresAt)
  // Fail early, before the human is asked anything; the rules apply again right before the write.
  await checkDestination(ctx.rt, pending.file)
  ctx.opts.org = pending.org
  const org = await ctx.resolveOrg()

  const { answer, requestId } = await pollUntilApproved(ctx.rt, ctx.api, 'keyPoll', {
    kind: 'key',
    path: '/partner/key-requests/poll',
    pollSecret: pending.pollSecret,
    expiresAt: pending.expiresAt,
    resume: `deepdock keys create --wait ${pending.request}`,
    secret: await ctx.signInSecret(),
    org: org.slug,
  })
  const created = answer.key
  const entry = {
    org: org.slug,
    id: created.id,
    name: created.name,
    prefix: created.keyPrefix,
    expiresAt: created.expiresAt,
    file: pending.file,
    variable: pending.variable,
  }
  // Recorded before anything else can fail: a key that exists is always known to `auth logout`.
  await ctx.update((config) => {
    addKey(config, entry)
    config.pending = config.pending.filter((other) => other.request !== pending.request)
  })
  try {
    // The file can change while the human is in the browser.
    const destination = await checkDestination(ctx.rt, pending.file)
    if (!warned && destination.warning) ctx.note(destination.warning)
    // Once per run that writes the env file.
    const windows = windowsFileWarning(ctx.rt.platform, pending.file, configPath(ctx.rt))
    if (windows) ctx.note(windows)
    await writeEnvValue(pending.file, pending.variable, created.key)
  } catch (error) {
    // The value exists nowhere else; a key that cannot be delivered must not stay valid.
    let revoked = true
    try {
      await ctx.call({
        method: 'DELETE',
        path: `/partner/keys/${encodeURIComponent(created.id)}`,
        org: org.slug,
      })
    } catch {
      revoked = false
    }
    // If the revoke failed the entry stays, so `auth logout` retries it.
    if (revoked) await ctx.update((config) => removeKey(config, created.id))
    throw new CliError({
      code: error instanceof CliError ? error.code : 'internal_error',
      message: `The key could not be written to ${pending.file}${error instanceof CliError ? `: ${error.message}` : ''}`,
      hint: revoked
        ? 'The key was revoked. Fix the file and run `deepdock keys create` again.'
        : `Revoke it with \`deepdock keys revoke ${created.id}\`, then run \`deepdock keys create\` again.`,
    })
  }

  const file = displayPath(ctx.rt, pending.file)
  const days = Math.round((Date.parse(created.expiresAt) - ctx.rt.now().getTime()) / DAY_MS)
  const text = [
    `Created API key "${stripControl(created.name)}".`,
    `  ID:        ${created.id}`,
    `  Prefix:    ${created.keyPrefix}`,
    `  Expires:   ${created.expiresAt.slice(0, 10)} (${days} days)`,
    `  Written:   ${file} (${pending.variable})`,
    `The key value was shown to nobody and this CLI keeps no copy; your code reads it from ${file}.`,
    `To revoke it: deepdock keys revoke ${created.id}`,
    '`deepdock auth logout` revokes this key; use `auth logout --keep-keys` to keep it.',
  ].join('\n')
  return {
    // Built from named fields: the API's answer carries the key value.
    data: {
      id: created.id,
      name: created.name,
      prefix: created.keyPrefix,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
    },
    meta: { requestId, written: { file, name: pending.variable } },
    text,
  }
}

const create = async (
  ctx: Ctx,
  name: string | undefined,
  options: CreateOptions,
): Promise<Result> => {
  const config = await ctx.config()
  if (typeof options.wait === 'string') {
    const pending = config.pending.find(
      (entry) => entry.kind === 'key' && entry.request === options.wait,
    )
    if (!pending) {
      throw usageError(
        `There is no pending key request ${options.wait}.`,
        'Start one with `deepdock keys create ... --no-wait`.',
      )
    }
    ctx.note('Waiting for approval in the browser.')
    return finishKey(ctx, pending, false)
  }

  if (
    name === undefined ||
    name.trim() === '' ||
    name.length > 100 ||
    stripControl(name) !== name
  ) {
    throw usageError(
      'The key needs a name of 1 to 100 characters.',
      'Example: `deepdock keys create "myapp dev" --expires 30d --write-env .env.local`.',
    )
  }
  const days = expiryArg(options.expires)
  if (!options.writeEnv) {
    throw usageError(
      'The key needs a destination.',
      'Pass --write-env <file>, e.g. --write-env .env.local.',
    )
  }
  const destination = await checkDestination(ctx.rt, options.writeEnv)
  const secret = await ctx.signInSecret()
  const org = await ctx.resolveOrg()
  if (destination.warning) ctx.note(destination.warning)

  const keyExpiresAt = new Date(ctx.rt.now().getTime() + days * DAY_MS).toISOString()
  const started = await startKeyRequest(ctx.api, ctx.rt, {
    secret,
    org: org.slug,
    name,
    expiresAt: keyExpiresAt,
  })
  const pending: PendingRequest = {
    kind: 'key',
    baseUrl: ctx.baseUrl,
    request: started.request,
    pollSecret: started.pollSecret,
    expiresAt: started.expiresAt,
    org: org.slug,
    name,
    keyExpiresAt,
    file: destination.path,
    variable: API_KEY_VARIABLE,
  }
  await upsertPending(ctx, pending)
  if (options.wait === false || !ctx.interactive) {
    return pendingResult(
      pending,
      started.url,
      [
        `Open this link to approve the key: ${ctx.out('link', started.url)}`,
        `Then run \`deepdock keys create --wait ${started.request}\`.`,
      ].join('\n'),
    )
  }
  announceApproval(
    ctx,
    'the key',
    started.url,
    started.expiresAt,
    `A human approves "Create an API key in ${org.name}?" there; the page shows this computer's name.`,
  )
  ctx.rt.openBrowser(started.url)
  return finishKey(ctx, pending, true)
}

const revoke = async (ctx: Ctx, id: string): Promise<Result> => {
  const keyId = keyIdArg(id)
  if (!ctx.opts.yes && !ctx.interactive) {
    throw usageError(
      'Revoking a key needs a confirmation and there is no terminal.',
      'Run it again with --yes.',
    )
  }
  const config = await ctx.config()
  const entry = findKey(config, keyId)
  if (entry && !ctx.opts.org && !ctx.rt.env.DEEPDOCK_ORG) ctx.opts.org = entry.org
  const org = await ctx.resolveOrg()
  if (!ctx.opts.yes) {
    const subject = entry
      ? `API key "${stripControl(entry.name)}" (${entry.prefix}…, created by this CLI, written to ${displayPath(ctx.rt, entry.file)})`
      : `API key ${keyId}`
    const question = `Revoke ${subject}?\nEvery program using it stops working at once.`
    if (!(await confirm(ctx.rt, question))) throw usageError('Not revoked.', 'Nothing was changed.')
  }
  let response: { data: unknown; requestId?: string }
  let alreadyRevoked = false
  try {
    response = await ctx.call({
      method: 'DELETE',
      path: `/partner/keys/${encodeURIComponent(keyId)}`,
      org: org.slug,
    })
  } catch (error) {
    // A key this CLI wrote that is already revoked: an earlier run could not clean its env line,
    // and running this again is how that is retried. Only the key's own organisation can say so:
    // a not_found from any other organisation proves nothing.
    const sameOrg = entry?.org === org.slug
    if (!(entry && sameOrg && error instanceof CliError && error.code === 'not_found')) {
      if (entry && !sameOrg && error instanceof CliError && error.code === 'not_found') {
        error.hint = `This key was created in ${entry.org}; run it with --org ${entry.org}.`
      }
      throw error
    }
    response = { data: { id: keyId } }
    alreadyRevoked = true
  }
  const removed = entry ? await settleWrittenLine(ctx, entry, true) : null
  const apiData = isRecord(response.data) ? response.data : {}
  const label = entry ? `API key "${stripControl(entry.name)}"` : `API key ${keyId}`
  const text =
    removed?.removal === 'done'
      ? `Revoked ${label} and ${describeRemoval(removed)}.`
      : `Revoked ${label}.`
  return {
    data: { ...apiData, ...(alreadyRevoked ? { alreadyRevoked: true } : {}), removed },
    meta: { requestId: response.requestId },
    text,
  }
}

export const registerKeys = (program: Command, run: Run): void => {
  const keys = program
    .command('keys')
    .description("Create, list and revoke your organisation's API keys")

  keys
    .command('list')
    .description('List the API keys of the organisation')
    .action((_options, cmd) => run(cmd, list))

  const allowed = Object.keys(EXPIRY_DAYS).join('|')
  const createCommand = keys
    .command('create')
    .description('Create an API key for your organisation (admin)')
    .argument('[name]', 'a name that says what the key is for')
    .option('--expires <duration>', `${allowed}; 90 days is the maximum from the CLI`)
    .option('--write-env <file>', 'write DEEPDOCK_API_KEY=<key> into this env file')
    .option('--wait <request>', 'finish a request started with --no-wait')
    .option('--no-wait', 'print the request and exit')
    .action((name, options, cmd) => run(cmd, (ctx) => create(ctx, name, options)))
  createCommand.helpInformation = (): string => KEYS_CREATE_HELP

  keys
    .command('revoke')
    .description('Revoke an API key (admin)')
    .argument('<id>', 'the key id')
    .action((id, _options, cmd) => run(cmd, (ctx) => revoke(ctx, id)))
}
