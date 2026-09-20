import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
const facade = readFileSync(join(dir, 'run.ts'), 'utf8')

const relativeImports = (source: string): string[] =>
  [...source.matchAll(/from\s+["'](\.[^"']*)["']/g)].map((m) => m[1]!)

test('pay run facade stays thin and implementation-free', () => {
  assert.ok(facade.split('\n').length <= 200, `facade is ${facade.split('\n').length} lines, limit 200`)
  assert.match(facade, /export\s*\{[^}]*\}\s*from\s*"\.\/run-setup\.ts"/)
  assert.doesNotMatch(facade, /async function |db\.transaction|from\s+"\.\.\//)
  for (const target of relativeImports(facade)) {
    assert.ok(!target.endsWith('/run') && target !== './run', `facade must not import itself: ${target}`)
  }
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

const exportedNames = (source: string): Set<string> => {
  const names = new Set<string>()
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|interface|type|const|class|enum)\s+(\w+)/gm)) {
    names.add(m[1]!)
  }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const item of m[1]!.split(',')) {
      const name = item.trim().replace(/^type\s+/, '')
      if (name) names.add(name.split(/\s+as\s+/).pop()!.trim())
    }
  }
  return names
}

test('facade re-exports resolve and cover every intra-payroll consumer', () => {
  const facadeExports = new Map<string, string>()
  for (const m of facade.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']*)["']/g)) {
    for (const item of m[1]!.split(',')) {
      const name = item.trim().replace(/^type\s+/, '')
      if (name) facadeExports.set(name.split(/\s+as\s+/).pop()!.trim(), m[2]!)
    }
  }
  for (const [name, from] of facadeExports) {
    if (!from.startsWith('./run-')) continue
    const target = readFileSync(join(dir, from.slice(2).endsWith('.ts') ? from.slice(2) : `${from.slice(2)}.ts`), 'utf8')
    assert.ok(exportedNames(target).has(name), `facade advertises ${name} but ${from}.ts does not export it`)
  }
  const consumers = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && f !== 'run.ts' && !f.endsWith('.test.ts'),
  )
  for (const file of consumers) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/run\.ts["']/g)) {
      for (const item of m[1]!.split(',')) {
        const name = item.trim().replace(/^type\s+/, '')
        if (!name) continue
        const local = name.split(/\s+as\s+/).pop()!.trim()
        const imported = name.split(/\s+as\s+/)[0]!.trim()
        assert.ok(facadeExports.has(imported), `${file} imports ${local} from ./run.ts but the facade no longer exports it`)
      }
    }
    const typeOnly = source.match(/import\s+type\s*\{([^}]*)\}\s*from\s*["']\.\/run\.ts["']/)
    if (typeOnly) {
      for (const item of typeOnly[1]!.split(',')) {
        const name = item.trim()
        if (name) assert.ok(facadeExports.has(name), `${file} imports type ${name} from ./run.ts but the facade no longer exports it`)
      }
    }
  }
})
