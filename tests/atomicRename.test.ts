import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../src/atomicRename.ts'
import { configPath, updateConfig } from '../src/config/store.ts'
import type { Runtime } from '../src/runtime.ts'
import { writeEnvValue } from '../src/writeEnv/writeEnv.ts'
import { makeSandbox, type Sandbox } from './harness.ts'

const KEY = ['ddk', 'test', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg'].join('_')
let box: Sandbox
beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => {
  vi.restoreAllMocks()
  box.cleanup()
})

const busy = (code: string): Error => Object.assign(new Error(`${code}: busy`), { code })

/** Makes the first `failures` renames fail with `code`, then lets the real one through. */
const failRename = (failures: number, code: string): { calls: () => number } => {
  const real = fs.rename.bind(fs)
  let calls = 0
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    calls += 1
    if (calls <= failures) throw busy(code)
    return real(from, to)
  })
  return { calls: () => calls }
}

describe('renameWithRetry', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    it(`retries ${code} and then succeeds`, async () => {
      const from = join(box.work, 'a')
      const to = join(box.work, 'b')
      writeFileSync(from, 'new')
      writeFileSync(to, 'old')
      const spy = failRename(3, code)
      await renameWithRetry(from, to)
      expect(spy.calls()).toBe(4)
      expect(readFileSync(to, 'utf8')).toBe('new')
    })
  }

  it('does not retry another error', async () => {
    const spy = failRename(5, 'ENOENT')
    await expect(renameWithRetry(join(box.work, 'x'), join(box.work, 'y'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(spy.calls()).toBe(1)
  })

  it('gives up after 8 tries within about a second, naming the file', async () => {
    const spy = failRename(100, 'EBUSY')
    const started = Date.now()
    const error = await renameWithRetry(join(box.work, 'x'), join(box.work, 'target.env')).catch(
      (caught: Error) => caught,
    )
    expect(spy.calls()).toBe(8)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(error).toMatchObject({ code: 'internal_error' })
    expect((error as Error).message).toContain('target.env')
    expect(String((error as { hint?: string }).hint)).toContain('Close the program')
  })
})

describe('the atomic writers use it', () => {
  it('--write-env retries a busy file and leaves no temp file', async () => {
    const target = join(box.work, '.env.local')
    failRename(2, 'EBUSY')
    await writeEnvValue(target, 'DEEPDOCK_API_KEY', KEY)
    expect(readFileSync(target, 'utf8')).toBe(`DEEPDOCK_API_KEY=${KEY}\n`)
    expect(readdirSync(box.work)).toEqual(['.env.local'])
  })

  it('--write-env fails clearly and removes its temp file when the target stays busy', async () => {
    const target = join(box.work, '.env.local')
    failRename(100, 'EPERM')
    const error = await writeEnvValue(target, 'DEEPDOCK_API_KEY', KEY).catch((e: Error) => e)
    expect((error as Error).message).toContain('.env.local')
    expect(readdirSync(box.work)).toEqual([])
    expect(String((error as Error).message)).not.toContain(KEY)
  })

  const runtime = (): Runtime =>
    ({
      env: {},
      homedir: box.home,
      platform: process.platform,
      now: () => new Date(),
    }) as unknown as Runtime

  it('the settings file retries a busy file', async () => {
    failRename(2, 'EACCES')
    await updateConfig(runtime(), (config) => {
      config.defaultOrg = 'retried'
    })
    expect(JSON.parse(readFileSync(configPath(runtime()), 'utf8')).defaultOrg).toBe('retried')
  })

  it('the settings file fails clearly and leaves only config.json and no temp file', async () => {
    mkdirSync(dirname(configPath(runtime())), { recursive: true })
    writeFileSync(configPath(runtime()), '{}', { mode: 0o600 })
    failRename(100, 'EBUSY')
    const error = await updateConfig(runtime(), () => undefined).catch((e: Error) => e)
    expect((error as Error).message).toContain('config.json')
    expect(readdirSync(dirname(configPath(runtime())))).toEqual(['config.json'])
  })
})
