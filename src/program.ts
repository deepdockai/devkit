import { Command, CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings'
import { CliError, usageError } from './api/errors.ts'
import { registerActions } from './commands/actions.ts'
import { registerAuth } from './commands/auth.ts'
import { registerDevices } from './commands/devices.ts'
import { registerIncidents } from './commands/incidents.ts'
import { registerKeys } from './commands/keys.ts'
import { registerOrg } from './commands/org.ts'
import { registerSkill } from './commands/skill.ts'
import { registerSystems } from './commands/systems.ts'
import { type Ctx, createContext, type GlobalOptions, type Result } from './context.ts'
import { commandPath, EXIT_CODES_HELP, formatHelp, ROOT_HELP } from './help.ts'
import type { Meta } from './output/envelope.ts'
import { errorDoc, successDoc, toLine } from './output/envelope.ts'
import { isRecord, stripControl } from './output/human.ts'
import { makeStyler } from './output/styles.ts'
import { wantsJson } from './output/terminal.ts'
import { updateNotice } from './output/updateNotice.ts'
import type { Runtime } from './runtime.ts'

export type Run = (
  cmd: { optsWithGlobals: () => unknown },
  handler: (ctx: Ctx) => Promise<Result>,
) => Promise<void>

type State = { ctx?: Ctx; exit?: number }

const readGlobals = (value: unknown): GlobalOptions => {
  const record = isRecord(value) ? value : {}
  return {
    org: typeof record.org === 'string' ? record.org : undefined,
    json: record.json === true,
    yes: record.yes === true,
  }
}

type TreeNode = {
  name: string
  description: string
  arguments: { name: string; required: boolean; description: string }[]
  options: { flags: string; description: string }[]
  commands: TreeNode[]
}

const treeOf = (command: CommandUnknownOpts): TreeNode => ({
  name: command.name(),
  description: command.description(),
  arguments: command.registeredArguments.map((arg) => ({
    name: arg.name(),
    required: arg.required,
    description: arg.description,
  })),
  options: command.options
    .filter((option) => !option.hidden)
    .map((option) => ({ flags: option.flags, description: option.description })),
  commands: command.commands
    .filter((sub) => !(sub as unknown as { _hidden?: boolean })._hidden)
    .map(treeOf),
})

const findCommand = (
  root: CommandUnknownOpts,
  tokens: string[],
): CommandUnknownOpts | undefined => {
  let current: CommandUnknownOpts = root
  for (const token of tokens) {
    const next = current.commands.find((sub) => sub.name() === token)
    if (!next) return undefined
    current = next
  }
  return current
}

const buildProgram = (rt: Runtime, state: State): Command => {
  const program = new Command('deepdock')
  program
    .exitOverride()
    .configureOutput({
      writeOut: (text: string): void => rt.stdout.write(text),
      writeErr: () => undefined,
      outputError: () => undefined,
    })
    .description('Deepdock partner CLI')
    .version(rt.version, '-v, --version', 'print the version')
    .addHelpCommand(false)
    .option('--org <slug>', 'the organisation to act in')
    .option('--json', 'JSON output (the default when stdout is not a terminal)')
    .option('--yes', 'answer the confirmation question of release and revoke with yes')

  const run: Run = async (cmd: Parameters<Run>[0], handler: Parameters<Run>[1]): Promise<void> => {
    const ctx = createContext(rt, readGlobals(cmd.optsWithGlobals()))
    state.ctx = ctx
    const result = await handler(ctx)
    state.exit = result.exit
    const meta: Meta = { ...(ctx.org ? { org: ctx.org } : {}), ...result.meta }
    if (meta.requestId === undefined) delete meta.requestId
    if (ctx.json) rt.stdout.write(toLine(successDoc(result.data, meta)))
    else rt.stdout.write(`${result.text}\n`)
    try {
      const config = await ctx.config()
      const notice = updateNotice(rt, config, ctx.api.latest(), ctx.json, ctx.err)
      if (notice) {
        rt.stderr.write(`${notice}\n`)
        await ctx.update((current) => {
          current.lastNoticeOn = config.lastNoticeOn
        })
      }
    } catch {
      // Fire-and-forget: the update notice must never fail a command that already succeeded.
    }
  }

  registerAuth(program, run)
  registerOrg(program, run)
  registerSystems(program, run)
  registerDevices(program, run)
  registerActions(program, run)
  registerKeys(program, run)
  registerIncidents(program, run)
  registerSkill(program, run)

  program
    .command('help')
    .description('Help for a command, or `help exit-codes`')
    .argument('[topic...]')
    .action((topic) => {
      if (topic.length === 1 && topic[0] === 'exit-codes') {
        rt.stdout.write(EXIT_CODES_HELP)
        return
      }
      const target = findCommand(program, topic)
      if (!target)
        throw usageError(`There is no help for "${topic.join(' ')}".`, 'Run `deepdock --help`.')
      rt.stdout.write(target.helpInformation())
    })

  program
    .command('commands', { hidden: true })
    .description('Print the command tree')
    .action((_options, cmd) =>
      run(cmd, async () => ({
        data: treeOf(program),
        text: JSON.stringify(treeOf(program), null, 2),
      })),
    )

  const customHelp = new Set(['', 'auth login', 'keys create'])
  const decorate = (command: CommandUnknownOpts): void => {
    if (!customHelp.has(commandPath(command)))
      command.helpInformation = (): string => formatHelp(command)
    for (const sub of command.commands) decorate(sub)
  }
  decorate(program)
  program.helpInformation = (): string => ROOT_HELP
  return program
}

const commanderToCliError = (
  error: CommanderError,
  program: CommandUnknownOpts,
  argv: string[],
): CliError => {
  const first = (error.message.split('\n')[0] ?? '').replace(/^error:\s*/, '')
  const suggestion = /\(Did you mean (.+?)\?\)/.exec(error.message)?.[1]
  let path = ''
  const walked: string[] = []
  for (const token of argv) {
    if (token.startsWith('-')) continue
    if (!findCommand(program, [...walked, token])) break
    walked.push(token)
  }
  path = walked.join(' ')
  const helpHint = `Run \`deepdock${path ? ` ${path}` : ''} --help\`.`
  const hint = suggestion ? `Did you mean ${suggestion}? ${helpHint}` : helpHint

  let message = first
  const unknownOption = /^unknown option '(.+)'$/.exec(first)
  const unknownCommand = /^unknown command '(.+)'$/.exec(first)
  const missingArgument = /^missing required argument '(.+)'$/.exec(first)
  const needsValue = /^option '(--[\w-]+)[^']*' argument missing$/.exec(first)
  if (error.code === 'commander.help') message = 'A command is required.'
  else if (unknownOption) message = `Unknown flag ${unknownOption[1]}.`
  else if (unknownCommand) message = `Unknown command ${unknownCommand[1]}.`
  else if (missingArgument) message = `Missing argument <${missingArgument[1]}>.`
  else if (needsValue) message = `The flag ${needsValue[1]} needs a value.`
  else if (first.startsWith('too many arguments')) message = 'Too many arguments.'
  else
    message = `${first.charAt(0).toUpperCase()}${first.slice(1)}${first.endsWith('.') ? '' : '.'}`
  return usageError(stripControl(message), hint)
}

const toCliError = (error: unknown, program: CommandUnknownOpts, argv: string[]): CliError => {
  if (error instanceof CliError) return error
  if (error instanceof CommanderError) return commanderToCliError(error, program, argv)
  const detail = error instanceof Error ? stripControl(error.message) : 'unknown failure'
  return new CliError({ code: 'internal_error', message: `Unexpected failure: ${detail}` })
}

const humanError = (rt: Runtime, error: CliError): string => {
  const style = makeStyler(rt, rt.stderr)
  const message = stripControl(error.message).replace(/\.$/, '')
  const body =
    error.code === 'invalid_input'
      ? `The device refused the input: "${message}" [${error.code}].`
      : `${message} [${error.code}].`
  const lines = [`${style('red', 'Error:')} ${body}`]
  const tail = [
    error.hint,
    error.organisations
      ? `Your organisations: ${error.organisations.join(', ') || '(none)'}.`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ')
  if (tail) lines.push(`  ${stripControl(tail)}`)
  if (error.requestId) lines.push(style('dim', `  Request id: ${stripControl(error.requestId)}`))
  return `${lines.join('\n')}\n`
}

/** Runs the CLI once and returns the exit code; every failure is reshaped into the error document. */
export const runCli = async (argv: string[], rt: Runtime): Promise<number> => {
  const state: State = {}
  const program = buildProgram(rt, state)
  try {
    await program.parseAsync(argv, { from: 'user' })
    return state.exit ?? 0
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return 0
    }
    const cliError = toCliError(error, program, argv)
    if (cliError.code === 'client_outdated') {
      cliError.hint = `Run \`npx @deepdockai/cli@latest ${argv.join(' ')}\`.`
    }
    const json = state.ctx?.json ?? wantsJson(rt, argv.includes('--json'))
    if (json) rt.stderr.write(toLine(errorDoc(cliError, state.ctx?.org)))
    else rt.stderr.write(humanError(rt, cliError))
    return cliError.exitCode
  }
}
