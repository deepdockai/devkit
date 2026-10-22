import type { Command } from '@commander-js/extra-typings'
import { deviceIdArg, systemArg } from '../args.ts'
import type { Result } from '../context.ts'
import { ACTION_COLUMNS, genericView, isRecord } from '../output/human.ts'
import type { Run } from '../program.ts'

const fieldNames = (input: unknown): string => {
  if (!isRecord(input) || !isRecord(input.properties)) return ''
  const required = Array.isArray(input.required) ? input.required : []
  return Object.keys(input.properties)
    .map((name) => (required.includes(name) ? name : `${name} (optional)`))
    .join(', ')
}

// Name first, then a read/write kind and the field names when the action carries them, then
// whatever other scalar keys it has.
const actionRow = (action: Record<string, unknown>): Record<string, unknown> => {
  const method = typeof action.method === 'string' ? action.method : undefined
  const fields = fieldNames(action.input)
  const { name, method: _method, input: _input, output: _output, ...rest } = action
  return {
    ...(name === undefined ? {} : { name }),
    ...(method ? { kind: method.toUpperCase() === 'GET' ? 'read' : 'write' } : {}),
    ...(fields ? { fields } : {}),
    ...rest,
  }
}

export const registerActions = (program: Command, run: Run): void => {
  const actions = program.command('actions').description("List a device's actions and their fields")

  actions
    .command('list')
    .description('List the actions a device offers for a system, with every field')
    .argument('<device>', 'the full device id')
    .argument('<system>', 'the system name')
    .action((device, system, _options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const deviceId = deviceIdArg(device)
        const name = systemArg(system)
        const response = await ctx.callInOrg({
          method: 'GET',
          path: `/partner/devices/${deviceId}/systems/${encodeURIComponent(name)}/actions`,
        })
        const items =
          isRecord(response.data) && Array.isArray(response.data.actions)
            ? response.data.actions
            : Array.isArray(response.data)
              ? response.data
              : []
        const records = items.filter(isRecord)
        const text =
          records.length === 0
            ? 'The device offers no actions for this system.'
            : [
                genericView(records.map(actionRow), ctx.out, ACTION_COLUMNS),
                `Full schemas: \`deepdock actions list ${deviceId} ${name} --json\` or \`deepdock systems openapi ${name}\`.`,
                'Your code runs them with an API key: `deepdock keys create --help`.',
              ].join('\n')
        return { data: response.data, meta: { requestId: response.requestId }, text }
      }),
    )
}
