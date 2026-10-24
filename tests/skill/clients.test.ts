import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const client = fileURLToPath(new URL('../../skill/references/clients/deepdock.ts', import.meta.url))

describe('the bundled TypeScript client', () => {
  // Projects copy this file and run it with Node's type stripping, which refuses syntax that needs
  // a transform (parameter properties, enums). `node` from PATH, since this suite also runs on Bun.
  it('loads under plain Node type stripping', () => {
    const run = spawnSync(
      'node',
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(client)}); console.log(Object.keys(m).sort().join(','))`,
      ],
      { encoding: 'utf8' },
    )
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe(
      'CONFLICT_RETRIES,Deepdock,DeepdockError,DeepdockTransportError,attempt',
    )
  })
})
