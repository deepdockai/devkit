import { createInterface } from 'node:readline'
import type { Runtime } from '../runtime.ts'

const ask = (rt: Runtime, prompt: string): Promise<string> =>
  new Promise((resolve) => {
    // The prompt goes to stderr so stdout stays data.
    const rl = createInterface({ input: rt.stdin.stream, output: undefined, terminal: false })
    rt.stderr.write(prompt)
    let settled = false
    rl.once('line', (line) => {
      settled = true
      rl.close()
      resolve(line.trim())
    })
    rl.once('close', () => {
      if (!settled) resolve('')
    })
  })

export const confirm = async (rt: Runtime, question: string): Promise<boolean> => {
  const answer = await ask(rt, `${question} [y/N]: `)
  return /^y(es)?$/i.test(answer)
}

/** Asks for a number from a printed list; an empty answer takes the default (1-based). */
export const pickIndex = async (
  rt: Runtime,
  count: number,
  defaultIndex: number,
): Promise<number | undefined> => {
  const answer = await ask(rt, `Number [${defaultIndex}]: `)
  const chosen = answer === '' ? defaultIndex : Number.parseInt(answer, 10)
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > count) return undefined
  return chosen
}
