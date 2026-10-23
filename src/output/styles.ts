import { styleText } from 'node:util'
import type { OutStream, Runtime } from '../runtime.ts'

const OSC = '\u001b]'
const ST = '\u001b\\'

export type StyleName = 'dim' | 'bold' | 'green' | 'yellow' | 'red' | 'link'

export type Role = 'warn' | 'error' | 'success' | 'emphasis' | 'quiet' | 'link'

/** The CLI's message roles; commands name a role, never a colour or an escape code. */
const ROLES: Record<Role, StyleName> = {
  warn: 'yellow',
  error: 'red',
  success: 'green',
  emphasis: 'bold',
  quiet: 'dim',
  link: 'link',
}

export type Styler = (name: StyleName, text: string) => string

/**
 * Colour is on for a terminal stream, or when FORCE_COLOR asks for it (anything but empty or 0),
 * and never when NO_COLOR is set or TERM is dumb.
 */
export const makeStyler = (rt: Runtime, stream: OutStream): Styler => {
  const forced = rt.env.FORCE_COLOR !== undefined && !['', '0'].includes(rt.env.FORCE_COLOR)
  const enabled = (stream.isTTY || forced) && !rt.env.NO_COLOR && rt.env.TERM !== 'dumb'
  return (name: StyleName, text: string): string => {
    if (!enabled) return text
    if (name !== 'link') return styleText(name, text, { validateStream: false })
    // OSC 8 makes the text clickable; the visible text stays the bare URL so copy-paste is intact.
    const styled = styleText(['blue', 'underline'], text, { validateStream: false })
    return `${OSC}8;;${text}${ST}${styled}${OSC}8;;${ST}`
  }
}

export const paint = (style: Styler, role: Role, text: string): string => style(ROLES[role], text)
