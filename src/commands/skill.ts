import { promises as fs } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from '@commander-js/extra-typings'
import { usageError } from '../api/errors.ts'
import type { Ctx, Result } from '../context.ts'
import type { Run } from '../program.ts'

const AGENTS = ['claude', 'codex', 'cursor'] as const
type Agent = (typeof AGENTS)[number]

const START = '<!-- deepdock-skill:start -->'
const END = '<!-- deepdock-skill:end -->'
const SHARED_REFERENCES = '.deepdock/references'

// dist/deepdock.js sits one level below the package root, src/commands/skill.ts two.
const locateSkill = async (): Promise<string> => {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, '..', 'skill'), join(here, '..', '..', 'skill')]) {
    try {
      await fs.access(join(candidate, 'SKILL.md'))
      return candidate
    } catch {
      // try the next candidate
    }
  }
  throw usageError('The skill files are missing from this installation.', 'Reinstall the CLI.')
}

const splitFrontmatter = (source: string): { description: string; body: string } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source)
  if (!match) return { description: 'Deepdock integration', body: source }
  const description = /^description:\s*(.+)$/m.exec(match[1] ?? '')?.[1]?.trim()
  return { description: description ?? 'Deepdock integration', body: match[2] ?? '' }
}

const copyDirectory = async (
  from: string,
  to: string,
  base: string,
  written: string[],
): Promise<void> => {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) await copyDirectory(source, target, base, written)
    else {
      await fs.copyFile(source, target)
      written.push(relative(base, target))
    }
  }
}

const writeFile = async (
  path: string,
  content: string,
  base: string,
  written: string[],
): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, content)
  written.push(relative(base, path))
}

const replaceBlock = (existing: string, block: string): string => {
  const start = existing.indexOf(START)
  const end = existing.indexOf(END)
  if (start !== -1 && end > start) {
    return `${existing.slice(0, start)}${block}${existing.slice(end + END.length)}`
  }
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${block}\n`
}

const install = async (
  ctx: Ctx,
  agent: Agent,
  skillDir: string,
  written: string[],
): Promise<void> => {
  const base = ctx.rt.cwd
  if (agent === 'claude') {
    const target = join(base, '.claude', 'skills', 'deepdock')
    await fs.mkdir(target, { recursive: true })
    await writeFile(
      join(target, 'SKILL.md'),
      await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8'),
      base,
      written,
    )
    await copyDirectory(join(skillDir, 'references'), join(target, 'references'), base, written)
    return
  }
  const source = await fs.readFile(join(skillDir, 'SKILL.md'), 'utf8')
  const { description, body } = splitFrontmatter(source)
  const text = body.replaceAll('](references/', `](${SHARED_REFERENCES}/`)
  await copyDirectory(join(skillDir, 'references'), join(base, SHARED_REFERENCES), base, written)
  if (agent === 'codex') {
    const path = join(base, 'AGENTS.md')
    let existing = ''
    try {
      existing = await fs.readFile(path, 'utf8')
    } catch {
      // a new AGENTS.md
    }
    const block = `${START}\n${text.trim()}\n${END}`
    await writeFile(path, replaceBlock(existing, block), base, written)
    return
  }
  const rule = `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${text.trim()}\n`
  await writeFile(join(base, '.cursor', 'rules', 'deepdock.mdc'), rule, base, written)
}

export const registerSkill = (program: Command, run: Run): void => {
  program
    .command('skill')
    .description('Install the Deepdock skill for your coding agent into the current directory')
    .option('--agent <agent>', 'claude, codex, cursor or all', 'all')
    .action((options, cmd) =>
      run(cmd, async (ctx): Promise<Result> => {
        const requested = options.agent
        if (requested !== 'all' && !AGENTS.some((agent) => agent === requested)) {
          throw usageError(
            `"${requested}" is not a known agent.`,
            'Use claude, codex, cursor or all.',
          )
        }
        const agents =
          requested === 'all' ? [...AGENTS] : AGENTS.filter((agent) => agent === requested)
        const skillDir = await locateSkill()
        const written: string[] = []
        for (const agent of agents) await install(ctx, agent, skillDir, written)
        const unique = [...new Set(written)]
        return {
          data: { agents, written: unique },
          text: [
            `Installed the Deepdock skill for ${agents.join(', ')}:`,
            ...unique.map((file) => `  ${file}`),
          ].join('\n'),
        }
      }),
    )
}
