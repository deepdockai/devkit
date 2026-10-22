import { runCli } from './program.ts'
import { defaultRuntime } from './runtime.ts'

// Set the exit code and let the event loop drain so a pending stdout write is not cut off.
process.exitCode = await runCli(process.argv.slice(2), defaultRuntime())
