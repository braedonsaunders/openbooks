import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { BUILT_IN_REPORT_DEFINITION_MAP } from './built-ins'
import {
  compileCustomQuery,
  REPORT_TOTAL_ROWS_COLUMN,
} from './custom-query'
import { REPORT_ENTITY_MAP } from './entities'
import { runCustomQuery, type PgQueryable } from './run'

const entity = REPORT_ENTITY_MAP.inventory_lot_movements!
const definition = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!

test('paged compilation crosses the legacy 10,000-row boundary with a stable page order', () => {
  const compiled = compileCustomQuery(entity, definition.query, '00000000-0000-4000-8000-000000000001', {
    page: { offset: 10_000, limit: 9_999 },
  })
  assert.deepEqual(compiled.page, { offset: 10_000, limit: 500 })
  assert.equal(compiled.limit, 500)
  assert.match(compiled.text, new RegExp(`COUNT\\(\\*\\) OVER\\(\\) AS "${REPORT_TOTAL_ROWS_COLUMN}"`))
  assert.match(compiled.text, /ORDER BY im\.moved_at DESC NULLS LAST, im\.id DESC NULLS LAST/)
  assert.match(compiled.text, /LIMIT 500 OFFSET 10000$/)
  assert.doesNotMatch(compiled.countText ?? '', /ORDER BY|LIMIT|OFFSET/)
  assert.match(compiled.countText ?? '', /WHERE im\.org_id = \$1/)

  const legacy = compileCustomQuery(entity, definition.query, '00000000-0000-4000-8000-000000000001')
  assert.equal(legacy.page, undefined)
  assert.match(legacy.text, /LIMIT 100$/)
  assert.doesNotMatch(legacy.text, new RegExp(REPORT_TOTAL_ROWS_COLUMN))
})

test('page normalization uses entity defaults and clamps preview/page boundaries', () => {
  const defaults = compileCustomQuery(entity, definition.query, 'org', {
    page: { offset: -1, limit: 0 },
  })
  assert.deepEqual(defaults.page, { offset: 0, limit: 100 })
  assert.match(defaults.text, /LIMIT 100 OFFSET 0$/)

  const preview = compileCustomQuery(entity, definition.query, 'org', {
    maxRows: 25,
    page: { offset: 40, limit: 200 },
  })
  assert.deepEqual(preview.page, { offset: 40, limit: 25 })
})

test('paged runs return truthful totals and native transaction cell metadata', async () => {
  const documentId = '20000000-0000-4000-8000-000000000002'
  const entryId = '30000000-0000-4000-8000-000000000003'
  const rawRow: Record<string, unknown> = {
    lot_number: 'LOT-42',
    expires_on: '2027-02-28',
    item_code: 'WIDGET',
    item_name: 'Widget',
    kind: 'issue',
    moved_at: '2026-08-24T12:30:00.000Z',
    quantity: '-2.0000',
    location_code: 'SHIP',
    document_number: 'INV-0042',
    party_name: 'Customer',
    transaction_entry_id: entryId,
    document_id: documentId,
    document_kind: 'customer_invoice',
    [REPORT_TOTAL_ROWS_COLUMN]: '10002',
  }
  const calls: { text: string; values?: unknown[] }[] = []
  const client: PgQueryable = {
    async query(text, values) {
      calls.push({ text, values })
      return { rows: [rawRow] }
    },
  }
  const result = await runCustomQuery(client, definition.query, {
    entityMap: REPORT_ENTITY_MAP,
    orgId: '00000000-0000-4000-8000-000000000001',
    page: { offset: 10_000, limit: 100 },
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(result.pageInfo, {
    offset: 10_000,
    limit: 100,
    totalRows: 10_002,
    hasNext: true,
    hasPrevious: true,
  })
  assert.equal(result.groups[0]?.columns.length, 10)
  assert.equal(result.groups[0]?.rows[0]?.length, 10, 'hidden link/count fields must not become display cells')
  assert.deepEqual(result.groups[0]?.cellLinks?.[0]?.[8], {
    kind: 'transaction',
    entryId,
    docId: documentId,
    docKind: 'customer_invoice',
  })
})

test('an out-of-range page probes the same filtered count instead of losing totalRows', async () => {
  let calls = 0
  const client: PgQueryable = {
    async query(text) {
      calls += 1
      if (calls === 1) return { rows: [] }
      assert.match(text, /^SELECT COUNT\(\*\)/)
      return { rows: [{ [REPORT_TOTAL_ROWS_COLUMN]: '10002' }] }
    },
  }
  const result = await runCustomQuery(client, definition.query, {
    entityMap: REPORT_ENTITY_MAP,
    orgId: '00000000-0000-4000-8000-000000000001',
    page: { offset: 10_100, limit: 100 },
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.pageInfo, {
    offset: 10_100,
    limit: 100,
    totalRows: 10_002,
    hasNext: false,
    hasPrevious: true,
  })
})
