import assert from 'node:assert/strict'

import test from 'node:test'

// The coverage matrix hid the 7th+ qualification type behind
// six fixed spec columns while the loader's truncation flag went unused.
// The spec now renders one column per required type from the loader data.
// These tests CALL the spec with eight required types and assert every one
// lands as a column — against the pre-fix spec only seven columns exist.

const { qualificationsSpec } = await import('./view')

type SpecData = Parameters<typeof qualificationsSpec>[0]
type TableShape = { columns?: { header: unknown }[]; rowKey?: { $?: string } }
type Block = { kind?: string; widget?: string; props?: { table?: TableShape }; blocks?: Block[] } & TableShape

const TYPES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']

const data = {
  section: 'requirements',
  tabs: [],
  coverageTypes: TYPES.map((code) => ({ code, name: `${code} name` })),
  coverageRows: [
    {
      employmentId: 'employment-1',
      workerName: 'Quinn Vidal',
      cells: TYPES.map(() => ({ label: 'Qualified', variant: 'success' })),
    },
  ],
} as unknown as SpecData

function coverageTable(): { header: unknown }[] {
  const spec = qualificationsSpec(data) as unknown as { body: Block[] }
  const tables: { header: unknown }[][] = []
  const collect = (table: TableShape | undefined): void => {
    if (table?.rowKey?.$ === 'employmentId' && table.columns) {
      tables.push(table.columns)
    }
  }
  const walk = (blocks: Block[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.kind === 'table') collect(block)
      // The matrix rides the shared registered list: its table config
      // lives on the widget's props.table, never as a bare table block.
      if (block.kind === 'widget' && block.widget === 'registered-record-list') collect(block.props?.table)
      walk(block.blocks)
    }
  }
  walk(spec.body)
  assert.equal(tables.length, 1, 'the requirements section carries exactly one crew coverage table')
  return tables[0] as { header: unknown }[]
}

test('the matrix renders one column per required type', () => {
  const columns = coverageTable()
  assert.equal(columns.length, 1 + TYPES.length, 'worker plus all eight types, never six fixed')
  assert.deepEqual(
    columns.slice(1).map((c) => c.header),
    TYPES,
    'every required type code lands as a column header in loader order',
  )
})
