import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configPath, emptyConfig, loadConfig, updateConfig } from '../../src/config/store.ts'
import type { Runtime } from '../../src/runtime.ts'
import { execute, makeSandbox } from '../harness.ts'

const sandboxes: ReturnType<typeof makeSandbox>[] = []
const sandbox = (): ReturnType<typeof makeSandbox> => {
  const created = makeSandbox()
  sandboxes.push(created)
  return created
}
afterEach(() => {
  for (const item of sandboxes.splice(0)) item.cleanup()
})

const runtimeFor = (
  home: string,
  env: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
): Runtime => ({ env, homedir: home, platform }) as unknown as Runtime

// The path module is the host's, so expectations compare with the separators normalised: each case
// states its platform through the seam and holds on any host.
const slashed = (path: string): string => path.replaceAll('\\', '/')

describe('config path', () => {
  it('on Linux and macOS uses XDG_CONFIG_HOME, else ~/.config', () => {
    expect(slashed(configPath(runtimeFor('/home/a', { XDG_CONFIG_HOME: '/x' }, 'linux')))).toBe(
      '/x/deepdock/config.json',
    )
    expect(slashed(configPath(runtimeFor('/home/a', {}, 'darwin')))).toBe(
      '/home/a/.config/deepdock/config.json',
    )
  })

  it('on Windows uses APPDATA and ignores XDG_CONFIG_HOME', () => {
    const withAppData = runtimeFor(
      'C:/Users/a',
      { APPDATA: 'C:/Users/a/AppData/Roaming', XDG_CONFIG_HOME: '/x' },
      'win32',
    )
    expect(slashed(configPath(withAppData))).toBe('C:/Users/a/AppData/Roaming/deepdock/config.json')
    expect(slashed(configPath(runtimeFor('C:/Users/a', {}, 'win32')))).toBe(
      'C:/Users/a/AppData/Roaming/deepdock/config.json',
    )
  })
})

describe('config store', () => {
  it('writes the file mode 600 in a mode 700 directory and leaves no temp file', async () => {
    const box = sandbox()
    const rt = runtimeFor(box.home)
    await updateConfig(rt, (config) => {
      config.defaultOrg = 'muster-it'
    })
    const path = configPath(rt)
    // Windows has no POSIX modes; the README says what protects the file there.
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    }
    expect(readdirSync(dirname(path))).toEqual(['config.json'])
    expect((await loadConfig(rt)).defaultOrg).toBe('muster-it')
  })

  it('replaces an existing file atomically with mode 600', async () => {
    const box = sandbox()
    const rt = runtimeFor(box.home)
    await updateConfig(rt, () => undefined)
    await updateConfig(rt, (config) => {
      config.defaultOrg = 'second'
    })
    expect((await loadConfig(rt)).defaultOrg).toBe('second')
    expect(readdirSync(dirname(configPath(rt)))).toEqual(['config.json'])
  })

  it('reads a missing file as empty', async () => {
    const box = sandbox()
    expect(await loadConfig(runtimeFor(box.home))).toEqual(emptyConfig())
  })

  it('on win32 a file that looks world readable is read without complaint', async () => {
    const box = sandbox()
    const rt = runtimeFor(box.home, { APPDATA: join(box.home, 'AppData') }, 'win32')
    await updateConfig(rt, (config) => {
      config.defaultOrg = 'windows'
    })
    // Windows reports 0666 for every file; whatever the host says, the seam decides.
    if (process.platform !== 'win32') chmodSync(configPath(rt), 0o666)
    expect((await loadConfig(rt)).defaultOrg).toBe('windows')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a group or world readable file and names the chmod',
    async () => {
      const box = sandbox()
      const rt = runtimeFor(box.home)
      await updateConfig(rt, () => undefined)
      chmodSync(configPath(rt), 0o644)
      await expect(loadConfig(rt)).rejects.toMatchObject({
        code: 'invalid_usage',
        hint: expect.stringContaining('chmod 600'),
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'a command fails with exit 1 on such a file',
    async () => {
      const box = sandbox()
      mkdirSync(dirname(box.configFile), { recursive: true })
      writeFileSync(box.configFile, '{}', { mode: 0o644 })
      chmodSync(box.configFile, 0o644)
      const outcome = await execute(box, ['auth', 'status', '--json'])
      expect(outcome.code).toBe(1)
      expect(JSON.parse(outcome.stderr).meta.hint).toContain('chmod 600')
    },
  )

  it('reports a broken file without echoing its contents', async () => {
    const box = sandbox()
    const rt = runtimeFor(box.home)
    mkdirSync(dirname(configPath(rt)), { recursive: true })
    writeFileSync(configPath(rt), 'not json {secret-ish}', { mode: 0o600 })
    const error = await loadConfig(rt).catch((caught: Error) => caught)
    expect(String((error as Error).message)).not.toContain('secret-ish')
    expect(existsSync(configPath(rt))).toBe(true)
  })

  it('drops unknown or malformed entries when reading', async () => {
    const box = sandbox()
    const rt = runtimeFor(box.home)
    mkdirSync(dirname(configPath(rt)), { recursive: true })
    writeFileSync(
      configPath(rt),
      JSON.stringify({
        keys: [{ id: 1 }, 'x'],
        pending: [{ kind: 'other' }],
        extra: true,
        defaultOrg: 'a',
      }),
      { mode: 0o600 },
    )
    expect(await loadConfig(rt)).toEqual({ keys: [], pending: [], defaultOrg: 'a' })
  })
})

describe('config store locking', () => {
  it('keeps both ledger entries when two saves run at once', async () => {
    const box = sandbox()
    const rt = { ...runtimeFor(box.home), now: () => new Date() } as Runtime
    const entry = (id: string) => ({
      org: 'muster-it',
      id,
      name: id,
      prefix: 'ddk_test_x',
      expiresAt: 'x',
      file: '/tmp/f',
      variable: 'DEEPDOCK_API_KEY',
    })
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
        updateConfig(rt, (config) => {
          config.keys.push(entry(id))
        }),
      ),
    )
    const ids = (await loadConfig(rt)).keys.map((key) => key.id).sort()
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(readdirSync(dirname(configPath(rt))).sort()).toEqual(['config.json'])
  })

  it('re-reads inside the lock, so a change made by another writer is merged, not overwritten', async () => {
    const box = sandbox()
    const rt = { ...runtimeFor(box.home), now: () => new Date() } as Runtime
    await updateConfig(rt, (config) => {
      config.defaultOrg = 'first'
    })
    await updateConfig(rt, (config) => {
      config.lastNoticeOn = '2026-10-21'
    })
    expect(await loadConfig(rt)).toMatchObject({ defaultOrg: 'first', lastNoticeOn: '2026-10-21' })
  })

  it.skipIf(process.platform === 'win32')(
    'steals a lock older than 30 seconds and not a fresh one',
    async () => {
      const box = sandbox()
      const rt = { ...runtimeFor(box.home), now: () => new Date() } as Runtime
      await updateConfig(rt, () => undefined)
      const lock = `${configPath(rt)}.lock`
      writeFileSync(lock, 'dead-process')
      const old = new Date(Date.now() - 60_000)
      utimesSync(lock, old, old)
      await updateConfig(rt, (config) => {
        config.defaultOrg = 'after-steal'
      })
      expect((await loadConfig(rt)).defaultOrg).toBe('after-steal')
      expect(existsSync(lock)).toBe(false)
    },
  )

  it('leaves no temporary file behind when the update fails', async () => {
    const box = sandbox()
    const rt = { ...runtimeFor(box.home), now: () => new Date() } as Runtime
    mkdirSync(configPath(rt), { recursive: true })
    await expect(updateConfig(rt, () => undefined)).rejects.toBeDefined()
    expect(readdirSync(dirname(configPath(rt))).sort()).toEqual(['config.json'])
  })

  it('refuses a relative XDG_CONFIG_HOME', () => {
    expect(() =>
      configPath(runtimeFor('/home/a', { XDG_CONFIG_HOME: 'relative/dir' }, 'linux')),
    ).toThrow('absolute path')
  })
})
