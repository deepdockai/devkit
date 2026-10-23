import type { Runtime } from '../runtime.ts'

const isSet = (value: string | undefined): boolean =>
  value !== undefined && !['', '0', 'false'].includes(value.toLowerCase())

/**
 * Whether the approval page may be opened for the person. Callers reach this only on a terminal
 * without --json. The link is always printed as well, so a skipped open loses nothing.
 */
export const browserAllowed = (rt: Runtime, noBrowser: boolean): boolean => {
  if (noBrowser || isSet(rt.env.DEEPDOCK_NO_BROWSER) || isSet(rt.env.CI)) return false
  // xdg-open without a display session either fails or starts a text browser inside the terminal.
  // open and rundll32 would start a browser on the remote machine's own screen.
  if (isSet(rt.env.SSH_CONNECTION) && rt.platform !== 'linux') return false
  if (rt.platform === 'linux' && !rt.env.DISPLAY && !rt.env.WAYLAND_DISPLAY) return false
  return true
}
