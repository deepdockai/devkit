import { statSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserCommand } from '../../src/runtime.ts'
import { type FakeApi, startFakeApi } from '../fakeApi.ts'
import {
  errorDocOf,
  execute,
  makeSandbox,
  readConfigText,
  type Sandbox,
  signInWith,
} from '../harness.ts'

let api: FakeApi
let box: Sandbox

beforeEach(async () => {
  api = await startFakeApi()
  box = makeSandbox()
})
afterEach(async () => {
  await api.close()
  box.cleanup()
})

describe('auth login', () => {
  it('without a terminal prints the request as data and stores the collecting secret', async () => {
    const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url })
    expect(outcome.code).toBe(0)
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.pending.request).toBe('3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6')
    expect(doc.meta.pending).toBeUndefined()
    expect(doc.data.pending.url).toContain('/cli?request=')
    expect(outcome.stdout).not.toContain('poll-login-secret')
    expect(readConfigText(box)).toContain('poll-login-secret')
  })

  it('--wait collects the sign-in, stores it mode 600 and prints it nowhere', async () => {
    const outcome = await signInWith(box, api.url)
    expect(outcome.code).toBe(0)
    const doc = JSON.parse(outcome.stdout)
    expect(doc.data.email).toBe('anna.mueller@muster-it.example')
    expect(doc.data.organisations).toHaveLength(2)
    expect(outcome.stdout + outcome.stderr).not.toContain(api.state.signInSecret)
    expect(readConfigText(box)).toContain(api.state.signInSecret)
    if (process.platform !== 'win32') expect(statSync(box.configFile).mode & 0o777).toBe(0o600)
    expect(readConfigText(box)).not.toContain('poll-login-secret')
  })

  it('on a terminal waits for the approval and prints the link on stderr only', async () => {
    api.state.loginPolls.splice(0, api.state.loginPolls.length, 'pending', 'pending', 'approved')
    const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('Signed in as anna.mueller@muster-it.example.')
    expect(outcome.stdout).toContain('muster-it')
    expect(outcome.stdout).not.toContain(`${api.url}/cli`)
    expect(outcome.stderr).toContain(
      'Open this link to approve the sign-in (it expires in 10 minutes):',
    )
    expect(outcome.stderr).toContain(`${api.url}/cli?request=`)
    expect(outcome.stderr).toContain('Waiting for approval in the browser.')
  })

  it('shows the approval link blue, underlined and clickable on a coloured terminal', async () => {
    const outcome = await execute(box, ['auth', 'login'], {
      baseUrl: api.url,
      tty: true,
      colour: true,
    })
    const url = outcome.opened[0]
    expect(url).toContain(`${api.url}/cli?request=`)
    const esc = String.fromCharCode(27)
    expect(outcome.stderr).toContain(
      `${esc}]8;;${url}${esc}\\${esc}[34m${esc}[4m${url}${esc}[24m${esc}[39m${esc}]8;;${esc}\\`,
    )
  })

  it('prints the approval link as plain text with NO_COLOR, and nothing styled under --json', async () => {
    for (const options of [{ tty: true }, { tty: true, colour: true, env: { NO_COLOR: '1' } }]) {
      const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url, ...options })
      expect(outcome.stderr).not.toContain('\u001b')
      expect(outcome.stderr).toContain(`  ${api.url}/cli?request=`)
    }
    const piped = await execute(box, ['auth', 'login', '--no-wait'], {
      baseUrl: api.url,
      colour: true,
    })
    expect(piped.stdout + piped.stderr).not.toContain('\u001b')
  })

  it('styles the link in the --no-wait text on stdout of a coloured terminal', async () => {
    const outcome = await execute(box, ['auth', 'login', '--no-wait'], {
      baseUrl: api.url,
      tty: true,
      colour: true,
    })
    expect(outcome.stdout).toContain(`${String.fromCharCode(27)}[34m`)
    expect(outcome.stdout).toContain(`${api.url}/cli?request=`)
  })

  it('--no-wait on a terminal prints the request and does not poll', async () => {
    const outcome = await execute(box, ['auth', 'login', '--no-wait'], {
      baseUrl: api.url,
      tty: true,
    })
    expect(outcome.code).toBe(0)
    expect(api.requests.some((request) => request.path.endsWith('/poll'))).toBe(false)
    expect(outcome.stdout).toContain('--wait 3c9d0e1a')
  })

  it('answers a denial with approval_denied and exit 5', async () => {
    api.state.loginPolls.splice(0, api.state.loginPolls.length, 'denied')
    const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(5)
    expect(outcome.stderr).toContain('The sign-in was denied in the browser [approval_denied].')
  })

  it('answers an expiry with approval_expired and exit 5', async () => {
    api.state.loginPolls.splice(0, api.state.loginPolls.length, 'expired')
    const outcome = await execute(box, ['auth', 'login', '--json'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(0)
    const waited = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      { baseUrl: api.url },
    )
    expect(waited.code).toBe(5)
    expect(errorDocOf(waited.stderr).error.code).toBe('approval_expired')
  })

  it('--wait on a request past its expiry never calls the API', async () => {
    await execute(box, ['auth', 'login'], { baseUrl: api.url })
    const before = api.requests.length
    const later = () => new Date(Date.now() + 3600_000)
    const waited = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      { baseUrl: api.url, now: later },
    )
    expect(waited.code).toBe(5)
    expect(errorDocOf(waited.stderr).error.code).toBe('approval_expired')
    expect(api.requests.length).toBe(before)
  })

  it('--wait for an unknown request is a usage error', async () => {
    const outcome = await execute(box, ['auth', 'login', '--wait', 'nope'], { baseUrl: api.url })
    expect(outcome.code).toBe(1)
    expect(errorDocOf(outcome.stderr).error.code).toBe('invalid_usage')
  })

  it('sends the CLI version and hostname with the request', async () => {
    await execute(box, ['auth', 'login'], { baseUrl: api.url, hostname: 'build-box' })
    const request = api.requests.find((entry) => entry.path === '/public/cli/logins')
    expect(request?.headers['x-deepdock-cli']).toBe('0.1.0')
    expect(request?.body).toEqual({ hostname: 'build-box', cliVersion: '0.1.0' })
  })
})

describe('auth status', () => {
  it('says not signed in without a sign-in', async () => {
    const outcome = await execute(box, ['auth', 'status', '--json'], { baseUrl: api.url })
    expect(outcome.code).toBe(5)
    expect(JSON.parse(outcome.stdout).data.signedIn).toBe(false)
    expect(api.requests).toHaveLength(0)
  })

  it('prints the usual hint on stderr when not signed in', async () => {
    const outcome = await execute(box, ['auth', 'status'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(5)
    expect(outcome.stdout).toContain('Not signed in.')
    expect(outcome.stderr).toBe('Run `deepdock auth login`.\n')
  })

  it('exits 5 for an expired stored sign-in without asking the API', async () => {
    await signInWith(box, api.url)
    api.requests.length = 0
    const later = (): Date => new Date(Date.now() + 100 * 86400000)
    const outcome = await execute(box, ['auth', 'status', '--json'], {
      baseUrl: api.url,
      now: later,
    })
    expect(outcome.code).toBe(5)
    expect(JSON.parse(outcome.stdout).data.signedIn).toBe(false)
    expect(api.requests).toHaveLength(0)
  })

  it('confirms a stored sign-in with one request', async () => {
    await signInWith(box, api.url)
    api.requests.length = 0
    const outcome = await execute(box, ['auth', 'status', '--json'], { baseUrl: api.url })
    const { data } = JSON.parse(outcome.stdout)
    expect(outcome.code).toBe(0)
    expect(data.signedIn).toBe(true)
    expect(data.email).toBe('anna.mueller@muster-it.example')
    expect(data.baseUrl).toBe(api.url)
    expect(api.requests).toHaveLength(1)
    expect(outcome.stdout).not.toContain(api.state.signInSecret)
  })

  it('reports a revoked sign-in as not signed in', async () => {
    await signInWith(box, api.url)
    api.state.signInSecret = 'revoked-now'
    const outcome = await execute(box, ['auth', 'status', '--json'], { baseUrl: api.url })
    expect(outcome.code).toBe(5)
    expect(JSON.parse(outcome.stdout).data.signedIn).toBe(false)
  })

  it('prints a human summary on a terminal', async () => {
    await signInWith(box, api.url)
    const outcome = await execute(box, ['auth', 'status'], { baseUrl: api.url, tty: true })
    expect(outcome.stdout).toContain('Signed in as anna.mueller@muster-it.example')
    expect(outcome.stdout).toContain('Beispiel Handel GmbH')
  })
})

describe('auth logout', () => {
  it('stores the sign-in id and revokes exactly that id without listing', async () => {
    await signInWith(box, api.url)
    expect(JSON.parse(readConfigText(box)).signIn.id).toBe('cli_signin_1')
    api.state.cliKeys.push({
      id: 'other',
      hostname: 'test-host',
      createdAt: 'x',
      expiresAt: 'x',
      revokedAt: null,
    })
    api.requests.length = 0
    const outcome = await execute(box, ['auth', 'logout', '--json'], { baseUrl: api.url })
    expect(outcome.code).toBe(0)
    expect(api.state.revokedCliKeys).toEqual(['cli_signin_1'])
    expect(api.requests.some((entry) => entry.path === '/partner/cli-keys')).toBe(false)
    expect(JSON.parse(outcome.stdout).data.revoked).toBe(true)
    expect(JSON.parse(readConfigText(box)).signIn).toBeUndefined()
  })

  const dropId = (): void => {
    const config = JSON.parse(readConfigText(box))
    config.signIn.id = undefined
    writeFileSync(box.configFile, JSON.stringify(config), { mode: 0o600 })
  }
  const listed = (id: string, hostname: string) => ({
    id,
    hostname,
    createdAt: 'x',
    expiresAt: 'x',
    revokedAt: null,
  })

  it('a stored sign-in without an id is a damaged store: nothing guessed, local entry removed', async () => {
    await signInWith(box, api.url)
    dropId()
    api.state.cliKeys.push(listed('mine', 'test-host'))
    api.requests.length = 0
    const outcome = await execute(box, ['auth', 'logout'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('settings file is damaged')
    expect(outcome.stdout).toContain('revoke it in the Deepdock dashboard')
    expect(api.state.revokedCliKeys).toEqual([])
    expect(api.requests.some((entry) => entry.path.startsWith('/partner/cli-keys'))).toBe(false)
    expect(JSON.parse(readConfigText(box)).signIn).toBeUndefined()
  })

  it('without a sign-in only says so', async () => {
    const outcome = await execute(box, ['auth', 'logout'], { baseUrl: api.url, tty: true })
    expect(outcome.code).toBe(0)
    expect(outcome.stdout).toContain('Not signed in.')
  })
})

describe('base URL binding', () => {
  let other: FakeApi
  beforeEach(async () => {
    other = await startFakeApi()
  })
  afterEach(async () => {
    await other.close()
  })

  it('records the base URL with the sign-in and with a pending request', async () => {
    await execute(box, ['auth', 'login'], { baseUrl: api.url })
    expect(JSON.parse(readConfigText(box)).pending[0].baseUrl).toBe(api.url)
    await signInWith(box, api.url)
    expect(JSON.parse(readConfigText(box)).signIn.baseUrl).toBe(api.url)
  })

  it('never sends the sign-in to a different base URL', async () => {
    await signInWith(box, api.url)
    const outcome = await execute(box, ['org', 'list'], { baseUrl: other.url })
    expect(outcome.code).toBe(5)
    const error = errorDocOf(outcome.stderr)
    expect(error.error.code).toBe('sign_in_needed')
    expect(error.error.message).toContain(`not ${other.url}`)
    expect(error.meta.hint).toContain('unset DEEPDOCK_BASE_URL')
    expect(other.requests).toHaveLength(0)
  })

  it('never sends a pending request to a different base URL', async () => {
    await execute(box, ['auth', 'login'], { baseUrl: api.url })
    const outcome = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      { baseUrl: other.url },
    )
    expect(outcome.code).toBe(5)
    expect(other.requests).toHaveLength(0)
  })

  it('auth status reports not signed in for another base URL', async () => {
    await signInWith(box, api.url)
    const outcome = await execute(box, ['auth', 'status', '--json'], { baseUrl: other.url })
    expect(outcome.code).toBe(5)
    expect(JSON.parse(outcome.stdout).data.signedIn).toBe(false)
    expect(other.requests).toHaveLength(0)
  })

  it('logout against another base URL removes the local entry and revokes nothing', async () => {
    await signInWith(box, api.url)
    const outcome = await execute(box, ['auth', 'logout', '--json'], { baseUrl: other.url })
    expect(outcome.code).toBe(0)
    expect(other.requests).toHaveLength(0)
    expect(JSON.parse(readConfigText(box)).signIn).toBeUndefined()
  })

  it('requires https except for loopback hosts', async () => {
    for (const url of ['http://api.example.test', 'ftp://127.0.0.1', 'not a url']) {
      const outcome = await execute(box, ['auth', 'status', '--json'], {
        env: { DEEPDOCK_BASE_URL: url },
      })
      expect(outcome.code, url).toBe(1)
      expect(errorDocOf(outcome.stderr).error.code).toBe('invalid_usage')
    }
    for (const url of [
      'http://localhost:9',
      'http://127.0.0.1:9',
      'http://[::1]:9',
      'https://api.example.test',
    ]) {
      const outcome = await execute(box, ['auth', 'status', '--json'], {
        env: { DEEPDOCK_BASE_URL: url },
      })
      expect(outcome.code, url).toBe(5)
      expect(JSON.parse(outcome.stdout).data.baseUrl).toBe(url)
    }
  })
})

describe('approval link', () => {
  it('refuses a link on a foreign host or without https and opens nothing', async () => {
    for (const approveUrl of [
      'https://evil.example.test/cli?request=x',
      'http://dash.deepdock.ai/cli?request=x',
      'https://dash.deepdock.ai.evil.test/cli',
      'javascript:alert(1)',
      'http://user:pw@127.0.0.1:9/cli',
      'https://dash.deepdock.ai/cli?request=x',
    ]) {
      api.state.forced['POST /public/cli/logins'] = {
        status: 201,
        body: {
          data: {
            requestId: 'r',
            approveUrl,
            pollSecret: 'p',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        },
      }
      const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url, tty: true })
      expect(outcome.code, approveUrl).toBe(3)
      expect(outcome.opened).toEqual([])
      expect(outcome.stdout + outcome.stderr).not.toContain('evil.example')
    }
  })

  it('prints and opens a hostile but allowed link as one clean line and one argument', async () => {
    const hostile = 'http://127.0.0.1:9/cli?request=a&b|c^d\nrm -rf /\u001b[2J'
    api.state.forced['POST /public/cli/logins'] = {
      status: 201,
      body: {
        data: {
          requestId: 'r',
          approveUrl: hostile,
          pollSecret: 'p',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      },
    }
    api.state.loginPolls.splice(0, api.state.loginPolls.length, 'denied')
    const outcome = await execute(box, ['auth', 'login'], { baseUrl: api.url, tty: true })
    expect(outcome.opened).toHaveLength(1)
    const [opened] = outcome.opened
    expect(Array.from(opened ?? '').some((char) => char.charCodeAt(0) < 32)).toBe(false)
    expect(outcome.stderr).not.toContain(String.fromCharCode(27))
    expect(outcome.stderr.split('\n').filter((line) => line.includes('request=a'))).toEqual([
      `  ${opened}`,
    ])
  })

  it('opens the browser on Windows without a shell', () => {
    const url = 'https://dash.example.test/cli?request=a&b|c^d'
    expect(browserCommand('win32', url)).toEqual({
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    })
    expect(browserCommand('darwin', url)).toEqual({ command: 'open', args: [url] })
    expect(browserCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] })
  })
})

describe('waiting', () => {
  it('backs off on a 429 for as long as Retry-After says, then succeeds', async () => {
    api.state.pollFailures = { count: 2, status: 429, code: 'rate_limited', retryAfter: '3' }
    const sleeps: number[] = []
    await execute(box, ['auth', 'login', '--json'], { baseUrl: api.url })
    const outcome = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      {
        baseUrl: api.url,
        onSleep: (ms) => void sleeps.push(ms),
      },
    )
    expect(outcome.code).toBe(0)
    expect(sleeps).toEqual([3000, 3000])
  })

  it('caps the back-off and gives up after repeated 429s with exit 2', async () => {
    api.state.pollFailures = { count: 50, status: 429, code: 'rate_limited', retryAfter: '9999' }
    const sleeps: number[] = []
    await execute(box, ['auth', 'login', '--json'], { baseUrl: api.url })
    const outcome = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      {
        baseUrl: api.url,
        onSleep: (ms) => void sleeps.push(ms),
      },
    )
    expect(outcome.code).toBe(2)
    expect(Math.max(...sleeps)).toBe(30000)
  })

  it('a Ctrl-C leaves the request pending and says how to resume', async () => {
    api.state.loginPolls.splice(0, api.state.loginPolls.length, 'pending', 'approved')
    const interrupted = await execute(box, ['auth', 'login'], {
      baseUrl: api.url,
      tty: true,
      interruptAtSleep: true,
    })
    expect(interrupted.code).toBe(3)
    expect(interrupted.stderr).toContain(
      'Interrupted while waiting for approval [connection_lost].',
    )
    expect(interrupted.stderr).toContain(
      'deepdock auth login --wait 3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6',
    )
    expect(JSON.parse(readConfigText(box)).pending).toHaveLength(1)
    const resumed = await execute(
      box,
      ['auth', 'login', '--wait', '3c9d0e1a-5b6c-4d7e-8f90-a1b2c3d4e5f6'],
      { baseUrl: api.url },
    )
    expect(resumed.code).toBe(0)
    expect(JSON.parse(readConfigText(box)).pending).toEqual([])
  })
})

describe('approval link host derived from the base URL', () => {
  const via =
    (from: string): ((input: string, init?: RequestInit) => Promise<Response>) =>
    (input, init) =>
      fetch(input.replace(from, api.url), init)

  const answerWith = (approveUrl: string): void => {
    api.state.forced['POST /public/cli/logins'] = {
      status: 201,
      body: {
        data: {
          requestId: 'r',
          approveUrl,
          pollSecret: 'p',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
        },
      },
    }
  }
  const login = (base: string) =>
    execute(box, ['auth', 'login', '--json'], {
      env: { DEEPDOCK_BASE_URL: base },
      fetch: via(base),
    })

  it('accepts https on dash.<rest> for api.<rest>', async () => {
    const link = 'https://dash.example.test/cli?request=r'
    answerWith(link)
    const outcome = await login('https://api.example.test')
    expect(outcome.code).toBe(0)
    expect(JSON.parse(outcome.stdout).data.pending.url).toBe(link)
  })

  it('refuses any other host, scheme or the API host itself', async () => {
    for (const link of [
      'https://dash.other.test/cli?request=r',
      'https://api.example.test/cli?request=r',
      'http://dash.example.test/cli?request=r',
      'https://dash.example.test.evil.test/cli',
      'https://dash.deepdock.ai/cli?request=r',
    ]) {
      answerWith(link)
      const outcome = await login('https://api.example.test')
      expect(outcome.code, link).toBe(3)
      expect(errorDocOf(outcome.stderr).meta.hint).toContain('dash.example.test')
    }
  })

  it('accepts loopback links and http only there', async () => {
    answerWith('http://localhost:9/cli?request=r')
    expect((await login('https://api.example.test')).code).toBe(0)
    answerWith('http://[::1]:9/cli?request=r')
    expect((await login('https://api.example.test')).code).toBe(0)
  })

  it('explains why when the base URL host does not start with api.', async () => {
    answerWith('https://dash.example.test/cli?request=r')
    const outcome = await login('https://gateway.example.test')
    expect(outcome.code).toBe(3)
    expect(errorDocOf(outcome.stderr).meta.hint).toContain('does not start with "api."')
    answerWith('http://127.0.0.1:9/cli?request=r')
    expect((await login('https://gateway.example.test')).code).toBe(0)
  })
})
