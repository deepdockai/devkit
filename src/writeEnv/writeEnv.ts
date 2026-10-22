import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { CliError, usageError } from '../api/errors.ts'
import { renameWithRetry } from '../atomicRename.ts'
import { stripControl } from '../output/human.ts'
import type { Runtime } from '../runtime.ts'

export const API_KEY_VARIABLE = 'DEEPDOCK_API_KEY'

/**
 * Windows has no POSIX modes: both files keep their folder's permissions, so each run that writes
 * the env file says so. The settings file is named too because it holds the sign-in secret.
 */
export const windowsFileWarning = (
  platform: NodeJS.Platform,
  envFile: string,
  settingsFile: string,
): string | undefined =>
  platform === 'win32'
    ? `On Windows these files keep the permissions of their folder: ${envFile} and the settings file ${settingsFile} hold secrets; under C:\\Users\\<you> only you can read them, in other folders other users of this PC may be able to.`
    : undefined

export type Destination = {
  path: string
  /** Set when the file is outside a git repository; printed on stderr before the approval. */
  warning?: string
}

type GitResult = { status: number | 'missing'; stdout: string; stderr: string }

const git = (rt: Runtime, dir: string, args: string[]): Promise<GitResult> =>
  new Promise((done) => {
    // LC_ALL=C keeps git's messages in English; the guard below reads one of them.
    const env = { ...(rt.env ?? process.env), LC_ALL: 'C' }
    execFile('git', ['-C', dir, ...args], { encoding: 'utf8', env }, (error, stdout, stderr) => {
      if (!error) return done({ status: 0, stdout, stderr })
      const code = (error as NodeJS.ErrnoException).code
      done({ status: typeof code === 'number' ? code : 'missing', stdout: '', stderr })
    })
  })

const gitReason = (result: GitResult): string => {
  if (result.status === 'missing') return 'git is not installed'
  if (/dubious ownership/i.test(result.stderr)) return 'git reported dubious ownership'
  const first = stripControl(result.stderr.trim().split('\n')[0] ?? '').slice(0, 200)
  return `git failed: ${first || `exit ${result.status}`}`
}

const unchecked = (path: string, display: string, result: GitResult): Destination => ({
  path,
  warning: `Warning: could not check with git whether ${display} is ignored: ${gitReason(result)}; make sure it is not committed.`,
})

// A dotfile target keeps its single leading dot, so `.env*` covers `.env.local.deepdock-tmp-ab12`.
const tempName = (path: string, suffix: string): string => {
  const name = basename(path)
  return `${name.startsWith('.') ? '' : '.'}${name}.deepdock-tmp-${suffix}`
}

const PROBE_SUFFIX = '0123456789ab'

const lineStart = (variable: string): RegExp =>
  new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${variable}[ \\t]*=`)

/** Replaces the first `variable=` line in place, drops repeats, or appends the line. */
export const upsertLine = (existing: string, variable: string, value: string): string => {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing === '' ? [] : existing.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  const matcher = lineStart(variable)
  const next: string[] = []
  let placed = false
  for (const line of lines) {
    const match = matcher.exec(line)
    if (!match) next.push(line)
    else if (!placed) {
      // Keeps a leading `export ` and any indentation the person wrote.
      next.push(`${match[1]}${variable}=${value}`)
      placed = true
    }
  }
  if (!placed) next.push(`${variable}=${value}`)
  return `${next.join(eol)}${eol}`
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

/**
 * Whether a written value is the key the API described by `keyPrefix`. The API's prefix is the
 * first characters after the scheme head (`ddk_test_` or `ddk_live_`), not the start of the key.
 */
export const isKeyWithPrefix = (value: string, keyPrefix: string): boolean =>
  new RegExp(`^[a-z]{3}_(test|live)_${escapeRegex(keyPrefix)}`).test(value)

/** Drops `variable=` lines holding the key with `prefix`; other values were not written by us. */
export const dropLine = (
  existing: string,
  variable: string,
  prefix: string,
): { content: string; removed: boolean } => {
  const matcher = lineStart(variable)
  let removed = false
  const kept = existing.split('\n').filter((line) => {
    if (!matcher.test(line)) return true
    const value = line
      .slice(line.indexOf('=') + 1)
      .replace(/\r$/, '')
      .trim()
      .replace(/^["']/, '')
    if (!isKeyWithPrefix(value, prefix)) return true
    removed = true
    return false
  })
  return { content: kept.join('\n'), removed }
}

const refuseSymlink = async (
  path: string,
  display: string,
  fail: (message: string, hint: string) => CliError,
): Promise<void> => {
  try {
    const stats = await fs.lstat(path)
    if (stats.isSymbolicLink()) {
      throw fail(`${display} is a symbolic link.`, 'Name the real file. Nothing was created.')
    }
    if (stats.isDirectory()) {
      throw fail(`${display} is a directory.`, 'Name a file. Nothing was created.')
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

const internal = (message: string, hint: string): CliError =>
  new CliError({ code: 'internal_error', message, hint })

/**
 * Checks a --write-env destination before any approval is requested: not a symlink, in an
 * existing directory, and inside a git repository only when git ignores it and does not track it.
 * Where git answers, its answer decides. Where git cannot answer (not installed, ownership or
 * permission errors, any other failure) the write is allowed with a warning naming the reason.
 */
export const checkDestination = async (rt: Runtime, file: string): Promise<Destination> => {
  const path = resolve(rt.cwd, file)
  const dir = dirname(path)
  const display = file
  try {
    const stats = await fs.stat(dir)
    if (!stats.isDirectory()) throw new Error('not a directory')
  } catch {
    throw usageError(`The directory of ${display} does not exist.`, 'Nothing was created.')
  }
  await refuseSymlink(path, display, usageError)

  const inside = await git(rt, dir, ['rev-parse', '--is-inside-work-tree'])
  if (inside.status !== 0) {
    if (inside.status !== 'missing' && /not a git repository/i.test(inside.stderr)) {
      return {
        path,
        warning: `Warning: ${path} is not inside a git repository; make sure it is never committed or shared.`,
      }
    }
    return unchecked(path, display, inside)
  }
  if (inside.stdout.trim() !== 'true') {
    throw usageError(
      `${display} is inside a .git directory.`,
      'Name a file in the work tree. Nothing was created.',
    )
  }
  const tracked = await git(rt, dir, ['ls-files', '--error-unmatch', '--', path])
  if (tracked.status === 0) {
    throw usageError(
      `${display} is tracked by git, so the key would be committed.`,
      'Use a file that is ignored (e.g. .env.local). Nothing was created.',
    )
  }
  if (tracked.status !== 1) return unchecked(path, display, tracked)
  const ignored = await git(rt, dir, ['check-ignore', '-q', '--', path])
  if (ignored.status === 1) {
    throw usageError(
      `${display} is not ignored by git, so the key would be committed.`,
      'Add it to .gitignore, or use a file that is ignored (e.g. .env.local). Nothing was created.',
    )
  }
  if (ignored.status !== 0) return unchecked(path, display, ignored)
  const probe = tempName(path, PROBE_SUFFIX)
  const probeIgnored = await git(rt, dir, ['check-ignore', '-q', '--', join(dir, probe)])
  if (probeIgnored.status === 1) {
    throw usageError(
      `The temporary file that holds the key while it is written (${probe.slice(0, -PROBE_SUFFIX.length)}…) is not ignored by git.`,
      'Add the line *.deepdock-tmp* (or a pattern such as .env*) to .gitignore. Nothing was created.',
    )
  }
  if (probeIgnored.status !== 0) return unchecked(path, display, probeIgnored)
  return { path }
}

const atomicWrite = async (path: string, content: string): Promise<void> => {
  await refuseSymlink(path, path, internal)
  // A random suffix: a crashed run's leftover is never ours to delete, and two runs never collide.
  const temp = join(dirname(path), tempName(path, randomBytes(6).toString('hex')))
  // Mode 600 from creation: the key is in this file before the rename.
  const handle = await fs.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.chmod(0o600)
  } catch (error) {
    await handle.close()
    await fs.rm(temp, { force: true })
    throw error
  }
  await handle.close()
  try {
    await renameWithRetry(temp, path)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
}

const KEY_SHAPE = /^[A-Za-z0-9_-]{16,}$/

export const writeEnvValue = async (
  path: string,
  variable: string,
  value: string,
): Promise<void> => {
  if (!KEY_SHAPE.test(value)) {
    throw internal(
      'The API answered a key in a shape this CLI will not write.',
      'Nothing was written.',
    )
  }
  let existing = ''
  try {
    existing = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await atomicWrite(path, upsertLine(existing, variable, value))
}

/**
 * Removes the line a key was written as, if the file still holds that key. Returns whether it did;
 * a file that cannot be read or replaced (still locked after the rename retries) throws.
 */
export const removeEnvValue = async (
  path: string,
  variable: string,
  prefix: string,
): Promise<boolean> => {
  let existing: string
  try {
    existing = await fs.readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  const { content, removed } = dropLine(existing, variable, prefix)
  if (removed) await atomicWrite(path, content)
  return removed
}
