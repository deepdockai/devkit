import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

describe('the bundled Python client', () => {
  const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  const pyClient = fileURLToPath(
    new URL('../../skill/references/clients/deepdock.py', import.meta.url),
  )

  // httpx is stubbed so the check needs only the Python standard library.
  it.skipIf(python.status !== 0)(
    'sends a create with POST and an update with PATCH, and refuses any other operation',
    () => {
      const run = spawnSync(
        'python3',
        [
          '-I',
          '-c',
          `import importlib.util, sys, types
class Stub:
    def __init__(self, **kw): self.headers = {}; self.sent = []
    def request(self, method, path, **kw):
        self.sent.append(method)
        class R:
            status_code = 200; headers = {}
            def json(self): return {"data": {}}
        return R()
sys.modules["httpx"] = types.SimpleNamespace(Client=Stub, Headers=dict, HTTPError=Exception)
spec = importlib.util.spec_from_file_location("deepdock", sys.argv[1])
mod = importlib.util.module_from_spec(spec); sys.modules["deepdock"] = mod; spec.loader.exec_module(mod)
stub = Stub(); dd = mod.Deepdock("ddk_test_canary", client=stub)
dd.write("d1", "s", "a", "create", "key-12345678", {})
dd.write("d1", "s", "a", "update", "key-12345678", {})
try:
    dd.write("d1", "s", "a", "Update", "key-12345678", {})
except ValueError:
    print(",".join(stub.sent))
`,
          pyClient,
        ],
        { encoding: 'utf8' },
      )
      expect(run.stderr).toBe('')
      expect(run.stdout.trim()).toBe('POST,PATCH')
    },
  )
})
