import type { Command } from '@commander-js/extra-typings'
import { CliError, usageError } from '../api/errors.ts'
import { parseAnswer } from '../api/schemas.ts'
import { requestedSlug, selectableOrgs } from '../config/orgSelection.ts'
import type { Ctx, Result } from '../context.ts'
import { pickIndex } from '../output/confirm.ts'
import { renderTable } from '../output/human.ts'
import type { Run } from '../program.ts'

const list = async (ctx: Ctx): Promise<Result> => {
  const response = await ctx.call({ method: 'GET', path: '/partner/orgs' })
  const orgs = await parseAnswer('orgs', response.data)
  const config = await ctx.update((current) => {
    current.organisations = orgs
  })
  const defaultOrg = requestedSlug(ctx.opts.org, ctx.rt.env, config)
  const text =
    orgs.length === 0
      ? 'You are not a member of an organisation yet.'
      : renderTable(
          ['SLUG', 'NAME', 'ROLE', 'DEFAULT'],
          orgs.map((org) => [
            org.slug ?? '(no slug)',
            org.name,
            org.role,
            org.slug !== null && org.slug === defaultOrg ? 'yes' : '',
          ]),
          ctx.out,
        )
  return {
    data: response.data,
    meta: response.requestId ? { requestId: response.requestId } : {},
    text,
  }
}

const select = async (ctx: Ctx, slug: string | undefined): Promise<Result> => {
  const response = await ctx.call({ method: 'GET', path: '/partner/orgs' })
  const orgs = await parseAnswer('orgs', response.data)
  const choices = selectableOrgs(orgs)
  const config = await ctx.config()
  const slugs = choices.map((org) => org.slug)

  let chosen = slug
  if (!chosen) {
    if (!ctx.interactive) {
      throw new CliError({
        code: 'invalid_usage',
        message: 'Choosing an organisation without a slug needs a terminal.',
        hint: 'Pass the slug: `deepdock org select <slug>`.',
        organisations: slugs,
      })
    }
    if (choices.length === 0) throw usageError('You are not a member of an organisation yet.')
    ctx.note('Which organisation should be the default?')
    choices.forEach((org, index) => {
      ctx.note(`  ${index + 1}  ${org.slug.padEnd(18)} ${org.name.padEnd(24)} ${org.role}`)
    })
    const current = Math.max(1, choices.findIndex((org) => org.slug === config.defaultOrg) + 1)
    const index = await pickIndex(ctx.rt, choices.length, current)
    if (index === undefined) throw usageError('That is not one of the numbers in the list.')
    chosen = choices[index - 1]?.slug
  }
  const found = choices.find((org) => org.slug === chosen)
  if (!found) {
    throw new CliError({
      code: 'invalid_usage',
      message: `You are not a member of an organisation with the slug "${chosen}".`,
      organisations: slugs,
    })
  }
  await ctx.update((current) => {
    current.organisations = orgs
    current.defaultOrg = found.slug
  })
  ctx.org = { slug: found.slug, name: found.name }
  return {
    data: { slug: found.slug, name: found.name, role: found.role },
    meta: response.requestId ? { requestId: response.requestId } : {},
    text: `Default organisation: ${found.name} (${found.slug}).`,
  }
}

export const registerOrg = (program: Command, run: Run): void => {
  const org = program
    .command('org')
    .description('List your organisations and choose the default one')

  org
    .command('list')
    .description('List the organisations you belong to')
    .action((_options, cmd) => run(cmd, list))

  org
    .command('select')
    .description('Choose the default organisation (a pick-list on a terminal without a slug)')
    .argument('[slug]', 'the organisation slug')
    .action((slug, _options, cmd) => run(cmd, (ctx) => select(ctx, slug)))
}
