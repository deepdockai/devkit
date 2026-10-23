import type { CommandUnknownOpts as Command } from '@commander-js/extra-typings'

export const ROOT_HELP = `Deepdock partner CLI: pair devices, see systems and actions, create the API key your code runs them with.

Usage
  deepdock <command> <subcommand> [arguments] [flags]

Commands
  auth        Sign in to Deepdock as yourself, see who is signed in, sign out
  org         List your organisations and choose the default one
  systems     The systems and actions assigned to your organisation
  devices     Pair, list, rename and release devices
  actions     List a device's actions and their fields
  keys        Create, list and revoke your organisation's API keys
  incidents   Incidents that paused an action on one of your devices
  skill       Install the Deepdock skill for your coding agent

Global flags
  --org <slug>      The organisation to act in (default: DEEPDOCK_ORG, then \`deepdock org select\`)
  --json            JSON output (the default when stdout is not a terminal)
  --yes             Answer the confirmation question of release and revoke with yes
  -h, --help        Help for a command
  -v, --version     Print the version

Examples
  $ deepdock auth login
  $ deepdock devices list --org muster-it
  $ deepdock actions list 450c3f0e-7a1b-4c2d-9e8f-1a2b3c4d5e6f example-erp --json

More
  Exit codes: \`deepdock help exit-codes\`. API reference per system: \`deepdock systems openapi <system>\`.
  Environment: DEEPDOCK_ORG, DEEPDOCK_BASE_URL, NO_COLOR, FORCE_COLOR.
  Actions run with an API key from your own code, never from this CLI: \`deepdock keys create --help\`.
`

export const AUTH_LOGIN_HELP = `Sign in to Deepdock as yourself.

Opens a link to the Deepdock dashboard. There you click Approve, and this CLI receives a
sign-in valid for 90 days. The sign-in is yours, not an organisation's: afterwards you choose
an organisation with --org or \`deepdock org select\`.

The sign-in manages devices, keys and settings and lists what a device offers. It never runs
an action; actions run from your code with an API key (\`deepdock keys create\`).

Usage
  deepdock auth login [flags]

The link is printed either way; opening the browser is a convenience that may fail silently.

Flags
  --no-wait           Print the request and exit; finish it later with --wait (the default
                      when there is no terminal)
  --wait <request>    Finish a request started with --no-wait

Examples
  $ deepdock auth login
  $ deepdock auth login --no-wait --json
  $ deepdock auth login --wait <request>

More
  \`deepdock auth status\` shows who is signed in (exit 5 when nobody is). \`deepdock auth logout\` revokes the sign-in and, unless you pass --keep-keys, the API keys this CLI created.
`

export const KEYS_CREATE_HELP = `Create an API key for your organisation (admin).

Opens a link to the Deepdock dashboard, where a human approves the key. The CLI receives the
key once, writes it into the env file named by --write-env, and keeps no copy. The value is
never printed and the CLI never uses it; your code reads it from that file.

A key reaches every device of the organisation until it expires or is revoked. Keep the
expiry short, and revoke a key you no longer need: \`deepdock keys revoke <id>\`. \`deepdock auth logout\`
revokes the keys this CLI created unless you pass --keep-keys.

Usage
  deepdock keys create <name> --expires <duration> --write-env <file> [flags]

Arguments
  <name>                A name that says what the key is for, e.g. "myapp dev"

Flags
  --expires <duration>  7d, 30d or 90d (required; 90 days is the maximum from the CLI)
  --write-env <file>    Write DEEPDOCK_API_KEY=<key> into this file (required). Inside a git
                        repository the file must be ignored and not tracked; outside one
                        the CLI warns
  --no-wait             Print the request and exit; finish it with --wait
  --wait <request>      Finish a request started with --no-wait

Examples
  $ deepdock keys create "myapp dev" --expires 30d --write-env .env.local
  $ deepdock keys create "myapp dev" --expires 30d --write-env .env.local --org muster-it --no-wait --json
`

export const EXIT_CODES_HELP = `Exit codes

  0  done
  1  usage: something on the command line to fix (invalid_usage, org_required)
  2  the API refused the request; do not repeat it unchanged
  3  retry later (device_offline, action_paused, system_unavailable, target_busy,
     temporarily_unavailable, internal_error, connection_lost)
  4  the CLI is too old for the API (client_outdated)
  5  sign-in needed (sign_in_needed, approval_denied, approval_expired; auth status when nobody is signed in)

With --json (or off a terminal) a failure is one JSON document on stderr:
{ "error": { "code", "message" }, "meta": { "hint" } }. Switch on \`code\`, never on \`message\`.
`

const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  'org select': ['deepdock org select muster-it'],
  'devices pair': ['deepdock devices pair K7Q-4MX --label "Demo PC"'],
  'devices release': ['deepdock devices release 450c3f0e-7a1b-4c2d-9e8f-1a2b3c4d5e6f --yes'],
  'actions list': ['deepdock actions list 450c3f0e-7a1b-4c2d-9e8f-1a2b3c4d5e6f example-erp'],
  'keys revoke': ['deepdock keys revoke <id> --yes'],
  skill: ['deepdock skill --agent claude'],
}

export const commandPath = (command: Command): string => {
  const names: string[] = []
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name())
  }
  return names.join(' ')
}

const pad = (rows: [string, string][]): string[] => {
  const width = Math.max(...rows.map(([left]) => left.length)) + 3
  return rows.map(([left, right]) => `  ${left.padEnd(width)}${right}`.trimEnd())
}

/** The layout of the hand-written helps above, derived from the command tree. */
export const formatHelp = (command: Command): string => {
  const path = commandPath(command)
  const help = command.createHelp()
  const subcommands = help.visibleCommands(command)
  const args = command.registeredArguments
  const options = help.visibleOptions(command).filter((option) => option.long !== '--help')
  const usageTail = [
    subcommands.length > 0 ? '<subcommand>' : '',
    ...args.map((arg) => (arg.required ? `<${arg.name()}>` : `[${arg.name()}]`)),
    options.length > 0 ? '[flags]' : '',
  ]
    .filter(Boolean)
    .join(' ')
  const sections: string[] = [
    command.description(),
    '',
    'Usage',
    `  deepdock ${path} ${usageTail}`.trimEnd(),
  ]
  if (subcommands.length > 0) {
    sections.push('', 'Commands', ...pad(subcommands.map((sub) => [sub.name(), sub.description()])))
  }
  if (args.length > 0) {
    sections.push(
      '',
      'Arguments',
      ...pad(
        args.map((arg) => [arg.required ? `<${arg.name()}>` : `[${arg.name()}]`, arg.description]),
      ),
    )
  }
  if (options.length > 0) {
    sections.push('', 'Flags', ...pad(options.map((option) => [option.flags, option.description])))
  }
  sections.push('', 'Global flags', '  --org <slug>   --json   --yes   -h, --help')
  const examples = EXAMPLES[path]
  if (examples) sections.push('', 'Examples', ...examples.map((example) => `  $ ${example}`))
  return `${sections.join('\n')}\n`
}
