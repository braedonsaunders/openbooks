import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { DOC_KINDS } from '../document-kinds.ts'
import type { DataResource } from './resource-core.ts'
import {
  CELL_PROVENANCE_KEY,
  SOURCE_COLUMNS_KEY,
  UNMAPPED_COLUMNS_KEY,
} from './types.ts'

interface ImportRouteState {
  resource: DataResource | null
  resourceWriteCalls: number
  rootInsertCalls: number
  transactionCalls: number
  mappedRows: Record<string, unknown>[] | null
}

const stateKey = Symbol.for('openbooks.data-import-route-test')
const importState: ImportRouteState = {
  resource: null,
  resourceWriteCalls: 0,
  rootInsertCalls: 0,
  transactionCalls: 0,
  mappedRows: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
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
      const state = globalThis[Symbol.for('openbooks.data-import-route-test')]
      export const schema = {
        documents: Symbol.for('openbooks.data-import-route-test.documents'),
        documentLines: Symbol.for('openbooks.data-import-route-test.document-lines'),
      }
      export const db = {
        async execute() {
          return { rows: [{ base_currency: 'CAD' }] }
        },
        insert() {
          state.rootInsertCalls++
          throw new Error('root inserts are not expected during a preview')
        },
        async transaction() {
          state.transactionCalls++
          throw new Error('transactions are not expected during a preview')
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function can() {
        return true
      }

      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' } }
      }
    `,
  ],
  [
    'mock:resources',
    `
      const state = globalThis[Symbol.for('openbooks.data-import-route-test')]
      export async function getResource() {
        if (!state.resource) throw new Error('transaction resource was not installed')
        return state.resource
      }
    `,
  ],
  [
    'mock:parse',
    `
      export async function parseImportFile() {
        throw new Error('route parse mode is not expected in this preview test')
      }

      export function guessMapping() {
        return {}
      }
    `,
  ],
  [
    'mock:posting',
    `
      export async function postDocument() {
        throw new Error('postDocument is not expected during a preview')
      }
    `,
  ],
  [
    'mock:documents',
    `
      export async function controlDeps() {
        throw new Error('controlDeps is not expected during a preview')
      }

      export async function nextDocumentNumber() {
        throw new Error('nextDocumentNumber is not expected during a preview')
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      export const MAX_EXPORT_ROWS = 50_000

      export async function orgFeatureEnabled() {
        return false
      }

      export class RefResolver {
        async resolveId(target, human) {
          if (target.resource === 'accounts' && String(human) === '5000') {
            return 'account-1'
          }
          return null
        }
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
      ['@/lib/api/json', 'mock:json'],
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['@openbooks/engine/src/posting.ts', 'mock:posting'],
      ['../documents', 'mock:documents'],
      ['./resource-core', 'mock:resource-core'],
      ['../../../../lib/authz', 'mock:authz'],
      ['../../../../lib/data-io/resources', 'mock:resources'],
      ['../../../../lib/data-io/parse', 'mock:parse'],
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

const transactionUrl = './transaction-resources.ts?generic-import-route-test'
const { transactionResource } = await import(transactionUrl) as typeof import('./transaction-resources.ts')
const cardCharge = DOC_KINDS.card_charge
assert.ok(cardCharge)
const actualResource = transactionResource(cardCharge, 'org-1')
importState.resource = {
  ...actualResource,
  async write(rows, mode, ctx) {
    importState.resourceWriteCalls++
    importState.mappedRows = structuredClone(rows)
    return actualResource.write(rows, mode, ctx)
  },
}
const routeUrl = '../../app/api/data/import/route.ts?duplicate-mapping-test'
const { POST } = await import(routeUrl) as typeof import('../../app/api/data/import/route.ts')
const parseUrl = './parse.ts?duplicate-mapping-route-test'
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

function resetImportState(): void {
  importState.resourceWriteCalls = 0
  importState.rootInsertCalls = 0
  importState.transactionCalls = 0
  importState.mappedRows = null
}

test('reserved import metadata wire keys have one shared definition', async () => {
  const files = [
    './types.ts',
    './parse.ts',
    './transaction-resources.ts',
    './prior-payroll-register-resource.ts',
    '../../app/api/data/import/route.ts',
  ]
  const sources = await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  )
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const key of [CELL_PROVENANCE_KEY, SOURCE_COLUMNS_KEY, UNMAPPED_COLUMNS_KEY]) {
    const definition = new RegExp(`=\\s*(['"])${escapeRegExp(key)}\\1`, 'g')
    const count = sources.reduce(
      (total, source) => total + Array.from(source.matchAll(definition)).length,
      0,
    )
    assert.equal(count, 1, `${key} must have exactly one production definition`)
  }
})

async function parsedFormulaRow(kind: 'amount' | 'lines'): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  if (kind === 'amount') {
    sheet.addRow(['documentDate', 'account', 'literal_amount', 'formula_amount'])
    sheet.addRow([
      '2026-08-24',
      '5000',
      '999999999999998.9900',
      {
        formula: 'TEXT(999999999999998.99,"0.0000")',
        result: '999999999999999.0000',
      },
    ])
  } else {
    const lines = '[{"account":"5000","amount":"999999999999998.9900"}]'
    sheet.addRow(['documentDate', 'literal_lines', 'formula_lines'])
    sheet.addRow(['2026-08-24', lines, { formula: 'A1', result: lines }])
  }
  const buffer = await workbook.xlsx.writeBuffer()
  const parsed = await parseImportFile('xlsx', {
    base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
  })
  const row = parsed.rows[0]
  assert.ok(row)
  return row
}

async function parsedHyperlinkedFormulaRows(): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  sheet.addRow([
    'documentDate',
    'account',
    'numeric_hyperlink_amount',
    'string_hyperlink_amount',
  ])
  sheet.addRow([
    '2026-08-24',
    '5000',
    { formula: '999999999999998.99', result: 999999999999998.99 },
    '',
  ])
  sheet.addRow([
    '2026-08-24',
    '5000',
    '',
    {
      formula: 'TEXT(999999999999998.99,"0.0000")',
      result: '999999999999999.0000',
    },
  ])

  // ExcelJS cannot author a formula and hyperlink on the same cell through
  // its public value API, but real workbooks can carry both. Add the standard
  // worksheet hyperlink relationships to the XLSX package after serialization.
  const zip = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer() as ArrayBuffer))
  const sheetFile = zip.file('xl/worksheets/sheet1.xml')
  assert.ok(sheetFile)
  const sheetXml = await sheetFile.async('string')
  assert.match(sheetXml, /<\/worksheet>$/)
  zip.file(
    'xl/worksheets/sheet1.xml',
    sheetXml.replace(
      '</worksheet>',
      '<hyperlinks><hyperlink ref="C2" r:id="rId1"/><hyperlink ref="D3" r:id="rId2"/></hyperlinks></worksheet>',
    ),
  )
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/numeric" TargetMode="External"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.test/string" TargetMode="External"/>' +
      '</Relationships>',
  )
  const linkedWorkbook = await zip.generateAsync({ type: 'nodebuffer' })
  return (
    await parseImportFile('xlsx', { base64: linkedWorkbook.toString('base64') })
  ).rows
}

async function preview(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'preview',
      resource: 'txn:card_charge',
      format: 'xlsx',
      rows,
      mapping,
      importMode: 'insert',
    }),
  }))
}

test('route rejects duplicate amount mappings before a formula value can outrun its provenance', async () => {
  resetImportState()
  const row = await parsedFormulaRow('amount')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { formula_amount: 'formula' })

  const response = await preview([row], {
    documentDate: 'documentDate',
    account: 'account',
    literal_amount: 'amount',
    formula_amount: 'amount',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'multiple source columns map to the same target field',
    field: 'amount',
    sources: ['literal_amount', 'formula_amount'],
  })
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
})

test('route rejects duplicate nested-lines mappings before a formula value can outrun its provenance', async () => {
  resetImportState()
  const row = await parsedFormulaRow('lines')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { formula_lines: 'formula' })

  const response = await preview([row], {
    documentDate: 'documentDate',
    literal_lines: 'lines',
    formula_lines: 'lines',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'multiple source columns map to the same target field',
    field: 'lines',
    sources: ['literal_lines', 'formula_lines'],
  })
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
})

test('route carries renamed amount provenance into transaction validation before writes', async () => {
  resetImportState()
  const row = await parsedFormulaRow('amount')

  const response = await preview([row], {
    documentDate: 'documentDate',
    account: 'account',
    formula_amount: 'amount',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    outcome: {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [
        {
          row: 1,
          message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
        },
      ],
    },
    total: 1,
  })
  assert.equal(importState.resourceWriteCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
  const mappedRow = importState.mappedRows?.[0]
  assert.ok(mappedRow)
  assert.deepEqual(mappedRow[SOURCE_COLUMNS_KEY], {
    documentDate: 'documentDate',
    account: 'account',
    amount: 'formula_amount',
  })
  assert.deepEqual(mappedRow[UNMAPPED_COLUMNS_KEY], {
    literal_amount: '999999999999998.9900',
  })
})

test('route binds provenance to the selected amount source', async () => {
  resetImportState()
  const row = await parsedFormulaRow('amount')

  const response = await preview([row], {
    documentDate: 'documentDate',
    account: 'account',
    literal_amount: 'amount',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    outcome: { created: 1, updated: 0, failed: 0, errors: [] },
    total: 1,
  })
  assert.equal(importState.resourceWriteCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
  const mappedRow = importState.mappedRows?.[0]
  assert.ok(mappedRow)
  assert.deepEqual(mappedRow[SOURCE_COLUMNS_KEY], {
    documentDate: 'documentDate',
    account: 'account',
    amount: 'literal_amount',
  })
  assert.deepEqual(mappedRow[UNMAPPED_COLUMNS_KEY], {
    formula_amount: '999999999999999.0000',
  })
})

test('route carries renamed nested-lines provenance into transaction validation before writes', async () => {
  resetImportState()
  const row = await parsedFormulaRow('lines')

  const response = await preview([row], {
    documentDate: 'documentDate',
    formula_lines: 'lines',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    outcome: {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [
        {
          row: 1,
          message: 'lines cannot come from a spreadsheet formula; provide literal JSON text',
        },
      ],
    },
    total: 1,
  })
  assert.equal(importState.resourceWriteCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
})

test('route carries hyperlinked formula provenance into transaction validation before writes', async (t) => {
  const [numericRow, stringRow] = await parsedHyperlinkedFormulaRows()
  assert.ok(numericRow)
  assert.ok(stringRow)
  const cases = [
    {
      name: 'numeric cached result',
      row: numericRow,
      source: 'numeric_hyperlink_amount',
      value: 999999999999999,
    },
    {
      name: 'string cached result',
      row: stringRow,
      source: 'string_hyperlink_amount',
      value: '999999999999999.0000',
    },
  ] as const

  for (const { name, row, source, value } of cases) {
    await t.test(`rejects ${name}`, async () => {
      resetImportState()
      assert.equal(row[source], value)

      const response = await preview([row], {
        documentDate: 'documentDate',
        account: 'account',
        [source]: 'amount',
      })

      assert.equal(importState.resourceWriteCalls, 1)
      assert.equal(importState.rootInsertCalls, 0)
      assert.equal(importState.transactionCalls, 0)
      assert.deepEqual(row[CELL_PROVENANCE_KEY], { [source]: 'formula' })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), {
        outcome: {
          created: 0,
          updated: 0,
          failed: 1,
          errors: [
            {
              row: 1,
              message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
            },
          ],
        },
        total: 1,
      })
    })
  }
})
