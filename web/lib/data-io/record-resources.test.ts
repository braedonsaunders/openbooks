import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import type { FormSection } from '@openbooks/forms-core'
import { CELL_PROVENANCE_KEY } from './types.ts'

interface RecordImportState {
  searchData: Record<string, unknown> | null
}

const stateKey = Symbol.for('openbooks.record-import-test')
const importState: RecordImportState = { searchData: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    'mock:db',
    `
      export const schema = {}
      export const db = {
        async execute() {
          throw new Error('database execution is not expected during this dry-run test')
        },
      }
    `,
  ],
  [
    'mock:records',
    `
      const state = globalThis[Symbol.for('openbooks.record-import-test')]

      export async function loadRecordTypeByKey() {
        return { id: 'record-type-1', status: 'published' }
      }

      export async function buildSearchText(_sections, data) {
        state.searchData = structuredClone(data)
        return 'record search text'
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      export const MAX_EXPORT_ROWS = 50_000

      export class RefResolver {
        async resolveId() {
          throw new Error('reference resolution is not expected in this test')
        }
      }

      export async function exportCell(_field, value) {
        return value
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    const mockUrl = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['../records', 'mock:records'],
      ['./resource-core', 'mock:resource-core'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const resourceUrl = './record-resources.ts?xlsx-field-aware-import-test'
const { recordResource } = await import(resourceUrl) as typeof import('./record-resources.ts')
const parseUrl = './parse.ts?record-xlsx-field-aware-import-test'
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

const sections: FormSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      { id: 'external_id', label: 'External ID', type: 'text', required: true },
      {
        id: 'category',
        label: 'Category',
        type: 'select',
        required: true,
        validation: { options: [{ value: '101', label: 'Category 101' }] },
      },
      {
        id: 'priority',
        label: 'Priority',
        type: 'radio',
        required: true,
        validation: { options: [{ value: '202', label: 'Priority 202' }] },
      },
      { id: 'quantity', label: 'Quantity', type: 'number', required: true },
      { id: 'amount', label: 'Amount', type: 'currency', required: true },
    ],
  },
]

async function parsedWorkbookRow(): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Custom records')
  sheet.addRow(['external_id', 'category', 'priority', 'quantity', 'amount'])
  sheet.addRow([
    123456,
    101,
    { formula: '101+101', result: 202 },
    7.5,
    42.25,
  ])
  const buffer = await workbook.xlsx.writeBuffer()
  const parsed = await parseImportFile('xlsx', {
    base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
  })
  const row = parsed.rows[0]
  assert.ok(row)
  return row
}

test('custom-record XLSX import coerces schema-owned text and choice fields to display strings', async () => {
  importState.searchData = null
  const row = await parsedWorkbookRow()
  assert.equal(typeof row.external_id, 'number')
  assert.equal(typeof row.category, 'number')
  assert.equal(typeof row.priority, 'number')
  assert.equal(typeof row.quantity, 'number')
  assert.equal(typeof row.amount, 'number')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { priority: 'formula' })

  const outcome = await recordResource('org-1', 'inventory-tag', sections, 'Inventory tag').write(
    [row],
    'insert',
    { orgId: 'org-1', actorId: 'actor-1', dryRun: true },
  )

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  const searchData = importState.searchData as Record<string, unknown> | null
  assert.ok(searchData)
  assert.deepEqual(searchData, {
    external_id: '123456',
    category: '101',
    priority: '202',
    quantity: 7.5,
    amount: 42.25,
  })
  assert.equal(typeof searchData.external_id, 'string')
  assert.equal(typeof searchData.category, 'string')
  assert.equal(typeof searchData.priority, 'string')
  assert.equal(typeof searchData.quantity, 'number')
  assert.equal(typeof searchData.amount, 'number')
})
