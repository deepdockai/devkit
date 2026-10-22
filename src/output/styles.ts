import { styleText } from 'node:util'
import type { OutStream, Runtime } from '../runtime.ts'

export type StyleName = 'dim' | 'bold' | 'green' | 'yellow' | 'red'

export type Styler = (name: StyleName, text: string) => string

/** Colour is on only for a terminal stream, and never when NO_COLOR is set or TERM is dumb. */
export const makeStyler = (rt: Runtime, stream: OutStream): Styler => {
  const enabled = stream.isTTY && !rt.env.NO_COLOR && rt.env.TERM !== 'dumb'
  return (name: StyleName, text: string): string =>
    enabled ? styleText(name, text, { validateStream: false }) : text
}
