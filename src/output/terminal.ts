import type { Runtime } from '../runtime.ts'

/**
 * The CLI's own terminal gate. A prompt library never decides: a question is asked only when a
 * person can see it and the output is not meant for a program.
 */
export const isInteractive = (rt: Runtime, json: boolean): boolean =>
  rt.stdin.isTTY && rt.stdout.isTTY && !json

/** JSON is the default off a terminal; --json forces it on one. */
export const wantsJson = (rt: Runtime, flag: boolean): boolean => flag || !rt.stdout.isTTY
