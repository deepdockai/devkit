import type { Command } from '@commander-js/extra-typings'
import { CliError, usageError } from '../api/errors.ts'
import type { ApiRequest, ApiResponse } from '../api/client.ts'
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
  type Columns,
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

const WRITE_ENV = `write ${WEBHOOK_SECRET_VARIABLE}=<secret> into this env file`

const collect = (value: string, previous: string[]): string[] => [...previous, value]

const EVENT_TYPES_PATH = '/partner/webhook-event-types'
const WEBHOOKS_PATH = '/partner/webhooks'

const UNAVAILABLE_MESSAGE =
  'Webhooks are not available for this organisation yet: Deepdock has not assigned it a trigger.'

const unavailable = (error: CliError): CliError =>
  new CliError({
    code: 'not_found',
    message: UNAVAILABLE_MESSAGE,
    hint: 'Ask Deepdock to assign the triggers you need; these commands work from the first one.',
    raw: { ...error.raw, message: UNAVAILABLE_MESSAGE },
    requestId: error.requestId,
    status: error.status,
  })

const NOT_AN_EVENT_TYPE = /^eventTypes\[(\d+)\]$/

/** The refusal of an event type the organisation cannot use, naming the type; undefined for any other 422. */
const unusableEventTypes = (error: CliError, sent: unknown): CliError | undefined => {
  const fields = Array.isArray(error.raw.fields) ? error.raw.fields : []
  const types = isRecord(sent) && Array.isArray(sent.eventTypes) ? sent.eventTypes : []
  const named = fields.flatMap((entry: unknown) => {
    const index = isRecord(entry) ? NOT_AN_EVENT_TYPE.exec(String(entry.field))?.[1] : undefined
    const type = index === undefined ? undefined : types[Number(index)]
    return typeof type === 'string' && isRecord(entry) && entry.message === 'is not an event type'
      ? [stripControl(type)]
      : []
  })
  if (named.length === 0) return undefined
  const message = `Not an event type of this organisation: ${named.join(', ')}. It does not exist, or its trigger is not assigned to this organisation.`
  return new CliError({
    code: error.code,
    message,
    hint: 'Run `deepdock webhooks events` for the types you can use; ask Deepdock to assign a trigger.',
    raw: { ...error.raw, message },
    requestId: error.requestId,
    status: error.status,
    refusedBy: 'api',
  })
}

/**
 * Every call of a webhook command: the API answers 404 on all webhook routes until a trigger is
 * assigned to the organisation, which is told apart from "no such webhook" by asking the event
 * types, a route every role may read; and a 422 for an unusable event type is named.
 */
const webhookCall = async (
  ctx: Ctx,
  req: Omit<ApiRequest, 'secret' | 'org'>,
): Promise<ApiResponse> => {
  try {
    return await ctx.callInOrg(req)
  } catch (error) {
    if (!(error instanceof CliError)) throw error
    if (error.code === 'invalid_input') {
      throw unusableEventTypes(error, req.body) ?? new CliError({ ...error, refusedBy: 'api' })
    }
    if (error.status !== 404 || error.code !== 'not_found') throw error
    if (req.path === EVENT_TYPES_PATH || req.path === WEBHOOKS_PATH) throw unavailable(error)
    const probe = await ctx.callInOrg({ method: 'GET', path: EVENT_TYPES_PATH }).then(
      () => false,
      (failure: unknown) => failure instanceof CliError && failure.status === 404,
    )
    throw probe ? unavailable(error) : error
  }
}

const route = (webhookId: string, tail = ''): string => `${WEBHOOKS_PATH}/${webhookId}${tail}`

const answer = (response: ApiResponse, text: string): Result => ({
  data: response.data,
  meta: { requestId: response.requestId },
  text,
})

/** The event types a command sends, or undefined when it names none; never an empty list. */
const eventTypesOf = async (ctx: Ctx, flags: EventFlags): Promise<string[] | undefined> => {
  if (flags.allEvents && flags.event.length > 0) {
    throw usageError('Use --event or --all-events, not both.')
  }
  if (!flags.allEvents) return flags.event.length > 0 ? flags.event : undefined
  const response = await webhookCall(ctx, { method: 'GET', path: EVENT_TYPES_PATH })
  return (await parseAnswer('eventTypes', response.data)).map((entry) => entry.type)
}

/** Checked before anything is created or rotated, so a refused file leaves nothing behind. */
const secretFile = async (ctx: Ctx, file: string): Promise<string> => {
  const destination = await checkDestination(ctx.rt, file)
  if (destination.warning) ctx.note(destination.warning)
  const windows = windowsFileWarning(ctx.rt.platform, destination.path, configPath(ctx.rt))
  if (windows) ctx.note(windows)
  return destination.path
}

type Written = { file: string; name: string }

/**
 * Reads the endpoint's signing secret and writes it to `path`; it is in no stream and no store.
 * A failed write leaves the secret where it was: an admin can read it again.
 */
const deliverSecret = async (
  ctx: Ctx,
  webhookId: string,
  path: string,
): Promise<{ data: Record<string, unknown>; written: Written }> => {
  const response = await webhookCall(ctx, { method: 'GET', path: route(webhookId, '/secret') })
  const secret = await parseAnswer('webhookSecret', response.data)
  try {
    // Again right before the write: git's answer can change while the human or the API took their time.
    await checkDestination(ctx.rt, path)
    await writeEnvValue(path, WEBHOOK_SECRET_VARIABLE, secret.secret)
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
      secretCreatedAt: secret.createdAt,
      previousSecretExpiresAt: secret.previousExpiresAt,
    },
    written: { file: displayPath(ctx.rt, path), name: WEBHOOK_SECRET_VARIABLE },
  }
}

const writtenLine = ({ file, name }: Written): string =>
  `The signing secret was shown to nobody and this CLI keeps no copy; your code reads ${name} from ${file}.`

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

const listOf = async (ctx: Ctx, path: string, columns: Columns, empty: string): Promise<Result> => {
  const response = await webhookCall(ctx, { method: 'GET', path })
  const items = Array.isArray(response.data) ? response.data : []
  return answer(response, items.length === 0 ? empty : genericTable(items, ctx.out, columns))
}

const get = async (ctx: Ctx, id: string): Promise<Result> => {
  const response = await webhookCall(ctx, { method: 'GET', path: route(webhookIdArg(id)) })
  return answer(response, genericView(response.data, ctx.out, WEBHOOK_COLUMNS))
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
  const created = await webhookCall(ctx, {
    method: 'POST',
    path: WEBHOOKS_PATH,
    body: { url, eventTypes, description: options.description },
  })
  const id = isRecord(created.data) ? field(created.data, 'id') : ''
  const delivered = path === undefined ? undefined : await deliverSecret(ctx, id, path)
  return {
    data: created.data,
    meta: { requestId: created.requestId, written: delivered?.written },
    text: [
      `${paint(ctx.out, 'success', 'Created')} webhook ${id} for ${stripControl(url)}.`,
      delivered
        ? writtenLine(delivered.written)
        : `Its signing secret is not written anywhere yet: \`deepdock webhooks secret ${id} --write-env <file>\`.`,
    ].join('\n'),
  }
}

type UpdateOptions = EventFlags & { url?: string; description?: string }

const update = async (ctx: Ctx, id: string, options: UpdateOptions): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const eventTypes = await eventTypesOf(ctx, options)
  const body = { url: options.url, description: options.description, eventTypes }
  if (Object.values(body).every((value) => value === undefined)) {
    throw usageError('Nothing to change.', 'Pass --url, --description, --event or --all-events.')
  }
  const response = await webhookCall(ctx, { method: 'PATCH', path: route(webhookId), body })
  return answer(response, `${paint(ctx.out, 'success', 'Updated')} webhook ${webhookId}.`)
}

const remove = async (ctx: Ctx, id: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  await confirmed(
    ctx,
    'delete',
    `Delete webhook ${webhookId}?\nIts stored deliveries are deleted with it.`,
  )
  const response = await webhookCall(ctx, { method: 'DELETE', path: route(webhookId) })
  return answer(response, `${paint(ctx.out, 'success', 'Deleted')} webhook ${webhookId}.`)
}

const setActive = async (ctx: Ctx, id: string, change: 'disable' | 'enable'): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const response = await webhookCall(ctx, { method: 'POST', path: route(webhookId, `/${change}`) })
  const done = change === 'enable' ? 'Enabled' : 'Disabled'
  return answer(response, `${paint(ctx.out, 'success', done)} webhook ${webhookId}.`)
}

const writeSecret = async (
  ctx: Ctx,
  id: string,
  file: string,
  rotate: boolean,
): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const path = await secretFile(ctx, file)
  if (rotate) {
    await confirmed(
      ctx,
      'rotate',
      `Rotate the signing secret of webhook ${webhookId}?\nThe old secret keeps signing for 24 hours next to the new one; update your receiver within that time.`,
    )
    await webhookCall(ctx, { method: 'POST', path: route(webhookId, '/secret/rotate') })
  }
  const delivered = await deliverSecret(ctx, webhookId, path)
  const done = rotate ? 'Rotated the signing secret of' : 'Wrote the signing secret of'
  return {
    data: delivered.data,
    meta: { written: delivered.written },
    text: `${paint(ctx.out, 'success', done)} webhook ${webhookId}.\n${writtenLine(delivered.written)}`,
  }
}

const sendTest = async (ctx: Ctx, id: string, type: string): Promise<Result> => {
  const webhookId = webhookIdArg(id)
  const response = await webhookCall(ctx, {
    method: 'POST',
    path: route(webhookId, '/test'),
    body: { type },
  }).catch((error: unknown) => {
    if (error instanceof CliError && error.code === 'webhook_disabled') {
      error.hint = `Run \`deepdock webhooks enable ${webhookId}\`, then send the example again.`
    }
    throw error
  })
  const attempt =
    isRecord(response.data) && isRecord(response.data.attempt) ? response.data.attempt : {}
  const outcome = field(attempt, 'outcome')
  const status = field(attempt, 'statusCode')
  return answer(
    response,
    [
      `Sent a test ${stripControl(type)} to webhook ${webhookId}: ${paint(ctx.out, outcome === 'succeeded' ? 'success' : 'warn', words(outcome))} (${status ? `HTTP ${status}` : 'no HTTP answer'}, ${field(attempt, 'durationMs')} ms).`,
      `Response body: ${stripControl(field(attempt, 'responseBody')) || '(empty)'}`,
      'The example is stored nowhere: it appears in no delivery list.',
    ].join('\n'),
  )
}

export const registerWebhooks = (program: Command, run: Run): void => {
  const webhooks = program
    .command('webhooks')
    .description('Webhook endpoints: where Deepdock sends a message when a device sees a change')

  webhooks
    .command('list')
    .description('List the webhooks of the organisation')
    .action((_options, cmd) =>
      run(cmd, (ctx) =>
        listOf(
          ctx,
          WEBHOOKS_PATH,
          WEBHOOK_LIST_COLUMNS,
          'No webhooks. Create one with `deepdock webhooks create <url> --all-events`.',
        ),
      ),
    )

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
    .option('--write-env <file>', WRITE_ENV)
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

  for (const [change, description] of [
    ['disable', 'Stop sending to a webhook; its waiting deliveries are paused (admin)'],
    ['enable', 'Send to a disabled webhook again; its paused deliveries resume (admin)'],
  ] as const) {
    webhooks
      .command(change)
      .description(description)
      .argument('<id>', 'the webhook id')
      .action((id, _options, cmd) => run(cmd, (ctx) => setActive(ctx, id, change)))
  }

  webhooks
    .command('secret')
    .description('Write the signing secret of a webhook into an env file (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption('--write-env <file>', WRITE_ENV)
    .action((id, options, cmd) => run(cmd, (ctx) => writeSecret(ctx, id, options.writeEnv, false)))

  webhooks
    .command('rotate-secret')
    .description('Make a new signing secret and write it into an env file (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption('--write-env <file>', WRITE_ENV)
    .action((id, options, cmd) => run(cmd, (ctx) => writeSecret(ctx, id, options.writeEnv, true)))

  webhooks
    .command('test')
    .description('Send one example message to a webhook now and show the answer (admin)')
    .argument('<id>', 'the webhook id')
    .requiredOption('--event <type>', 'the event type of the example')
    .action((id, options, cmd) => run(cmd, (ctx) => sendTest(ctx, id, options.event)))

  webhooks
    .command('events')
    .description('List the event types you can send to a webhook')
    .action((_options, cmd) =>
      run(cmd, (ctx) =>
        listOf(
          ctx,
          EVENT_TYPES_PATH,
          EVENT_TYPE_COLUMNS,
          'No event types exist for your organisation yet.',
        ),
      ),
    )
}
