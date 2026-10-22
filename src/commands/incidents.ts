import type { Command } from '@commander-js/extra-typings'
import type { Result } from '../context.ts'
import { genericTable, INCIDENT_COLUMNS } from '../output/human.ts'
import type { Run } from '../program.ts'

export const registerIncidents = (program: Command, run: Run): void => {
  const incidents = program
    .command('incidents')
    .description('Incidents that paused an action on one of your devices')

  incidents
    .command('list')
    .description('List open incidents and those closed within 30 days')
    .action((_options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const response = await ctx.callInOrg({ method: 'GET', path: '/partner/incidents' })
        const items = Array.isArray(response.data) ? response.data : []
        const text =
          items.length === 0 ? 'No incidents.' : genericTable(items, ctx.out, INCIDENT_COLUMNS)
        return { data: response.data, meta: { requestId: response.requestId }, text }
      }),
    )
}
