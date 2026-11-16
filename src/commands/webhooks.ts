import type { Command } from '@commander-js/extra-typings'
import { CliError, usageError } from '../api/errors.ts'
import { parseAnswer } from '../api/schemas.ts'
import { webhookIdArg } from '../args.ts'
import { configPath } from '../config/store.ts'
import type { Ctx, Result } from '../context.ts'
import { confirm } from '../output/confirm.ts'
import {
  EVENT_TYPE_COLUMNS,
  field,
  genericTable,
  genericView,
  isRecord,
  stripControl,
  WEBHOOK_COLUMNS,
  WEBHOOK_LIST_COLUMNS,
  words,
} from '../output/human.ts'
import { paint } from '../output/styles.ts'
import type { Run } from '../program.ts'
import { displayPath } from '../writeEnv/ledger.ts'
import {
  checkDestination,
  WEBHOOK_SECRET_VARIABLE,
  windowsFileWarning,
  writeEnvValue,
} from '../writeEnv/writeEnv.ts'

type EventFlags = { event: string[]; allEvents?: true }

const collect = (value: string, previous: string[]): string[] => [...previous, value]

const route = (webhookId: string, tail = ''): string => `/partner/webhooks/${webhookId}${tail}`

/** The event types a command sends, or undefined when it names none; never an empty list. */
const eventTypesOf = async (ctx: Ctx, flags: EventFlags): Promise<string[] | undefined> => {
  if (flags.allEvents && flags.event.length > 0) {
    throw usageError('Use --event or --all-events, not both.')
  }
  if (!flags.allEvents) return flags.event.length > 0 ? flags.event : undefined
  const response = await ctx.callInOrg({ method: 'GET', path: '/partner/webhook-event-types' })
  const types = (await parseAnswer('eventTypes', response.data)).map((entry) => entry.type)
  if (types.length === 0) {
    throw usageError(
      'No event types exist for your organisation yet, so --all-events selects none.',
      'Run `deepdock webhooks events` to see what exists.',
    )
  }
  return types
}

/** Checked before anything is created or rotated, so a refused file leaves nothing behind. */
const secretFile = async (ctx: Ctx, file: string): Promise<string> => {
  const destination = await checkDestination(ctx.rt, file)
  if (destination.warning) ctx.note(destination.warning)
  const windows = windowsFileWarning(ctx.rt.platform, destination.path, configPath(ctx.rt))
  if (windows) ctx.note(windows)
  return destination.path
}

type Delivered = { data: Record<string, unknown>; written: { file: string; name: string } }

/**
 * Reads the endpoint's signing secret and writes it to `path`; it is in no stream and no store.
 * A failed write leaves the secret where it was: an admin can read it again.
 */
const deliverSecret = async (ctx: Ctx, webhookId: string, path: string): Promise<Delivered> => {
  const response = await ctx.callInOrg({ method: 'GET', path: route(webhookId, '/secret') })
  const answer = await parseAnswer('webhookSecret', response.data)
  try {
    await writeEnvValue(path, WEBHOOK_SECRET_VARIABLE, answer.secret)
  } catch (error) {
    throw new CliError({
      code: error instanceof CliError ? error.code : 'internal_error',
      message: `The secret could not be written to ${path}${error instanceof CliError ? `: ${error.message}` : ''}`,
      hint: `The secret stays readable: fix the file and run \`deepdock webhooks secret ${webhookId} --write-env <file>\`.`,
    })
  }
  return {
    // Built from named fields: the API's answer carries the secret.
    data: {
      id: webhookId,
      secretCreatedAt: answer.createdAt,
      previousSecretExpiresAt: answer.previousExpiresAt,
    },
    written: { file: displayPath(ctx.rt, path), name: WEBHOOK_SECRET_VARIABLE },
  }
}

const writtenLine = (delivered: Delivered): string =>
  `The signing secret was shown to nobody and this CLI keeps no copy; your code reads ${delivered.written.name} from ${delivered.written.file}.`

const meta = (requestId?: string, written?: Delivered['written']): Result['meta'] => ({
  ...(requestId ? { requestId } : {}),
  ...(written ? { written } : {}),
})

const confirmed = async (ctx: Ctx, verb: 'delete' | 'rotate', question: string): Promise<void> => {
  if (ctx.opts.yes) return
  if (!ctx.interactive) {
    throw usageError(
      'This needs a confirmation and there is no terminal.',
      'Run it again with --yes.',
    )
  }
  await ctx.resolveOrg()
  if (!(await confirm(ctx.rt, question))) {
    throw usageError(`Not ${verb}d.`, 'Nothing was changed.')
  }
}

const list = async (ctx: Ctx): Promise<Result> => {
  const response = await ctx.callInOrg({ method: 'GET', path: '/partner/webhooks' })
  const items = Array.isArray(response.data) ? response.data : []
  return {
    data: response.data,
    meta: meta(response.requestId),
    text:
      items.length === 0
        ? 'No webhooks. Create one with `deepdock webhooks create <url> --all-events`.'
        : genericTable(items, ctx.out, WEBHOOK_LIST_COLUMNS),
  }
}

const get = async (ctx: Ctx, id: string): Promise<Result> => {
  const response = await ctx.callInOrg({ method: 'GET', path: route(webhookIdArg(id)) })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: genericView(response.data, ctx.out, WEBHOOK_COLUMNS),
  }
}

type CreateOptions = EventFlags & { description?: string; writeEnv?: string }

const create = async (ctx: Ctx, url: string, options: CreateOptions): Promise<Result> => {
  const eventTypes = await eventTypesOf(ctx, options)
  if (eventTypes === undefined) {
    throw usageError(
      'A webhook needs at least one event type.',
      'Pass --event <type> (repeatable) or --all-events; `deepdock webhooks events` lists the types.',
    )
  }
  const path = options.writeEnv === undefined ? undefined : await secretFile(ctx, options.writeEnv)
  const created = await ctx.callInOrg({
    method: 'POST',
    path: '/partner/webhooks',
    body: {
      url,
      eventTypes,
      ...(options.description === undefined ? {} : { description: options.description }),
    },
  })
  const id = isRecord(created.data) ? field(created.data, 'id') : ''
  const lines = [`${paint(ctx.out, 'success', 'Created')} webhook ${id} for ${stripControl(url)}.`]
  const delivered = path === undefined ? undefined : await deliverSecret(ctx, id, path)
  lines.push(
    delivered
      ? writtenLine(delivered)
      : `Its signing secret is not written anywhere yet: \`deepdock webhooks secret ${id} --write-env <file>\`.`,
  )
  return {
    data: created.data,
    meta: meta(created.requestId, delivered?.written),
    text: lines.join('\n'),
  }
}

type UpdateOptions = EventFlags & { url?: string; description?: string }

const update = async (ctx: Ctx, id: string, options: UpdateOptions): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const eventTypes = await eventTypesOf(ctx, options)
  const body = {
    ...(options.url === undefined ? {} : { url: options.url }),
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(eventTypes === undefined ? {} : { eventTypes }),
  }
  if (Object.keys(body).length === 0) {
    throw usageError('Nothing to change.', 'Pass --url, --description, --event or --all-events.')
  }
  const response = await ctx.callInOrg({ method: 'PATCH', path: route(webhookId), body })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: `${paint(ctx.out, 'success', 'Updated')} webhook ${webhookId}.`,
  }
}

const remove = async (ctx: Ctx, id: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  await confirmed(
    ctx,
    'delete',
    `Delete webhook ${webhookId}?\nIts stored deliveries are deleted with it.`,
  )
  const response = await ctx.callInOrg({ method: 'DELETE', path: route(webhookId) })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: `${paint(ctx.out, 'success', 'Deleted')} webhook ${webhookId}.`,
  }
}

const setActive = async (ctx: Ctx, id: string, change: 'disable' | 'enable'): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const response = await ctx.callInOrg({ method: 'POST', path: route(webhookId, `/${change}`) })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: `${paint(ctx.out, 'success', change === 'enable' ? 'Enabled' : 'Disabled')} webhook ${webhookId}.`,
  }
}

const secret = async (ctx: Ctx, id: string, file: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const delivered = await deliverSecret(ctx, webhookId, await secretFile(ctx, file))
  return {
    data: delivered.data,
    meta: meta(undefined, delivered.written),
    text: `${paint(ctx.out, 'success', 'Wrote')} the signing secret of webhook ${webhookId} to ${delivered.written.file}.\n${writtenLine(delivered)}`,
  }
}

const rotateSecret = async (ctx: Ctx, id: string, file: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const path = await secretFile(ctx, file)
  await confirmed(
    ctx,
    'rotate',
    `Rotate the signing secret of webhook ${webhookId}?\nThe old secret keeps signing for 24 hours next to the new one; update your receiver within that time.`,
  )
  await ctx.callInOrg({ method: 'POST', path: route(webhookId, '/secret/rotate') })
  const delivered = await deliverSecret(ctx, webhookId, path)
  return {
    data: delivered.data,
    meta: meta(undefined, delivered.written),
    text: `${paint(ctx.out, 'success', 'Rotated')} the signing secret of webhook ${webhookId}.\n${writtenLine(delivered)}`,
  }
}

const sendTest = async (ctx: Ctx, id: string, type: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  let response: Awaited<ReturnType<Ctx['callInOrg']>>
  try {
    response = await ctx.callInOrg({
      method: 'POST',
      path: route(webhookId, '/test'),
      body: { type },
    })
  } catch (error) {
    if (error instanceof CliError && error.code === 'webhook_disabled') {
      error.hint = `Run \`deepdock webhooks enable ${webhookId}\`, then send the example again.`
    }
    throw error
  }
  const attempt =
    isRecord(response.data) && isRecord(response.data.attempt) ? response.data.attempt : {}
  const outcome = field(attempt, 'outcome')
  const status = field(attempt, 'statusCode')
  const lines = [
    `Sent a test ${stripControl(type)} to webhook ${webhookId}: ${paint(ctx.out, outcome === 'succeeded' ? 'success' : 'warn', words(outcome))} (${status ? `HTTP ${status}` : 'no HTTP answer'}, ${field(attempt, 'durationMs')} ms).`,
    `Response body: ${stripControl(field(attempt, 'responseBody')) || '(empty)'}`,
    'The example is stored nowhere: it appears in no delivery list.',
  ]
  return { data: response.data, meta: meta(response.requestId), text: lines.join('\n') }
}

const events = async (ctx: Ctx): Promise<Result> => {
  const response = await ctx.callInOrg({ method: 'GET', path: '/partner/webhook-event-types' })
  const items = Array.isArray(response.data) ? response.data : []
  return {
    data: response.data,
    meta: meta(response.requestId),
    text:
      items.length === 0
        ? 'No event types exist for your organisation yet.'
        : genericTable(items, ctx.out, EVENT_TYPE_COLUMNS),
  }
}

export const registerWebhooks = (program: Command, run: Run): void => {
  const webhooks = program
    .command('webhooks')
    .description('Webhook endpoints: where Deepdock sends a message when a device sees a change')

  webhooks
    .command('list')
    .description('List the webhooks of the organisation')
    .action((_options, cmd) => run(cmd, list))

  webhooks
    .command('get')
    .description('Show one webhook with its seven-day statistics')
    .argument('<id>', 'the webhook id')
    .action((id, _options, cmd) => run(cmd, (ctx) => get(ctx, id)))

  webhooks
    .command('create')
    .description('Create a webhook (admin)')
    .argument('<url>', 'an https URL on port 443 that accepts POST')
    .option('--description <text>', 'what the webhook is for, at most 200 characters')
    .option('--event <type>', 'an event type to send; repeat the flag for several', collect, [])
    .option('--all-events', 'every event type that exists now (not types added later)')
    .option('--write-env <file>', 'write DEEPDOCK_WEBHOOK_SECRET=<secret> into this env file')
    .action((url, options, cmd) => run(cmd, (ctx) => create(ctx, url, options)))

  webhooks
    .command('update')
    .description('Change a webhook (admin)')
    .argument('<id>', 'the webhook id')
    .option('--url <url>', 'the new URL')
    .option('--description <text>', 'the new description; "" clears it')
    .option('--event <type>', 'replace the event types; repeat the flag for several', collect, [])
    .option('--all-events', 'replace the event types with every type that exists now')
    .action((id, options, cmd) => run(cmd, (ctx) => update(ctx, id, options)))

  webhooks
    .command('delete')
    .description('Delete a webhook and its stored deliveries (admin)')
    .argument('<id>', 'the webhook id')
    .action((id, _options, cmd) => run(cmd, (ctx) => remove(ctx, id)))

  webhooks
    .command('disable')
    .description('Stop sending to a webhook; its waiting deliveries are paused (admin)')
    .argument('<id>', 'the webhook id')
    .action((id, _options, cmd) => run(cmd, (ctx) => setActive(ctx, id, 'disable')))

  webhooks
    .command('enable')
    .description('Send to a disabled webhook again; its paused deliveries resume (admin)')
    .argument('<id>', 'the webhook id')
    .action((id, _options, cmd) => run(cmd, (ctx) => setActive(ctx, id, 'enable')))

  webhooks
    .command('secret')
    .description('Write the signing secret of a webhook into an env file (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption(
      '--write-env <file>',
      'write DEEPDOCK_WEBHOOK_SECRET=<secret> into this env file',
    )
    .action((id, options, cmd) => run(cmd, (ctx) => secret(ctx, id, options.writeEnv)))

  webhooks
    .command('rotate-secret')
    .description('Make a new signing secret and write it into an env file (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption(
      '--write-env <file>',
      'write DEEPDOCK_WEBHOOK_SECRET=<secret> into this env file',
    )
    .action((id, options, cmd) => run(cmd, (ctx) => rotateSecret(ctx, id, options.writeEnv)))

  webhooks
    .command('test')
    .description('Send one example message to a webhook now and show the answer (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption('--event <type>', 'the event type of the example')
    .action((id, options, cmd) => run(cmd, (ctx) => sendTest(ctx, id, options.event)))

  webhooks
    .command('events')
    .description('List the event types you can send to a webhook')
    .action((_options, cmd) => run(cmd, events))
}
