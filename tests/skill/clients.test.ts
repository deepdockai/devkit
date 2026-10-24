import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// A URL, not a path: Node's import() refuses a Windows drive-letter path.
const client = new URL('../../skill/references/clients/deepdock.ts', import.meta.url).href

describe('the bundled TypeScript client', () => {
  // A claim about Node, so it runs only in the Node suite, on the Node that runs it.
  it.skipIf('Bun' in globalThis)(
    'loads under Node type stripping and takes its base URL from DEEPDOCK_BASE_URL',
    () => {
      const run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--no-warnings',
          '--input-type=module',
          '-e',
          `const { Deepdock } = await import(${JSON.stringify(client)})
const fetch = async (url) => { console.log(url); return Response.json({ data: { released: true } }) }
await new Deepdock('ddk_test_canary', { fetch }).release('d1')`,
        ],
        { encoding: 'utf8', env: { DEEPDOCK_BASE_URL: 'https://api.example.test/' } },
      )
      expect(run.stderr).toBe('')
      expect(run.stdout.trim()).toBe('https://api.example.test/v1/devices/d1')
    },
  )
})
