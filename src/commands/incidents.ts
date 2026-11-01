import type { Command } from '@commander-js/extra-typings'
import type { Result } from '../context.ts'
import { genericTable, INCIDENT_COLUMNS } from '../output/human.ts'
import type { Run } from '../program.ts'
import { readAllPages } from './pages.ts'

export const registerIncidents = (program: Command, run: Run): void => {
  const incidents = program
    .command('incidents')
    .description('Incidents that paused an action on one of your devices')

  incidents
    .command('list')
    .description('List open incidents and those closed within 30 days')
    .action((_options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const { items, requestId } = await readAllPages(ctx, '/partner/incidents')
        const text =
          items.length === 0 ? 'No incidents.' : genericTable(items, ctx.out, INCIDENT_COLUMNS)
        return { data: items, meta: { requestId }, text }
      }),
    )
}
