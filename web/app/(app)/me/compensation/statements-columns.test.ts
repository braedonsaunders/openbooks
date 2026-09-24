import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F3-90: the statements table headers were hardcoded English ('period',
// 'generated') while the loader already shipped translated
// statementsColumns in all 7 locales. The spec now reads the headers from
// the loader data. French labels below prove the header comes from the
// data, never the source text.

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { myCompSpec } = await import('./view')

type SpecData = Parameters<typeof myCompSpec>[0]
type Block = { kind?: string; blocks?: Block[]; columns?: { header: unknown }[]; rowKey?: { $?: string } }

const data = {
  hasContent: true,
  statementsColumns: { period: 'Période', generated: 'Généré' },
  statements: [{ id: 'statement-1', period: '2026-01-01 – 2026-12-31', generated: '2026-01-15', pdfHref: null }],
} as unknown as SpecData

function statementHeaders(): unknown[] {
  const spec = myCompSpec(data) as unknown as { body: Block[] }
  const found: unknown[][] = []
  const walk = (blocks: Block[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.kind === 'table' && block.rowKey?.$ === 'id' && block.columns) {
        found.push(block.columns.map((c) => c.header))
      }
      walk(block.blocks)
    }
  }
  walk(spec.body)
  assert.equal(found.length, 1, 'the statements panel carries exactly one table')
  return found[0] as unknown[]
}

test('F3-90: statement headers read the translated loader labels', () => {
  // Headers are field refs the renderer resolves against the loader data
  // (which carries the translated labels): the paths must name
  // statementsColumns, never hardcoded English literals.
  assert.deepEqual(statementHeaders(), [{ $: 'statementsColumns.period' }, { $: 'statementsColumns.generated' }])
})
