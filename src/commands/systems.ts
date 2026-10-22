import type { Command } from '@commander-js/extra-typings'
import { systemArg } from '../args.ts'
import type { Result } from '../context.ts'
import { genericTable, isRecord, SYSTEM_COLUMNS } from '../output/human.ts'
import type { Run } from '../program.ts'

export const registerSystems = (program: Command, run: Run): void => {
  const systems = program
    .command('systems')
    .description('The systems and actions assigned to your organisation')

  systems
    .command('list')
    .description('List the systems assigned to the organisation')
    .action((_options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const response = await ctx.callInOrg({ method: 'GET', path: '/partner/systems' })
        const items = Array.isArray(response.data) ? response.data : []
        const text =
          items.length === 0
            ? 'No systems are assigned to this organisation.'
            : genericTable(items, ctx.out, SYSTEM_COLUMNS)
        return { data: response.data, meta: { requestId: response.requestId }, text }
      }),
    )

  systems
    .command('openapi')
    .description("Print a system's OpenAPI document (redirect to keep it)")
    .argument('<system>', 'the system name')
    .action((system, _options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const name = systemArg(system)
        const response = await ctx.callInOrg({
          method: 'GET',
          path: `/partner/systems/${encodeURIComponent(name)}/openapi.json`,
        })
        const document = isRecord(response.data) ? response.data : {}
        return {
          data: response.data,
          meta: { requestId: response.requestId },
          text: JSON.stringify(document, null, 2),
        }
      }),
    )
}
