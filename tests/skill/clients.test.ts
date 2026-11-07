import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Deepdock } from '../../skill/references/clients/deepdock.ts'

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

describe('the bundled TypeScript client retry', () => {
  const busy = (retryAfter?: string): Response =>
    new Response(
      JSON.stringify({ error: { code: 'target_busy', message: 'busy', requestId: 'r1' } }),
      { status: 503, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } },
    )
  const ok = (): Response => Response.json({ data: { released: true } })

  const run = async (answers: Response[], options: { maxAttempts?: number } = {}) => {
    const waits: number[] = []
    let calls = 0
    const fetch = (async () => answers[calls++]) as unknown as typeof globalThis.fetch
    const dd = new Deepdock('ddk_test_canary', {
      fetch,
      sleep: async (ms) => void waits.push(ms),
      ...options,
    })
    return { dd, waits, calls: () => calls }
  }

  it('waits the Retry-After seconds between attempts and then succeeds', async () => {
    const t = await run([busy('2'), busy('0'), ok()])
    await t.dd.release('d1')
    expect(t.waits).toEqual([2000, 0])
    expect(t.calls()).toBe(3)
  })

  it('caps the wait, and uses one second without a usable header', async () => {
    const t = await run([busy('600'), busy('soon'), ok()])
    await t.dd.release('d1')
    expect(t.waits).toEqual([15_000, 1000])
  })

  it('throws target_busy with the header after the last attempt', async () => {
    const t = await run([busy('1'), busy('1'), busy('7')])
    await expect(t.dd.release('d1')).rejects.toMatchObject({
      code: 'target_busy',
      retryAfter: '7',
    })
    expect(t.calls()).toBe(3)
  })

  it('does not retry when maxAttempts is 1, nor any other code', async () => {
    const off = await run([busy('1')], { maxAttempts: 1 })
    await expect(off.dd.release('d1')).rejects.toMatchObject({ code: 'target_busy' })
    expect(off.calls()).toBe(1)

    const offline = new Response(
      JSON.stringify({ error: { code: 'device_offline', message: 'x' } }),
      { status: 503 },
    )
    const other = await run([offline])
    await expect(other.dd.release('d1')).rejects.toMatchObject({ code: 'device_offline' })
    expect(other.calls()).toBe(1)
  })

  it('defaults to a 35 s timeout', async () => {
    const seen: AbortSignal[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init.signal as AbortSignal)
      return ok()
    }) as unknown as typeof globalThis.fetch
    const spy = vi.spyOn(AbortSignal, 'timeout')
    await new Deepdock('ddk_test_canary', { fetch }).release('d1')
    expect(spy).toHaveBeenCalledWith(35_000)
    spy.mockRestore()
  })
})

describe('the data envelope in the bundled clients', () => {
  const answer = (body: unknown, status = 200): typeof globalThis.fetch =>
    (async () => Response.json(body, { status })) as unknown as typeof globalThis.fetch

  it('reads a many-read page from data and the top-level nextCursor, and one record from data', async () => {
    const page = await new Deepdock('ddk_test_canary', {
      fetch: answer({ data: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' }),
    }).read('d1', 's', 'a', {})
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], nextCursor: 'c2' })

    const last = await new Deepdock('ddk_test_canary', { fetch: answer({ data: [] }) }).read(
      'd1',
      's',
      'a',
      {},
    )
    expect(last.nextCursor).toBeNull()

    const record = await new Deepdock('ddk_test_canary', {
      fetch: answer({ data: { id: 1, lastName: 'Müller' } }),
    }).readOne('d1', 's', 'a', { id: 1 })
    expect(record).toEqual({ id: 1, lastName: 'Müller' })
  })

  it('throws a DeepdockError for a single-record read that finds nothing', async () => {
    const dd = new Deepdock('ddk_test_canary', {
      fetch: answer({ error: { code: 'not_found', message: 'No such record.' } }, 404),
    })
    await expect(dd.readOne('d1', 's', 'a', { id: 9 })).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
  })
})

describe('file actions in the bundled TypeScript client', () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
  const file = (headers: Record<string, string>, body: Uint8Array = pdf): Response =>
    new Response(body, { status: 200, headers })
  const client = (answers: Response[]) => {
    const sent: RequestInit[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      sent.push(init)
      return answers[sent.length - 1]
    }) as unknown as typeof globalThis.fetch
    return { dd: new Deepdock('ddk_test_canary', { fetch, sleep: async () => {} }), sent }
  }

  it('posts the inputs and returns the bytes, the type and the UTF-8 name', async () => {
    const t = client([
      file({
        'content-type': 'application/pdf',
        'content-length': '4',
        'content-disposition': `attachment; filename="Befund M_ller.pdf"; filename*=UTF-8''Befund%20M%C3%BCller.pdf`,
      }),
    ])
    const got = await t.dd.download('d1', 's', 'downloadDocument', { documentId: 7 })
    expect(got).toEqual({
      bytes: pdf,
      contentType: 'application/pdf',
      filename: 'Befund Müller.pdf',
    })
    expect(t.sent[0]).toMatchObject({ method: 'POST', body: '{"documentId":7}' })
  })

  it('falls back to the ASCII name, and to octet-stream without a type', async () => {
    const t = client([
      new Response(pdf, { headers: { 'content-disposition': 'attachment; filename="download"' } }),
    ])
    const got = await t.dd.download('d1', 's', 'a', {})
    expect(got.filename).toBe('download')
    expect(got.contentType).toBe('application/octet-stream')
  })

  it('fails a body that ends short of its Content-Length as a transport error', async () => {
    const t = client([file({ 'content-length': '9' })])
    await expect(t.dd.download('d1', 's', 'a', {})).rejects.toMatchObject({
      name: 'DeepdockTransportError',
      message: 'download ended at 4 of 9 bytes',
    })
  })

  it('throws the JSON refusal as a DeepdockError, retrying target_busy', async () => {
    const refusal = (code: string, status: number): Response =>
      Response.json({ error: { code, message: 'x' } }, { status })
    const t = client([refusal('target_busy', 503), refusal('not_found', 404)])
    await expect(t.dd.download('d1', 's', 'a', {})).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    })
    expect(t.sent).toHaveLength(2)
  })
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

  it.skipIf(python.status !== 0)(
    'retries 503 target_busy with Retry-After, then gives up, and times out after 35 s',
    () => {
      const run = spawnSync(
        'python3',
        [
          '-I',
          '-c',
          `import importlib.util, sys, types
class Stub:
    def __init__(self, **kw): self.headers = {}; self.n = 0; self.timeout = kw.get("timeout")
    def request(self, method, path, **kw):
        self.n += 1
        class R:
            status_code = 503; headers = {"retry-after": "2"}
            def json(self): return {"error": {"code": "target_busy", "message": "busy"}}
        return R()
sys.modules["httpx"] = types.SimpleNamespace(Client=Stub, Headers=dict, HTTPError=Exception)
spec = importlib.util.spec_from_file_location("deepdock", sys.argv[1])
mod = importlib.util.module_from_spec(spec); sys.modules["deepdock"] = mod; spec.loader.exec_module(mod)
waits = []
stub = Stub(); dd = mod.Deepdock("ddk_test_canary", client=stub, sleep=waits.append)
try:
    dd.write("d1", "s", "a", "create", "key-12345678", {})
except mod.DeepdockError as e:
    print(e.code, e.retry_after, stub.n, waits)
import inspect
print(inspect.signature(mod.Deepdock.__init__).parameters["timeout"].default)
`,
          pyClient,
        ],
        { encoding: 'utf8' },
      )
      expect(run.stderr).toBe('')
      expect(run.stdout.trim().replace(/\r\n/g, '\n')).toBe('target_busy 2 3 [2.0, 2.0]\n35.0')
    },
  )

  it.skipIf(python.status !== 0)(
    'downloads a file action: bytes, type and UTF-8 name; a short body or a refusal raises',
    () => {
      const run = spawnSync(
        'python3',
        [
          '-I',
          '-c',
          `import importlib.util, sys, types
class R:
    def __init__(self, status, headers, content=b"", body=None):
        self.status_code = status; self.headers = headers; self.content = content; self.body = body
    def json(self):
        if self.body is None: raise ValueError("not JSON")
        return self.body
class Stub:
    def __init__(self, **kw): self.headers = {}; self.answers = []; self.sent = []
    def request(self, method, path, **kw):
        self.sent.append((method, kw.get("json")))
        return self.answers.pop(0)
sys.modules["httpx"] = types.SimpleNamespace(Client=Stub, Headers=dict, HTTPError=Exception)
spec = importlib.util.spec_from_file_location("deepdock", sys.argv[1])
mod = importlib.util.module_from_spec(spec); sys.modules["deepdock"] = mod; spec.loader.exec_module(mod)
stub = Stub(); dd = mod.Deepdock("ddk_test_canary", client=stub, sleep=lambda s: None)
stub.answers = [R(200, {"content-type": "application/pdf", "content-length": "4",
    "content-disposition": "attachment; filename=\\"Befund M_ller.pdf\\"; filename*=UTF-8''Befund%20M%C3%BCller.pdf"}, b"%PDF")]
d = dd.download("d1", "s", "downloadDocument", {"documentId": 7})
print(d.content, d.content_type, ascii(d.filename), stub.sent[0])
stub.answers = [R(200, {"content-length": "9"}, b"%PDF")]
try:
    dd.download("d1", "s", "a", {})
except mod.DeepdockTransportError as e:
    print(e)
stub.answers = [R(503, {}, body={"error": {"code": "target_busy", "message": "x"}}),
                R(404, {}, body={"error": {"code": "not_found", "message": "x"}})]
try:
    dd.download("d1", "s", "a", {})
except mod.DeepdockError as e:
    print(e.code, len(stub.answers))
`,
          pyClient,
        ],
        { encoding: 'utf8' },
      )
      expect(run.stderr).toBe('')
      expect(run.stdout.trim().replace(/\r\n/g, '\n')).toBe(
        [
          "b'%PDF' application/pdf 'Befund M\\xfcller.pdf' ('POST', {'documentId': 7})",
          'download ended at 4 of 9 bytes',
          'not_found 0',
        ].join('\n'),
      )
    },
  )
})
