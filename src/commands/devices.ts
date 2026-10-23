import type { Command } from '@commander-js/extra-typings'
import { paint } from '../output/styles.ts'
import { usageError } from '../api/errors.ts'
import { deviceIdArg } from '../args.ts'
import type { Ctx, Result } from '../context.ts'
import { confirm } from '../output/confirm.ts'
import {
  countValue,
  DEVICE_SYSTEM_COLUMNS,
  deviceTable,
  field,
  genericView,
  isRecord,
  stripControl,
  systemsLabel,
} from '../output/human.ts'
import type { Run } from '../program.ts'

const meta = (requestId: string | undefined): { requestId?: string } =>
  requestId ? { requestId } : {}

const updateNotes = (ctx: Ctx, devices: unknown[]): void => {
  for (const device of devices.filter(isRecord)) {
    const update = field(device, 'updateAvailable')
    if (update) {
      const name = field(device, 'label') || field(device, 'id')
      ctx.note(
        ctx.err(
          'yellow',
          `${stripControl(name)}: update available (client ${stripControl(update)}).`,
        ),
      )
    }
  }
}

const list = async (ctx: Ctx): Promise<Result> => {
  const response = await ctx.callInOrg({ method: 'GET', path: '/partner/devices' })
  const devices = Array.isArray(response.data) ? response.data : []
  if (devices.length === 0) {
    return {
      data: response.data,
      meta: meta(response.requestId),
      text: 'No devices are paired. Pair one with `deepdock devices pair <code>`.',
    }
  }
  updateNotes(ctx, devices)
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: deviceTable(devices, ctx.rt.now(), ctx.out),
  }
}

const pair = async (ctx: Ctx, code: string, label: string | undefined): Promise<Result> => {
  if (label !== undefined && (label.length < 1 || label.length > 100)) {
    throw usageError('The label must be 1 to 100 characters.')
  }
  if (code.trim() === '') throw usageError('The pairing code is empty.')
  const response = await ctx.callInOrg({
    method: 'POST',
    path: '/partner/devices',
    body: label === undefined ? { code } : { code, label },
  })
  const device = isRecord(response.data) ? response.data : {}
  const id = field(device, 'id')
  const name = field(device, 'label')
  const lines = [
    `${paint(ctx.out, 'success', 'Paired')} device ${id}${name ? ` (${stripControl(name)})` : ''}.`,
  ]
  const status = field(device, 'status')
  if (status) lines.push(`  Status:   ${status}`)
  lines.push(`  Systems:  ${systemsLabel(device)}`)
  lines.push(`Next: \`deepdock devices systems ${id}\` shows its actions.`)
  return { data: response.data, meta: meta(response.requestId), text: lines.join('\n') }
}

const rename = async (ctx: Ctx, id: string, label: string): Promise<Result> => {
  const deviceId = deviceIdArg(id)
  if (label.length < 1 || label.length > 100) {
    throw usageError('The label must be 1 to 100 characters.')
  }
  const response = await ctx.callInOrg({
    method: 'PATCH',
    path: `/partner/devices/${deviceId}`,
    body: { label },
  })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: `${paint(ctx.out, 'success', 'Renamed')} device ${deviceId} to ${stripControl(label)}.`,
  }
}

const release = async (ctx: Ctx, id: string): Promise<Result> => {
  const deviceId = deviceIdArg(id)
  if (!ctx.opts.yes && !ctx.interactive) {
    throw usageError(
      'Releasing a device needs a confirmation and there is no terminal.',
      'Run it again with --yes.',
    )
  }
  const org = await ctx.resolveOrg()
  if (!ctx.opts.yes) {
    let label = ''
    try {
      const response = await ctx.call({ method: 'GET', path: '/partner/devices', org: org.slug })
      const found = Array.isArray(response.data)
        ? response.data.filter(isRecord).find((device) => field(device, 'id') === deviceId)
        : undefined
      label = found ? field(found, 'label') : ''
    } catch {
      // The label only decorates the question; the release itself reports real failures.
    }
    const named = label ? ` (${stripControl(label)})` : ''
    if (!(await confirm(ctx.rt, `Release device ${deviceId}${named}?`))) {
      throw usageError('Not released.', 'Nothing was changed.')
    }
  }
  const response = await ctx.call({
    method: 'DELETE',
    path: `/partner/devices/${deviceId}`,
    org: org.slug,
  })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: `${paint(ctx.out, 'success', 'Released')} device ${deviceId}.`,
  }
}

const renderSystems = (ctx: Ctx, data: unknown): string => {
  const text = genericView(data, ctx.out, DEVICE_SYSTEM_COLUMNS)
  if (text === '') return 'The device reports no systems.'
  const paused = countValue(data, 'paused')
  if (paused === 0) return text
  return [
    text,
    paused === 1 ? 'One action is paused.' : `${paused} actions are paused.`,
    'Only Deepdock resumes it; `deepdock incidents list` shows the incident.',
    'Your code gets 503 action_paused from it until then.',
  ].join('\n')
}

const systemsOf = async (ctx: Ctx, id: string): Promise<Result> => {
  const deviceId = deviceIdArg(id)
  const response = await ctx.callInOrg({
    method: 'GET',
    path: `/partner/devices/${deviceId}/systems`,
  })
  return {
    data: response.data,
    meta: meta(response.requestId),
    text: renderSystems(ctx, response.data),
  }
}

export const registerDevices = (program: Command, run: Run): void => {
  const devices = program.command('devices').description('Pair, list, rename and release devices')

  devices
    .command('list')
    .description('List the devices paired to the organisation')
    .action((_options, cmd) => run(cmd, list))

  devices
    .command('pair')
    .description('Pair a device with the code shown on its screen')
    .argument('<code>', 'the pairing code')
    .option('--label <text>', 'a label for the device, 1 to 100 characters')
    .action((code, options, cmd) => run(cmd, (ctx) => pair(ctx, code, options.label)))

  devices
    .command('rename')
    .description("Change a device's label")
    .argument('<id>', 'the full device id')
    .argument('<label>', 'the new label, 1 to 100 characters')
    .action((id, label, _options, cmd) => run(cmd, (ctx) => rename(ctx, id, label)))

  devices
    .command('release')
    .description('Release a device from the organisation (admin)')
    .argument('<id>', 'the full device id')
    .action((id, _options, cmd) => run(cmd, (ctx) => release(ctx, id)))

  devices
    .command('systems')
    .description('Show the systems a device runs and the state of their actions')
    .argument('<id>', 'the full device id')
    .action((id, _options, cmd) => run(cmd, (ctx) => systemsOf(ctx, id)))
}
