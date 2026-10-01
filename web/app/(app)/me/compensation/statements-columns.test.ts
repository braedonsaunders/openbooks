import assert from 'node:assert/strict'
import test from 'node:test'

// The statements table headers were hardcoded English ('period',
// 'generated') while the loader already shipped translated
// statementsColumns in all 7 locales. The spec now reads the headers from
// the loader data. French labels below prove the header comes from the
// data, never the source text.

const { myCompSpec } = await import('./view')

type SpecData = Parameters<typeof myCompSpec>[0]
type TableShape = { columns?: { header: unknown }[]; rowKey?: { $?: string } }
type Block = { kind?: string; widget?: string; props?: { table?: TableShape }; blocks?: Block[] } & TableShape

const data = {
  hasContent: true,
  statementsColumns: { period: 'Période', generated: 'Généré' },
  statements: [{ id: 'statement-1', period: '2026-01-01 – 2026-12-31', generated: '2026-01-15', pdfHref: null }],
} as unknown as SpecData

function statementHeaders(): unknown[] {
  const spec = myCompSpec(data) as unknown as { body: Block[] }
  const found: unknown[][] = []
  const collect = (table: TableShape | undefined): void => {
    if (table?.rowKey?.$ === 'id' && table.columns) {
      found.push(table.columns.map((c) => c.header))
    }
  }
  const walk = (blocks: Block[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.kind === 'table') collect(block)
      // Statements ride the shared registered list: the table config
      // lives on the widget's props.table, never as a bare table block.
      if (block.kind === 'widget' && block.widget === 'registered-record-list') collect(block.props?.table)
      walk(block.blocks)
    }
  }
  walk(spec.body)
  assert.equal(found.length, 1, 'the statements list carries exactly one table')
  return found[0] as unknown[]
}

test('statement headers read the translated loader labels', () => {
  // Headers are field refs the renderer resolves against the loader data
  // (which carries the translated labels): the paths must name
  // statementsColumns, never hardcoded English literals.
  assert.deepEqual(statementHeaders(), [{ $: 'statementsColumns.period' }, { $: 'statementsColumns.generated' }])
})
