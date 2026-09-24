import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F3-69 (data): the coverage matrix hid the 7th+ qualification type behind
// six fixed spec columns while the loader's truncation flag went unused.
// The spec now renders one column per required type from the loader data.
// These tests CALL the spec with eight required types and assert every one
// lands as a column — against the pre-fix spec only seven columns exist.

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})

const { qualificationsSpec } = await import('./view')

type SpecData = Parameters<typeof qualificationsSpec>[0]
type Block = { kind?: string; blocks?: Block[]; columns?: { header: unknown }[]; rowKey?: { $?: string } }

const TYPES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']

const data = {
  section: 'requirements',
  tabs: [],
  viewTabs: [],
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
  const walk = (blocks: Block[] | undefined): void => {
    for (const block of blocks ?? []) {
      if (block.kind === 'table' && block.rowKey?.$ === 'employmentId' && block.columns) {
        tables.push(block.columns)
      }
      walk(block.blocks)
    }
  }
  walk(spec.body)
  assert.equal(tables.length, 1, 'the requirements section carries exactly one crew coverage table')
  return tables[0] as { header: unknown }[]
}

test('F3-69: the matrix renders one column per required type', () => {
  const columns = coverageTable()
  assert.equal(columns.length, 1 + TYPES.length, 'worker plus all eight types, never six fixed')
  assert.deepEqual(
    columns.slice(1).map((c) => c.header),
    TYPES,
    'every required type code lands as a column header in loader order',
  )
})
