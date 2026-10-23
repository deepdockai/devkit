import { homedir } from 'node:os'
import { runCli } from '../src/program.ts'
import { defaultRuntime } from '../src/runtime.ts'
import { splitTarget, targetEnv } from './devTargets.ts'

// Runs the CLI from source against one target: `bun scripts/dev.ts [--target <t>] <cli args>`.
// Works from any directory, since nothing here depends on the current one.
const split = splitTarget(process.argv.slice(2), process.env)
if ('error' in split) {
  process.stderr.write(`${split.error}\n`)
  process.exitCode = 2
} else {
  const env = targetEnv(split.target, {
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
  })
  Object.assign(process.env, env)
  process.stderr.write(
    `[dev] ${split.target}: ${env.DEEPDOCK_BASE_URL}, settings in ${env.DEEPDOCK_CONFIG_DIR}\n`,
  )
  process.exitCode = await runCli(split.rest, defaultRuntime())
}
