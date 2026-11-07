import { CliError } from '../api/errors.ts'
import type { Ctx } from '../context.ts'
import { isRecord } from '../output/human.ts'

/** The largest page the API serves (`limit` is 1 to 500). */
const PAGE_LIMIT = 500
/** A safety bound on the loop: 200 pages of 500 is 100000 rows, far past any organisation. */
export const MAX_PAGES = 200

export type Paged = { items: unknown[]; requestId: string | undefined }

const unreadable = (): CliError =>
  new CliError({
    code: 'connection_lost',
    message: 'The API answered a list in a shape this CLI does not read.',
    hint: 'Update the CLI with `npm install -g @deepdockai/cli@latest`, then retry.',
  })

/**
 * Reads a paged list (`{ items, nextCursor }`) to its end, following `nextCursor` so no row stays
 * invisible. Stops after {@link MAX_PAGES} pages with a note on stderr; the rows read so far are
 * still returned.
 */
export const readAllPages = async (ctx: Ctx, path: string, org?: string): Promise<Paged> => {
  const items: unknown[] = []
  let cursor: string | null = null
  let requestId: string | undefined
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) })
    if (cursor !== null) query.set('cursor', cursor)
    const url = `${path}?${query.toString()}`
    const response = org
      ? await ctx.call({ method: 'GET', path: url, org })
      : await ctx.callInOrg({ method: 'GET', path: url })
    const data = response.data
    if (!isRecord(data) || !Array.isArray(data.items)) throw unreadable()
    const next = data.nextCursor
    if (next !== null && (typeof next !== 'string' || next === '')) throw unreadable()
    items.push(...data.items)
    requestId ??= response.requestId
    if (next === null) return { items, requestId }
    cursor = next
  }
  ctx.note(
    `Warning: stopped after ${MAX_PAGES} pages; the list is longer than the ${items.length} rows shown.`,
  )
  return { items, requestId }
}
