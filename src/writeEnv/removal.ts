import { CliError } from '../api/errors.ts'
import type { KeyEntry } from '../config/store.ts'
import type { Ctx } from '../context.ts'
import { stripControl } from '../output/human.ts'
import { displayPath, removeKey } from './ledger.ts'
import { removeEnvValue } from './writeEnv.ts'

/**
 * What happened to the env line of a key this CLI wrote: `done`, `absent` (the file or the line was
 * already gone, or holds another value) or `failed` (the file could not be read or rewritten, for
 * example a program holds it open). `reason` accompanies `failed` only.
 */
export type Removal = {
  file: string
  name: string
  removal: 'done' | 'absent' | 'failed'
  reason?: string
}

const reasonOf = (error: unknown): string => {
  if (error instanceof CliError) {
    return error.message.includes('another program has it open')
      ? 'another program has the file open'
      : stripControl(error.message)
  }
  if (error instanceof Error && 'code' in error) return `file error ${String(error.code)}`
  return 'unknown error'
}

const removeWrittenLine = async (ctx: Ctx, entry: KeyEntry): Promise<Removal> => {
  const base = { file: displayPath(ctx.rt, entry.file), name: entry.variable }
  try {
    const removed = await removeEnvValue(entry.file, entry.variable, entry.prefix)
    return { ...base, removal: removed ? 'done' : 'absent' }
  } catch (error) {
    return { ...base, removal: 'failed', reason: reasonOf(error) }
  }
}

export const failedRemovalWarning = (removal: Removal): string =>
  `Warning: could not remove ${removal.name} from ${removal.file} (${removal.reason}): the key is revoked, delete the line by hand.`

/** One wording for a removal, for the human summaries. */
export const describeRemoval = (removal: Removal): string => {
  if (removal.removal === 'done') return `removed the ${removal.name} line from ${removal.file}`
  if (removal.removal === 'failed') return `the ${removal.name} line is still in ${removal.file}`
  return `no ${removal.name} line of this key was found in ${removal.file}`
}

/**
 * Removes the env line of a key that has been revoked, then settles the ledger entry. A failure
 * is warned about once on stderr. `keepEntryOnFailure` keeps the entry so a later `keys revoke`
 * retries (it needs the sign-in anyway); `auth logout` clears local state instead and reports.
 */
export const settleWrittenLine = async (
  ctx: Ctx,
  entry: KeyEntry,
  keepEntryOnFailure: boolean,
): Promise<Removal> => {
  const removal = await removeWrittenLine(ctx, entry)
  if (removal.removal === 'failed') ctx.note(failedRemovalWarning(removal))
  if (removal.removal !== 'failed' || !keepEntryOnFailure) {
    await ctx.update((config) => removeKey(config, entry.id))
  }
  return removal
}
