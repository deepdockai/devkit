import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Runtime } from '../../src/runtime.ts'
import {
  checkDestination,
  dropLine,
  removeEnvValue,
  upsertLine,
  writeEnvValue,
} from '../../src/writeEnv/writeEnv.ts'
import { initRepo, makeSandbox, type Sandbox } from '../harness.ts'

let box: Sandbox
const KEY = ['ddk', 'test', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg'].join('_')
const rt = (): Runtime => ({ cwd: box.work }) as unknown as Runtime

beforeEach(() => {
  box = makeSandbox()
})
afterEach(() => box.cleanup())

describe('upsertLine', () => {
  it('appends when the variable is absent', () => {
    expect(upsertLine('A=1\n', 'DEEPDOCK_API_KEY', 'v')).toBe('A=1\nDEEPDOCK_API_KEY=v\n')
    expect(upsertLine('', 'DEEPDOCK_API_KEY', 'v')).toBe('DEEPDOCK_API_KEY=v\n')
    expect(upsertLine('A=1', 'DEEPDOCK_API_KEY', 'v')).toBe('A=1\nDEEPDOCK_API_KEY=v\n')
  })

  it('replaces an existing line in place and never duplicates', () => {
    const before = 'A=1\nDEEPDOCK_API_KEY=old\nB=2\nexport DEEPDOCK_API_KEY=older\n'
    expect(upsertLine(before, 'DEEPDOCK_API_KEY', 'new')).toBe('A=1\nDEEPDOCK_API_KEY=new\nB=2\n')
  })

  it('keeps CRLF line endings', () => {
    expect(upsertLine('A=1\r\nDEEPDOCK_API_KEY=old\r\n', 'DEEPDOCK_API_KEY', 'n')).toBe(
      'A=1\r\nDEEPDOCK_API_KEY=n\r\n',
    )
  })

  it('keeps a leading export and its indentation when rewriting', () => {
    expect(upsertLine('export DEEPDOCK_API_KEY=old\n', 'DEEPDOCK_API_KEY', 'v')).toBe(
      'export DEEPDOCK_API_KEY=v\n',
    )
    expect(upsertLine('  DEEPDOCK_API_KEY = old\n', 'DEEPDOCK_API_KEY', 'v')).toBe(
      '  DEEPDOCK_API_KEY=v\n',
    )
  })

  it('does not touch a variable that only starts with the same letters', () => {
    expect(upsertLine('DEEPDOCK_API_KEY_OTHER=x\n', 'DEEPDOCK_API_KEY', 'v')).toBe(
      'DEEPDOCK_API_KEY_OTHER=x\nDEEPDOCK_API_KEY=v\n',
    )
  })
})

describe('dropLine', () => {
  const key = ['ddk', 'test', 'vgazq-6EabcdefghijklmnopqrstuvwxyzABCDEFGHIJKL'].join('_')
  const dropped = (line: string, prefix = 'vgazq-6E'): { content: string; removed: boolean } =>
    dropLine(`A=1\n${line}\nB=2\n`, 'DEEPDOCK_API_KEY', prefix)

  it('matches the prefix after the scheme head, not the start of the key', () => {
    expect(dropped(`DEEPDOCK_API_KEY=${key}`)).toEqual({ content: 'A=1\nB=2\n', removed: true })
    expect(dropped(`DEEPDOCK_API_KEY=${key.replace('_test_', '_live_')}`).removed).toBe(true)
  })

  it('also matches with quotes, an export prefix, single quotes and CRLF', () => {
    expect(dropped(`DEEPDOCK_API_KEY="${key}"`).removed).toBe(true)
    expect(dropped(`DEEPDOCK_API_KEY='${key}'`).removed).toBe(true)
    expect(dropped(`export DEEPDOCK_API_KEY=${key}`).removed).toBe(true)
    const crlf = dropLine(
      `A=1\r\nDEEPDOCK_API_KEY=${key}\r\nB=2\r\n`,
      'DEEPDOCK_API_KEY',
      'vgazq-6E',
    )
    expect(crlf).toEqual({ content: 'A=1\r\nB=2\r\n', removed: true })
  })

  it('treats the prefix literally, with - and _ in it', () => {
    const odd = ['ddk', 'live', 'a_b-c.dEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHI'].join('_')
    expect(dropped(`DEEPDOCK_API_KEY=${odd}`, 'a_b-c.dE').removed).toBe(true)
    expect(dropped(`DEEPDOCK_API_KEY=${odd}`, 'a_b-cXdE').removed).toBe(false)
  })

  it('leaves a line holding another value alone', () => {
    for (const other of [
      'mine',
      ['ddk', 'test', 'z'.repeat(43)].join('_'),
      `xx${key}`,
      key.slice(9),
    ]) {
      const kept = dropped(`DEEPDOCK_API_KEY=${other}`)
      expect(kept.removed, other).toBe(false)
      expect(kept.content).toContain(`DEEPDOCK_API_KEY=${other}`)
    }
  })
})

describe('checkDestination', () => {
  it('accepts a file git ignores', async () => {
    initRepo(box.work, '.env*\n')
    const destination = await checkDestination(rt(), '.env.local')
    expect(destination.warning).toBeUndefined()
    expect(destination.path).toBe(join(box.work, '.env.local'))
  })

  it('refuses a file git does not ignore', async () => {
    initRepo(box.work)
    await expect(checkDestination(rt(), 'secrets.txt')).rejects.toMatchObject({
      code: 'invalid_usage',
      message: 'secrets.txt is not ignored by git, so the key would be committed.',
    })
  })

  it('refuses a tracked file even when a pattern ignores it', async () => {
    initRepo(box.work, '.env*\n')
    writeFileSync(join(box.work, '.env.local'), 'A=1\n')
    execFileSync('git', ['add', '-f', '.env.local'], { cwd: box.work })
    await expect(checkDestination(rt(), '.env.local')).rejects.toMatchObject({
      message: expect.stringContaining('tracked by git'),
    })
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink', async () => {
    initRepo(box.work, '.env*\nlink\n.link.deepdock-tmp\n')
    writeFileSync(join(box.work, 'real'), '')
    symlinkSync(join(box.work, 'real'), join(box.work, 'link'))
    await expect(checkDestination(rt(), 'link')).rejects.toMatchObject({
      message: 'link is a symbolic link.',
    })
  })

  it('accepts a target whose temporary file a gitignore pattern covers', async () => {
    initRepo(box.work, '.env.*\n')
    await expect(checkDestination(rt(), '.env.local')).resolves.toMatchObject({
      path: join(box.work, '.env.local'),
    })
  })

  it('refuses before writing when only the target is ignored, naming the line to add', async () => {
    initRepo(box.work, '.env.local\n')
    await expect(checkDestination(rt(), '.env.local')).rejects.toMatchObject({
      code: 'invalid_usage',
      hint: expect.stringContaining('*.deepdock-tmp*'),
    })
    expect(readdirSync(box.work).sort()).toEqual(['.git', '.gitignore'])
  })

  it('accepts the broad pattern for the temporary file too', async () => {
    initRepo(box.work, '.env.local\n*.deepdock-tmp*\n')
    await expect(checkDestination(rt(), '.env.local')).resolves.toMatchObject({
      path: join(box.work, '.env.local'),
    })
  })

  it('never deletes a temporary file it did not create', async () => {
    const stranger = join(box.work, '.env.local.deepdock-tmp-someoneelse')
    writeFileSync(stranger, 'theirs')
    await writeEnvValue(join(box.work, '.env.local'), 'DEEPDOCK_API_KEY', KEY)
    expect(readFileSync(stranger, 'utf8')).toBe('theirs')
  })

  it('names the temporary file next to the target and leaves none behind', async () => {
    const path = join(box.work, '.env.local')
    await writeEnvValue(path, 'DEEPDOCK_API_KEY', KEY)
    expect(readdirSync(box.work)).toEqual(['.env.local'])
  })

  it('outside a repository asks git nothing about the temporary file', async () => {
    const destination = await checkDestination(rt(), '.env.local')
    expect(destination.warning).toBeDefined()
    expect(readdirSync(box.work)).toEqual([])
  })

  it('allows a file outside a repository with a warning', async () => {
    const destination = await checkDestination(rt(), '.env')
    expect(destination.warning).toContain('is not inside a git repository')
    expect(destination.warning).toContain('never committed or shared')
  })

  it('refuses a directory that does not exist', async () => {
    await expect(checkDestination(rt(), 'missing/.env')).rejects.toMatchObject({
      code: 'invalid_usage',
    })
  })
})

describe('writeEnvValue', () => {
  it.skipIf(process.platform === 'win32')(
    'creates the file mode 600 and leaves no temp file',
    async () => {
      const path = join(box.work, '.env.local')
      await writeEnvValue(path, 'DEEPDOCK_API_KEY', KEY)
      expect(readFileSync(path, 'utf8')).toBe(`DEEPDOCK_API_KEY=${KEY}\n`)
      if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(readdirSync(box.work)).toEqual(['.env.local'])
    },
  )

  it.skipIf(process.platform === 'win32')(
    'sets an existing file to mode 600 and replaces the line in place',
    async () => {
      const path = join(box.work, '.env.local')
      writeFileSync(path, 'A=1\nDEEPDOCK_API_KEY=old\nB=2\n', { mode: 0o644 })
      chmodSync(path, 0o644)
      await writeEnvValue(path, 'DEEPDOCK_API_KEY', KEY)
      expect(readFileSync(path, 'utf8')).toBe(`A=1\nDEEPDOCK_API_KEY=${KEY}\nB=2\n`)
      expect(statSync(path).mode & 0o777).toBe(0o600)
    },
  )

  it('refuses a value that is not key-shaped', async () => {
    const path = join(box.work, '.env.local')
    await expect(writeEnvValue(path, 'DEEPDOCK_API_KEY', 'a\nB=injected')).rejects.toMatchObject({
      code: 'internal_error',
    })
    expect(readdirSync(box.work)).toEqual([])
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to write through a symlink created after the check',
    async () => {
      const real = join(box.work, 'real')
      writeFileSync(real, 'untouched')
      mkdirSync(join(box.work, 'sub'))
      symlinkSync(real, join(box.work, 'sub', '.env'))
      await expect(
        writeEnvValue(join(box.work, 'sub', '.env'), 'DEEPDOCK_API_KEY', KEY),
      ).rejects.toMatchObject({
        code: 'internal_error',
      })
      expect(readFileSync(real, 'utf8')).toBe('untouched')
    },
  )
})

describe('removeEnvValue', () => {
  it('removes the line it wrote and keeps the rest', async () => {
    const path = join(box.work, '.env.local')
    writeFileSync(path, `A=1\nDEEPDOCK_API_KEY=${KEY}\n`)
    expect(await removeEnvValue(path, 'DEEPDOCK_API_KEY', KEY.slice(9, 17))).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('A=1\n')
  })

  it('leaves a line holding another key and a missing file alone', async () => {
    const path = join(box.work, '.env.local')
    writeFileSync(path, 'DEEPDOCK_API_KEY=someone-elses-value\n')
    expect(await removeEnvValue(path, 'DEEPDOCK_API_KEY', 'ddk_test_')).toBe(false)
    expect(await removeEnvValue(join(box.work, 'nope'), 'DEEPDOCK_API_KEY', 'x')).toBe(false)
  })
})

describe('when git cannot answer', () => {
  const fakeGit = (script: string): string => {
    const dir = join(box.work, 'bin')
    mkdirSync(dir)
    writeFileSync(join(dir, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    return dir
  }
  const rtWith = (path: string): Runtime =>
    ({ cwd: box.work, env: { PATH: path } }) as unknown as Runtime

  const cases: [string, () => string, string][] = [
    [
      'git is not installed',
      () => {
        const empty = join(box.work, 'nothing')
        mkdirSync(empty)
        return empty
      },
      'git is not installed',
    ],
    [
      'a permission error',
      () => fakeGit('echo "fatal: cannot open: Permission denied" >&2; exit 1'),
      'git failed: fatal: cannot open: Permission denied',
    ],
    [
      'dubious ownership',
      () => fakeGit('echo "fatal: detected dubious ownership in repository" >&2; exit 128'),
      'git reported dubious ownership',
    ],
    ['a generic failure exit', () => fakeGit('exit 7'), 'git failed: exit 7'],
  ]

  for (const [kind, makeBin, reason] of cases) {
    it.skipIf(process.platform === 'win32')(
      `allows the write with a warning: ${kind}`,
      async () => {
        const destination = await checkDestination(rtWith(makeBin()), '.env.local')
        expect(destination.path).toBe(join(box.work, '.env.local'))
        expect(destination.warning).toBe(
          `Warning: could not check with git whether .env.local is ignored: ${reason}; make sure it is not committed.`,
        )
      },
    )
  }

  it.skipIf(process.platform === 'win32')(
    "strips control characters from git's message",
    async () => {
      const bin = fakeGit('printf "fatal: bad\\033[2J thing\\n" >&2; exit 9')
      const destination = await checkDestination(rtWith(bin), '.env.local')
      expect(destination.warning).toContain('git failed: fatal: bad[2J thing;')
      expect(destination.warning).not.toContain(String.fromCharCode(27))
    },
  )

  it.skipIf(process.platform === 'win32')(
    'a later failing git call warns the same way',
    async () => {
      const bin = fakeGit(
        'case "$3" in rev-parse) echo true; exit 0;; *) echo "fatal: bad" >&2; exit 128;; esac',
      )
      const destination = await checkDestination(rtWith(bin), '.env.local')
      expect(destination.warning).toContain(
        'could not check with git whether .env.local is ignored',
      )
    },
  )

  it.skipIf(process.platform === 'win32')(
    'where git answers "not a git repository" the old warning stays',
    async () => {
      const bin = fakeGit(
        'echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128',
      )
      const destination = await checkDestination(rtWith(bin), '.env.local')
      expect(destination.warning).toContain('not inside a git repository')
    },
  )

  it('where git answers, an unignored or tracked file is still refused', async () => {
    initRepo(box.work, '.env.local\n*.deepdock-tmp*\n')
    writeFileSync(join(box.work, 'other.txt'), '')
    await expect(checkDestination(rt(), 'other.txt')).rejects.toMatchObject({
      code: 'invalid_usage',
    })
  })
})
