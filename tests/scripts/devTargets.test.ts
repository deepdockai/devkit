import { describe, expect, it } from 'vitest'
import { splitTarget, TARGETS, targetEnv } from '../../scripts/devTargets.ts'

const slashed = (path: string): string => path.replaceAll('\\', '/')

describe('development targets', () => {
  it('maps each target to its API and its own settings directory', () => {
    const host = { env: {}, platform: 'linux' as const, homedir: '/home/a' }
    expect(targetEnv('staging', host)).toEqual({
      DEEPDOCK_BASE_URL: 'https://api.staging.deepdock.ai',
      DEEPDOCK_CONFIG_DIR: '/home/a/.config/deepdock-dev/staging',
    })
    expect(targetEnv('production', host).DEEPDOCK_BASE_URL).toBe('https://api.deepdock.ai')
    expect(targetEnv('local', host).DEEPDOCK_BASE_URL).toBe('http://localhost:8787')
    const dirs = new Set(TARGETS.map((target) => targetEnv(target, host).DEEPDOCK_CONFIG_DIR))
    expect(dirs.size).toBe(TARGETS.length)
  })

  it('lets DEEPDOCK_BASE_URL override the local API only', () => {
    const env = { DEEPDOCK_BASE_URL: 'http://127.0.0.1:9999' }
    const host = { env, platform: 'darwin' as const, homedir: '/Users/a' }
    expect(targetEnv('local', host).DEEPDOCK_BASE_URL).toBe('http://127.0.0.1:9999')
    expect(targetEnv('staging', host).DEEPDOCK_BASE_URL).toBe('https://api.staging.deepdock.ai')
  })

  it('places the settings under APPDATA on Windows and leaves XDG_CONFIG_HOME alone', () => {
    const host = {
      env: { APPDATA: 'C:/Users/a/AppData/Roaming', XDG_CONFIG_HOME: '/x' },
      platform: 'win32' as const,
      homedir: 'C:/Users/a',
    }
    expect(slashed(targetEnv('production', host).DEEPDOCK_CONFIG_DIR)).toBe(
      'C:/Users/a/AppData/Roaming/deepdock-dev/production',
    )
    expect(targetEnv('production', host)).not.toHaveProperty('XDG_CONFIG_HOME')
  })

  it('reads --target from the front of the arguments, else DEEPDOCK_TARGET, else staging', () => {
    expect(splitTarget(['--target', 'production', 'auth', 'status'], {})).toEqual({
      target: 'production',
      rest: ['auth', 'status'],
    })
    expect(splitTarget(['--target=local', 'org', 'list'], {})).toEqual({
      target: 'local',
      rest: ['org', 'list'],
    })
    expect(splitTarget(['auth', 'login'], { DEEPDOCK_TARGET: 'production' })).toEqual({
      target: 'production',
      rest: ['auth', 'login'],
    })
    expect(splitTarget(['auth', 'login'], {})).toEqual({
      target: 'staging',
      rest: ['auth', 'login'],
    })
    expect(splitTarget(['--target', 'prod'], {})).toEqual({
      error: expect.stringContaining('Unknown target "prod"'),
    })
  })
})
