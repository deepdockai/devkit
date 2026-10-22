import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The repository is public: it must hold no credential. What it must not name is checked from the
// private repository that owns it.
const SECRET_PATTERNS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'api-key-shape', pattern: /ddk_(test|live)_[A-Za-z0-9_-]{43}/ },
  { rule: 'access-key-shape', pattern: /\bak_[A-Za-z0-9]{24,}/ },
  { rule: 'provider-key-shape', pattern: /\b(sk|pk)_(test|live)_[A-Za-z0-9]{10,}/ },
]

/** Labels use forward slashes on every platform, so reports and tests read the same. */
const labelOf = (root: string, file: string): string => relative(root, file).replaceAll('\\', '/')

export const MAX_FILE_BYTES = 1024 * 1024

export type Finding = { file: string; line: number; rule: string }

/** Scans one file's text. A finding names the file, the line and the rule, never the secret. */
export const scanText = (file: string, text: string): Finding[] => {
  const findings: Finding[] = []
  text.split('\n').forEach((content, index) => {
    for (const { rule, pattern } of SECRET_PATTERNS) {
      if (pattern.test(content)) findings.push({ file, line: index + 1, rule })
    }
  })
  return findings
}

const isEnvFile = (name: string): boolean =>
  name === '.env' || (name.startsWith('.env.') && name !== '.env.example')

/** Scans a file by path: its name, its size, and its text. */
export const scanFile = (path: string, label: string): Finding[] => {
  const name = basename(path)
  const findings: Finding[] = []
  if (isEnvFile(name)) findings.push({ file: label, line: 0, rule: 'env-file' })
  if (statSync(path).size > MAX_FILE_BYTES)
    findings.push({ file: label, line: 0, rule: 'file-over-1mb' })
  const text = readFileSync(path, 'utf8')
  if (name.endsWith('.map') && text.includes('"sourcesContent"')) {
    findings.push({ file: label, line: 0, rule: 'sourcemap-with-sources' })
  }
  return [...findings, ...scanText(label, text)]
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage'])

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(join(dir, entry.name))
    return entry.isFile() ? [join(dir, entry.name)] : []
  })

export const REPO_ENTRIES: readonly string[] = [
  'src',
  'tests',
  'skill',
  'scripts',
  'docs',
  '.github',
  'README.md',
  'CLAUDE.md',
  'SECURITY.md',
  'LICENSE',
  'package.json',
  'biome.json',
  'tsconfig.json',
  '.gitignore',
]

/** Scans the repository's source, tests, skill, scripts, docs and top-level files. */
export const scanRepo = (root: string): Finding[] => {
  const findings: Finding[] = []
  for (const entry of REPO_ENTRIES) {
    const path = join(root, entry)
    if (!existsSync(path)) continue
    const files = statSync(path).isDirectory() ? walk(path) : [path]
    for (const file of files) findings.push(...scanFile(file, labelOf(root, file)))
  }
  // A stray env file anywhere at the top level is a leak even though it is gitignored.
  for (const entry of readdirSync(root)) {
    if (isEnvFile(entry)) findings.push({ file: entry, line: 0, rule: 'env-file' })
  }
  return findings
}

/** Scans every file of an unpacked directory, node_modules and all (a tarball has none). */
export const scanUnpacked = (dir: string): Finding[] =>
  readdirSyncRecursive(dir).flatMap((file) => scanFile(file, labelOf(dir, file)))

const readdirSyncRecursive = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? readdirSyncRecursive(join(dir, entry.name)) : [join(dir, entry.name)],
  )

/** Unpacks a tarball into a fresh directory and scans its content, as a consumer would get it. */
export const scanTarball = (tarball: string): Finding[] => {
  const work = mkdtempSync(join(tmpdir(), 'deepdock-pack-'))
  try {
    const unpacked = join(work, 'unpacked')
    mkdirSync(unpacked)
    // Relative names with a cwd: a drive letter in a tar argument is read as a host by GNU tar.
    copyFileSync(tarball, join(work, 'package.tgz'))
    execFileSync('tar', ['-xzf', 'package.tgz', '-C', 'unpacked'], { cwd: work })
    return scanUnpacked(unpacked).map((finding) => ({
      ...finding,
      file: `tarball:${finding.file}`,
    }))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** Packs the package with npm once and scans that tarball. */
export const scanPacked = (root: string): Finding[] => {
  const work = mkdtempSync(join(tmpdir(), 'deepdock-pack-'))
  try {
    const packed = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', work, '--ignore-scripts'],
      // npm is npm.cmd on Windows, which Node only starts through a shell; the arguments are fixed.
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
    )
    const [info] = JSON.parse(packed) as { filename: string }[]
    if (!info) throw new Error('npm pack produced no tarball')
    return scanTarball(join(work, info.filename))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const main = (): void => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  // --tarball <file> scans the exact file that will be published, and only that.
  const tarballIndex = process.argv.indexOf('--tarball')
  const tarball = tarballIndex === -1 ? undefined : process.argv[tarballIndex + 1]
  const findings = tarball
    ? scanTarball(tarball)
    : [...scanRepo(root), ...(process.argv.includes('--pack') ? scanPacked(root) : [])]
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} ${finding.rule}\n`)
  }
  if (findings.length > 0) {
    process.stderr.write(`checkPublic: ${findings.length} finding(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('checkPublic: clean\n')
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
