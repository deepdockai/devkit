import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  )

describe('source rules', () => {
  const sources = files(srcDir).map((file) => ({ file, text: readFileSync(file, 'utf8') }))

  it('imports the validation library only dynamically, and only in schemas.ts', () => {
    for (const { file, text } of sources) {
      const staticImport = /^import [^;]*from ['"]arktype['"]/m.test(text)
      expect(staticImport, file).toBe(false)
      if (!file.endsWith('schemas.ts')) expect(text.includes("import('arktype')"), file).toBe(false)
    }
  })

  it('uses no console, no process.exit and no function declarations', () => {
    for (const { file, text } of sources) {
      expect(/\bconsole\./.test(text), file).toBe(false)
      expect(/process\.exit\(/.test(text), file).toBe(false)
      expect(/^\s*(export )?(async )?function\b/m.test(text), file).toBe(false)
    }
  })
})
