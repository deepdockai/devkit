import { styleText } from 'node:util'
import type { OutStream, Runtime } from '../runtime.ts'

export type StyleName = 'dim' | 'bold' | 'green' | 'yellow' | 'red'

export type Styler = (name: StyleName, text: string) => string

/**
 * Colour is on for a terminal stream, or when FORCE_COLOR asks for it (anything but empty or 0),
 * and never when NO_COLOR is set or TERM is dumb.
 */
export const makeStyler = (rt: Runtime, stream: OutStream): Styler => {
  const forced = rt.env.FORCE_COLOR !== undefined && !['', '0'].includes(rt.env.FORCE_COLOR)
  const enabled = (stream.isTTY || forced) && !rt.env.NO_COLOR && rt.env.TERM !== 'dumb'
  return (name: StyleName, text: string): string =>
    enabled ? styleText(name, text, { validateStream: false }) : text
}
