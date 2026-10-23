import { CliError } from '../api/errors.ts'
import type { Config, OrgInfo } from './store.ts'

/** `onlyOne` is set when nothing was asked for and the person belongs to exactly one organisation. */
export type ResolvedOrg = { slug: string; name: string; role: string; onlyOne?: true }

export const selectableOrgs = (orgs: OrgInfo[]): ResolvedOrg[] =>
  orgs.flatMap((org) => (org.slug ? [{ slug: org.slug, name: org.name, role: org.role }] : []))

/** --org, then DEEPDOCK_ORG, then the stored default. */
export const requestedSlug = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  config: Config,
): string | undefined => flag || env.DEEPDOCK_ORG || config.defaultOrg || undefined

export const resolveOrg = (
  requested: string | undefined,
  orgs: OrgInfo[],
  fromStoredDefault = false,
): ResolvedOrg => {
  const choices = selectableOrgs(orgs)
  const slugs = choices.map((org) => org.slug)
  const [only] = choices
  if (!requested && only && choices.length === 1) return { ...only, onlyOne: true }
  if (!requested) {
    throw new CliError({
      code: 'org_required',
      message: 'No organisation chosen.',
      hint: 'Pass --org <slug> or run `deepdock org select`.',
      organisations: slugs,
    })
  }
  const found = choices.find((org) => org.slug === requested)
  if (!found) {
    throw new CliError({
      code: 'invalid_usage',
      message: `You are not a member of an organisation with the slug "${requested}".`,
      hint: fromStoredDefault
        ? 'That is your stored default. Run `deepdock org select` to choose another.'
        : undefined,
      organisations: slugs,
    })
  }
  return found
}
