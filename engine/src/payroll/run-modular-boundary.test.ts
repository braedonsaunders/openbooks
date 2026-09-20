import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Pay-run module boundary: run.ts is a thin facade over run-*.ts operation
 * modules. Internal modules must never backimport the facade (that would
 * re-create the god file as a cycle), the sibling graph must be acyclic, and
 * the facade must stay free of implementation so every public name keeps one
 * home. Source-text only: no engine imports, no database.
 */
const dir = dirname(fileURLToPath(import.meta.url))
const sources = readdirSync(dir)
  .filter((f) => f.startsWith('run-') && f.endsWith('.ts') && !f.endsWith('.test.ts'))


const relativeImports = (source: string): string[] =>
  [...source.matchAll(/from\s+["'](\.[^"']*)["']/g)].map((m) => m[1]!)

test('pay run legacy entrypoint is deleted and operations stay bounded', () => {
  assert.equal(existsSync(join(dir, 'run.ts')), false)
  for (const file of sources) assert.ok(readFileSync(join(dir, file), 'utf8').split('\n').length <= 800, `${file} exceeds 800 lines`)
})

test('pay run operation modules never backimport the facade', () => {
  for (const file of sources) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const target of relativeImports(source)) {
      assert.ok(
        target !== './run' && target !== './run.ts' && target !== './run.js',
        `${file} backimports the facade via ${target}`,
      )
    }
  }
})

test('pay run operation modules form no static import cycle', () => {
  const edges = new Map<string, string[]>()
  for (const file of sources) {
    const source = readFileSync(join(dir, file), 'utf8')
    edges.set(
      file,
      relativeImports(source)
        .filter((t) => t.startsWith('./run-') && sources.includes(t.slice(2).endsWith('.ts') ? t.slice(2) : `${t.slice(2)}.ts`))
        .map((t) => t.slice(2).endsWith('.ts') ? t.slice(2) : `${t.slice(2)}.ts`),
    )
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (file: string, trail: string[]): void => {
    if (done.has(file)) return
    assert.ok(!visiting.has(file), `import cycle: ${[...trail, file].join(' -> ')}`)
    visiting.add(file)
    for (const next of edges.get(file) ?? []) visit(next, [...trail, file])
    visiting.delete(file)
    done.add(file)
  }
  for (const file of sources) visit(file, [])
})
