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
  resourceLookupCalls: number
  resourceWriteCalls: number
  rootInsertCalls: number
  transactionCalls: number
  transactionInsertTargets: string[]
  rollbacks: number
  mappedRows: Record<string, unknown>[] | null
  withOrgTransactionCalls: number
  orgTransactionRollbacks: number
  historyInsertCalls: number
  outOfTransactionHistoryInserts: number
  failHistoryInsert: boolean
  insideOrgTransaction: boolean
  activeOrgTxn: {
    orgId: string
    documents: Record<string, unknown>[]
    lines: Record<string, unknown>[]
    historyJobs: Record<string, unknown>[]
  } | null
  committed: {
    documents: Record<string, unknown>[]
    lines: Record<string, unknown>[]
    historyJobs: Record<string, unknown>[]
  }
}

const stateKey = Symbol.for('openbooks.data-import-route-test')
const importState: ImportRouteState = {
  resource: null,
  resourceLookupCalls: 0,
  resourceWriteCalls: 0,
  rootInsertCalls: 0,
  transactionCalls: 0,
  transactionInsertTargets: [],
  rollbacks: 0,
  mappedRows: null,
  withOrgTransactionCalls: 0,
  orgTransactionRollbacks: 0,
  historyInsertCalls: 0,
  outOfTransactionHistoryInserts: 0,
  failHistoryInsert: false,
  insideOrgTransaction: false,
  activeOrgTxn: null,
  committed: { documents: [], lines: [], historyJobs: [] },
}
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
      const state = globalThis[Symbol.for('openbooks.data-import-route-test')]
      export const schema = {
        documents: Symbol.for('openbooks.data-import-route-test.documents'),
        documentLines: Symbol.for('openbooks.data-import-route-test.document-lines'),
      }

      function statementText(query) {
        return Array.isArray(query?.strings) ? query.strings.join('') : String(query)
      }

      function isInsertStatement(query) {
        return /\\binsert\\s+into\\b/i.test(statementText(query))
      }

      // Writes land in the active org transaction's staging buffer while one
      // is open (that is how withOrgTransaction participation behaves) and in
      // the committed store otherwise.
      function buffer() {
        return state.activeOrgTxn ?? state.committed
      }

      async function executeOnConnection(query) {
        const text = statementText(query)
        if (/select\\s+base_currency\\s+from\\s+orgs/i.test(text)) {
          return { rows: [{ base_currency: 'CAD' }] }
        }
        if (/\\binsert\\s+into\\s+import_jobs\\b/i.test(text)) {
          state.historyInsertCalls++
          if (!state.insideOrgTransaction) state.outOfTransactionHistoryInserts++
          if (state.failHistoryInsert) {
            throw new Error('forced import_jobs insert failure')
          }
          buffer().historyJobs.push({ values: query.values })
          return { rows: [{ id: 'job-1' }] }
        }
        return { rows: [] }
      }

      export async function withOrgTransaction(orgId, work) {
        state.withOrgTransactionCalls++
        if (state.activeOrgTxn) {
          throw new Error('nested org transactions are not expected')
        }
        state.activeOrgTxn = { orgId, documents: [], lines: [], historyJobs: [] }
        state.insideOrgTransaction = true
        try {
          const result = await work()
          state.committed.documents.push(...state.activeOrgTxn.documents)
          state.committed.lines.push(...state.activeOrgTxn.lines)
          state.committed.historyJobs.push(...state.activeOrgTxn.historyJobs)
          return result
        } catch (error) {
          state.orgTransactionRollbacks++
          throw error
        } finally {
          state.insideOrgTransaction = false
          state.activeOrgTxn = null
        }
      }

      export const db = {
        execute(query) {
          if (isInsertStatement(query) && !state.insideOrgTransaction) {
            state.outOfTransactionInsertStatements =
              (state.outOfTransactionInsertStatements ?? 0) + 1
          }
          return executeOnConnection(query)
        },
        insert() {
          state.rootInsertCalls++
          throw new Error('root inserts are not expected during any import mode')
        },
        async transaction(callback) {
          state.transactionCalls++
          const pending = { documents: [], lines: [] }
          try {
            const result = await callback({
              execute(query) {
                if (isInsertStatement(query) && !state.insideOrgTransaction) {
                  state.outOfTransactionInsertStatements =
                    (state.outOfTransactionInsertStatements ?? 0) + 1
                }
                return executeOnConnection(query)
              },
              insert(target) {
                if (target === schema.documents) {
                  state.transactionInsertTargets.push('documents')
                  return {
                    values(values) {
                      return {
                        async returning() {
                          pending.documents.push({ ...values, id: 'document-1' })
                          return [{ id: 'document-1' }]
                        },
                      }
                    },
                  }
                }
                if (target === schema.documentLines) {
                  state.transactionInsertTargets.push('documentLines')
                  return {
                    values(values) {
                      const lines = Array.isArray(values) ? values : [values]
                      pending.lines.push(...lines.map((line) => ({ ...line })))
                      return Promise.resolve()
                    },
                  }
                }
                throw new Error('unexpected insert target')
              },
            })
            const buffer_ = buffer()
            buffer_.documents.push(...pending.documents)
            buffer_.lines.push(...pending.lines)
            return result
          } catch (error) {
            state.rollbacks++
            throw error
          }
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
        state.resourceLookupCalls++
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
        return 'CC-000001'
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
  importState.resourceLookupCalls = 0
  importState.resourceWriteCalls = 0
  importState.rootInsertCalls = 0
  importState.transactionCalls = 0
  importState.transactionInsertTargets.length = 0
  importState.rollbacks = 0
  importState.mappedRows = null
  importState.withOrgTransactionCalls = 0
  importState.orgTransactionRollbacks = 0
  importState.historyInsertCalls = 0
  importState.outOfTransactionHistoryInserts = 0
  importState.failHistoryInsert = false
  importState.insideOrgTransaction = false
  importState.activeOrgTxn = null
  importState.committed.documents.length = 0
  importState.committed.lines.length = 0
  importState.committed.historyJobs.length = 0
}

test('route rejects an unknown mode before resource lookup or writes', async () => {
  resetImportState()

  const response = await POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'publish',
      resource: 'txn:card_charge',
      rows: [],
    }),
  }))

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error, 'mode must be parse, preview or commit')
  assert.equal(importState.resourceLookupCalls, 0)
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.transactionCalls, 0)
})

test('route rejects an unknown format instead of importing it as csv', async () => {
  resetImportState()

  const response = await POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'preview',
      resource: 'txn:card_charge',
      format: 'xml',
      rows: [],
      mapping: {},
    }),
  }))

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error, 'format must be csv, xlsx or json')
  assert.equal(importState.resourceLookupCalls, 0)
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.withOrgTransactionCalls, 0)
  assert.equal(importState.historyInsertCalls, 0)
})

test('route rejects an unknown importMode instead of coercing it to upsert', async () => {
  resetImportState()

  const response = await POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'preview',
      resource: 'txn:card_charge',
      rows: [],
      mapping: {},
      importMode: 'replace',
    }),
  }))

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error, 'importMode must be insert or upsert')
  assert.equal(importState.resourceLookupCalls, 0)
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.withOrgTransactionCalls, 0)
  assert.equal(importState.historyInsertCalls, 0)
})

test('route rejects a non-boolean posting flag instead of treating it as true', async () => {
  resetImportState()

  const response = await POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'commit',
      resource: 'txn:card_charge',
      rows: [],
      mapping: {},
      post: 'yes',
    }),
  }))

  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error, 'post must be a boolean')
  assert.equal(importState.resourceLookupCalls, 0)
  assert.equal(importState.resourceWriteCalls, 0)
  assert.equal(importState.withOrgTransactionCalls, 0)
  assert.equal(importState.historyInsertCalls, 0)
})

function commitRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'commit',
      resource: 'txn:card_charge',
      format: 'json',
      rows: [{ documentDate: '2026-08-24', account: '5000', amount: '100.0000' }],
      mapping: { documentDate: 'documentDate', account: 'account', amount: 'amount' },
      importMode: 'insert',
      fileName: 'charges.csv',
      ...overrides,
    }),
  })
}

test('commit persists imported rows and their import_jobs evidence in ONE org transaction', async () => {
  resetImportState()

  const response = await POST(commitRequest())

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    outcome: { created: 1, updated: 0, failed: 0, errors: [] },
    jobId: 'job-1',
    total: 1,
  })
  assert.equal(importState.withOrgTransactionCalls, 1)
  assert.equal(importState.historyInsertCalls, 1)
  // The evidence row must have been written while the org transaction held
  // the writes — never on a separate connection after they committed.
  assert.equal(importState.outOfTransactionHistoryInserts, 0)
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rollbacks, 0)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(importState.transactionInsertTargets, ['documents', 'documentLines'])
  assert.equal(importState.committed.documents.length, 1)
  assert.equal(importState.committed.lines.length, 1)
  assert.equal(importState.committed.historyJobs.length, 1)
})

test('commit applies the documented defaults when optional fields are absent', async () => {
  resetImportState()

  const response = await POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'commit',
      resource: 'txn:card_charge',
      rows: [{ documentDate: '2026-08-24', account: '5000', amount: '100.0000' }],
      mapping: { documentDate: 'documentDate', account: 'account', amount: 'amount' },
    }),
  }))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    outcome: { created: 1, updated: 0, failed: 0, errors: [] },
    jobId: 'job-1',
    total: 1,
  })
  const job = importState.committed.historyJobs[0] as { values: unknown[] } | undefined
  assert.ok(job)
  // values: org_id, resource_key, resource_label, format, file_name, mode, …
  assert.equal(job.values[3], 'csv')
  assert.equal(job.values[4], null)
  assert.equal(job.values[5], 'upsert')
})

test('a failed import_jobs insert rolls the whole commit back — no data without evidence', async () => {
  resetImportState()
  importState.failHistoryInsert = true

  await assert.rejects(
    POST(commitRequest()),
    { message: 'forced import_jobs insert failure' },
  )

  assert.equal(importState.withOrgTransactionCalls, 1)
  assert.equal(importState.orgTransactionRollbacks, 1)
  assert.equal(importState.historyInsertCalls, 1)
  assert.equal(importState.outOfTransactionHistoryInserts, 0)
  assert.deepEqual(
    importState.committed.documents,
    [],
    'the imported draft must roll back with its failed evidence row',
  )
  assert.deepEqual(importState.committed.lines, [])
  assert.deepEqual(importState.committed.historyJobs, [])
})

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
  const escapeRegExp = (value: string) => value.replace(/[.*+?${}()|[\]\\]/g, '\\$&')
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
