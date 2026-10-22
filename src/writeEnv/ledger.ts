import { relative, sep } from 'node:path'
import type { Config, KeyEntry } from '../config/store.ts'
import type { Runtime } from '../runtime.ts'

export const addKey = (config: Config, entry: KeyEntry): void => {
  config.keys = [...config.keys.filter((existing) => existing.id !== entry.id), entry]
}

export const findKey = (config: Config, id: string): KeyEntry | undefined =>
  config.keys.find((entry) => entry.id === id)

export const removeKey = (config: Config, id: string): void => {
  config.keys = config.keys.filter((entry) => entry.id !== id)
}

/** The file as a person would type it: relative to here when it is below here, else absolute. */
export const displayPath = (rt: Runtime, file: string): string => {
  const rel = relative(rt.cwd, file)
  return rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || rel.includes(':') ? file : rel
}
