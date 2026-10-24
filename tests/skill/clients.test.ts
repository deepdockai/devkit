import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const client = fileURLToPath(new URL('../../skill/references/clients/deepdock.ts', import.meta.url))

describe('the bundled TypeScript client', () => {
  // `node` from PATH, since this suite also runs on Bun.
  it('loads under plain Node type stripping and takes its base URL from DEEPDOCK_BASE_URL', () => {
    const run = spawnSync(
      'node',
      [
        '--experimental-strip-types',
        '--no-warnings',
        '--input-type=module',
        '-e',
        `const { Deepdock } = await import(${JSON.stringify(client)})
const fetch = async (url) => { console.log(url); return Response.json({ data: { released: true } }) }
await new Deepdock('ddk_test_canary', { fetch }).release('d1')`,
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, DEEPDOCK_BASE_URL: 'https://api.example.test/' },
      },
    )
    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('https://api.example.test/v1/devices/d1')
  })
})
