import type { CliError } from '../api/errors.ts'

export type OrgRef = { slug: string; name: string }

export type Meta = {
  org?: OrgRef
  requestId?: string
  hint?: string
  written?: { file: string; name: string }
  organisations?: string[]
}

export type SuccessDoc = { data: unknown; meta: Meta }
export type ErrorDoc = { error: Record<string, unknown>; meta: Meta }

export const successDoc = (data: unknown, meta: Meta = {}): SuccessDoc => ({ data, meta })

export const errorDoc = (error: CliError, org: OrgRef | undefined): ErrorDoc => {
  const meta: Meta = {}
  if (org) meta.org = org
  if (error.organisations) meta.organisations = error.organisations
  if (error.hint) meta.hint = error.hint
  return { error: error.raw, meta }
}

export const toLine = (doc: SuccessDoc | ErrorDoc): string => `${JSON.stringify(doc)}\n`
