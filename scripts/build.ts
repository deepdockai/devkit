import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg: { version: string } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outdir: fileURLToPath(new URL('../dist', import.meta.url)),
  naming: 'deepdock.js',
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  banner: '#!/usr/bin/env node',
})

if (!result.success) {
  for (const log of result.logs) process.stderr.write(`${log.message}\n`)
  process.exit(1)
}
