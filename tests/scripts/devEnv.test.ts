import { describe, expect, it } from 'vitest'
import { devEnv } from '../../scripts/devEnv.ts'

const slashed = (path: string): string => path.replaceAll('\\', '/')

describe('development environment', () => {
  it('defaults to the production API, in a settings directory named after its host', () => {
    const env = devEnv({ env: {}, platform: 'linux', homedir: '/home/a' })
    expect(env.DEEPDOCK_BASE_URL).toBe('https://api.deepdock.ai')
    expect(slashed(env.DEEPDOCK_CONFIG_DIR)).toBe('/home/a/.config/deepdock-dev/api.deepdock.ai')
  })

  it('gives each DEEPDOCK_BASE_URL its own directory, ports included', () => {
    const at = (url: string): string =>
      slashed(
        devEnv({ env: { DEEPDOCK_BASE_URL: url }, platform: 'darwin', homedir: '/Users/a' })
          .DEEPDOCK_CONFIG_DIR,
      )
    expect(at('http://localhost:8787')).toBe('/Users/a/.config/deepdock-dev/localhost:8787')
    expect(at('http://localhost:9999')).not.toBe(at('http://localhost:8787'))
    expect(at('https://api.example.com/')).toBe('/Users/a/.config/deepdock-dev/api.example.com')
  })

  it('refuses the same base URLs the CLI refuses', () => {
    expect(() =>
      devEnv({
        env: { DEEPDOCK_BASE_URL: 'http://api.example.com' },
        platform: 'linux',
        homedir: '/home/a',
      }),
    ).toThrow(/https/)
  })

  it('uses APPDATA on Windows and leaves XDG_CONFIG_HOME alone', () => {
    const env = devEnv({
      env: { APPDATA: 'C:/Users/a/AppData/Roaming', XDG_CONFIG_HOME: '/x' },
      platform: 'win32',
      homedir: 'C:/Users/a',
    })
    expect(slashed(env.DEEPDOCK_CONFIG_DIR)).toBe(
      'C:/Users/a/AppData/Roaming/deepdock-dev/api.deepdock.ai',
    )
    expect(env).not.toHaveProperty('XDG_CONFIG_HOME')
  })
})
