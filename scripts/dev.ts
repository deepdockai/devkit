import { homedir } from 'node:os'
import { runCli } from '../src/program.ts'
import { defaultRuntime } from '../src/runtime.ts'
import { devEnv, reportFailure } from './devEnv.ts'

// Runs the CLI from source: `bun scripts/dev.ts <cli args>`, against DEEPDOCK_BASE_URL or the
// production API. Nothing here depends on the current directory.
try {
  const env = devEnv({ env: process.env, platform: process.platform, homedir: homedir() })
  process.stderr.write(`[dev] ${env.DEEPDOCK_BASE_URL}, settings in ${env.DEEPDOCK_CONFIG_DIR}\n`)
  const rt = defaultRuntime()
  process.exitCode = await runCli(process.argv.slice(2), { ...rt, env: { ...rt.env, ...env } })
} catch (error) {
  reportFailure(error)
}
