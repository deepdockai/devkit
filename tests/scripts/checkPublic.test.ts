import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES,
  packedFilename,
  scanFile,
  scanPacked,
  scanRepo,
  scanTarball,
  scanText,
} from '../../scripts/checkPublic.ts'

// Fixtures are assembled at run time so this file holds no key-shaped literal.
const piece = (...parts: string[]): string => parts.join('')

describe('scanText: documented negatives', () => {
  it('ignores prose about the product itself', () => {
    expect(scanText('f.ts', 'Pair a device, list its actions, create an API key.')).toEqual([])
  })

  it('ignores short prefixes that are not key shapes', () => {
    expect(scanText('f.ts', 'ak_short sk_ pk_test_ ddk_live_7Hq2mN4p')).toEqual([])
  })
})

describe('scanText: secret shapes', () => {
  it('flags an API key shape', () => {
    const key = piece('ddk', '_', 'live', '_', 'A'.repeat(43))
    expect(scanText('f.ts', `KEY=${key}`)).toEqual([
      { file: 'f.ts', line: 1, rule: 'api-key-shape' },
    ])
    expect(
      scanText('f.ts', `KEY=${piece('ddk', '_', 'test', '_', 'b-_'.repeat(15).slice(0, 43))}`),
    ).toHaveLength(1)
  })

  it('flags an access key and a provider key shape', () => {
    expect(scanText('f.ts', piece('x ak', '_', 'a1B2'.repeat(6)))).toEqual([
      { file: 'f.ts', line: 1, rule: 'access-key-shape' },
    ])
    expect(scanText('f.ts', piece('sk', '_', 'test', '_', 'abcdefghij12'))).toEqual([
      { file: 'f.ts', line: 1, rule: 'provider-key-shape' },
    ])
    expect(scanText('f.ts', piece('pk', '_', 'live', '_', 'abcdefghij12'))).toHaveLength(1)
  })

  it('never puts the matched text into a finding', () => {
    const key = piece('ddk', '_', 'live', '_', 'Z'.repeat(43))
    expect(JSON.stringify(scanText('f.ts', key))).not.toContain('ZZZZ')
  })
})

describe('scanFile and scanRepo', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deepdock-scan-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('flags env files except .env.example', () => {
    writeFileSync(join(dir, '.env'), '')
    writeFileSync(join(dir, '.env.local'), '')
    writeFileSync(join(dir, '.env.example'), '')
    expect(scanFile(join(dir, '.env'), '.env')).toEqual([
      { file: '.env', line: 0, rule: 'env-file' },
    ])
    expect(scanFile(join(dir, '.env.local'), '.env.local')).toHaveLength(1)
    expect(scanFile(join(dir, '.env.example'), '.env.example')).toEqual([])
  })

  it('flags a sourcemap that embeds sources, not one that does not', () => {
    writeFileSync(join(dir, 'a.js.map'), '{"version":3,"sourcesContent":["x"]}')
    writeFileSync(join(dir, 'b.js.map'), '{"version":3,"mappings":""}')
    expect(scanFile(join(dir, 'a.js.map'), 'a.js.map')).toEqual([
      { file: 'a.js.map', line: 0, rule: 'sourcemap-with-sources' },
    ])
    expect(scanFile(join(dir, 'b.js.map'), 'b.js.map')).toEqual([])
  })

  it('flags a file over 1 MB', () => {
    writeFileSync(join(dir, 'big.txt'), 'a'.repeat(MAX_FILE_BYTES + 1))
    writeFileSync(join(dir, 'ok.txt'), 'a'.repeat(MAX_FILE_BYTES))
    expect(scanFile(join(dir, 'big.txt'), 'big.txt')).toEqual([
      { file: 'big.txt', line: 0, rule: 'file-over-1mb' },
    ])
    expect(scanFile(join(dir, 'ok.txt'), 'ok.txt')).toEqual([])
  })

  it('walks the listed directories and skips node_modules', () => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'src', 'a.ts'), `// ${piece('ddk', '_', 'live', '_', 'A'.repeat(43))}`)
    writeFileSync(
      join(dir, 'node_modules', 'b.ts'),
      `// ${piece('ddk', '_', 'live', '_', 'A'.repeat(43))}`,
    )
    writeFileSync(join(dir, 'README.md'), 'clean')
    const findings = scanRepo(dir)
    expect(findings.map((finding) => finding.file)).toEqual(['src/a.ts'])
  })
})

describe('this repository', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))

  it('holds no secret', () => {
    expect(scanRepo(root)).toEqual([])
  })

  // `npm pack` is slow on a Windows runner: the default 20 s was not enough there.
  it('packs into a tarball with no secret, env file, sourcemap or large file', () => {
    expect(scanPacked(root)).toEqual([])
  }, 120_000)
})

describe('scanTarball', () => {
  it('scans a tarball it is given, not the working tree', () => {
    const work = mkdtempSync(join(tmpdir(), 'deepdock-tgz-'))
    try {
      mkdirSync(join(work, 'package'))
      writeFileSync(
        join(work, 'package', 'a.js'),
        `// ${piece('ddk', '_', 'live', '_', 'A'.repeat(43))}`,
      )
      execFileSync('tar', ['-czf', 'x.tgz', 'package'], { cwd: work })
      const findings = scanTarball(join(work, 'x.tgz'))
      expect(findings).toHaveLength(1)
      expect(findings[0]?.file).toBe('tarball:package/a.js')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('packedFilename', () => {
  it('reads the array npm 11 and earlier print', () => {
    expect(packedFilename(JSON.stringify([{ filename: 'deepdockai-cli-1.0.0.tgz' }]))).toBe(
      'deepdockai-cli-1.0.0.tgz',
    )
  })

  it('reads the object keyed by package name npm 12 prints', () => {
    const output = JSON.stringify({ '@deepdockai/cli': { filename: 'deepdockai-cli-1.0.0.tgz' } })
    expect(packedFilename(output)).toBe('deepdockai-cli-1.0.0.tgz')
  })

  it('refuses an empty result', () => {
    expect(() => packedFilename('[]')).toThrow('npm pack produced no tarball')
    expect(() => packedFilename('{}')).toThrow('npm pack produced no tarball')
  })
})
