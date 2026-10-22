import { promises as fs } from 'node:fs'
import { CliError } from './api/errors.ts'

// On Windows a rename onto a file another program has open fails with EPERM, EBUSY or EACCES for
// a moment (an editor, a dev server watching the file, a virus scanner). The same retry is cheap
// everywhere, so there is no platform branch.
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const TRIES = 8
const FIRST_DELAY_MS = 25
const MAX_DELAY_MS = 200

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Renames `from` over `to`, retrying for about a second while the target is busy. */
export const renameWithRetry = async (from: string, to: string): Promise<void> => {
  let delay = FIRST_DELAY_MS
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (!BUSY_CODES.has(code)) throw error
      if (attempt >= TRIES) {
        throw new CliError({
          code: 'internal_error',
          message: `Could not replace ${to}: another program has it open.`,
          hint: 'Close the program that has it open (a dev server watching it, for example) and try again.',
        })
      }
      await pause(delay)
      delay = Math.min(delay * 2, MAX_DELAY_MS)
    }
  }
}
