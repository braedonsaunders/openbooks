import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  applyBuiltInUrlFilters,
  BUILT_IN_REPORT_DEFINITION_MAP,
  compileCustomQuery,
  REPORT_ENTITY_MAP,
  runCustomQuery,
  validateCustomQuery,
} from '@openbooks/reports'

const ORG_ID = '018f47aa-7c11-7a12-8bc3-1234567890aa'
const ITEM_ID = '018f47aa-7c11-7a12-8bc3-1234567890ab'
const DOC_ID = '018f47aa-7c11-7a12-8bc3-1234567890ac'
const ENTRY_ID = '018f47aa-7c11-7a12-8bc3-1234567890ad'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const definition = BUILT_IN_REPORT_DEFINITION_MAP['lot-recall']!
const entity = REPORT_ENTITY_MAP.inventory_lot_movements!

test('lot recall is a validated, inventory-gated, complete-history built-in', () => {
  assert.ok(definition)
  assert.equal(definition.query.entity, 'inventory_lot_movements')
  assert.doesNotThrow(() => validateCustomQuery(definition.query))
  assert.equal(entity.featureKey, 'inventory')
  assert.equal(entity.defaultPeriodField, null)
  assert.deepEqual(entity.pagination, { defaultPageSize: 100, maxPageSize: 500 })
  assert.deepEqual(definition.query.sorts, [
    { column: 'moved_at', direction: 'desc' },
    { column: 'movement_id', direction: 'desc' },
  ])
  assert.equal(definition.query.filters, null)
  assert.ok(definition.query.columns?.includes('document_number'))
  assert.ok(entity.cellLinks?.some((link) => (
    link.column === 'document_number'
      && link.entryIdColumn === 'transaction_entry_id'
      && link.docIdColumn === 'document_id'
      && link.docKindColumn === 'document_kind'
  )))
})

test('lot URL controls add one authoritative filter set atop an org-tuned plan', () => {
  const tuned = {
    ...definition.query,
    columns: ['lot_number', 'document_number'],
    filters: {
      combinator: 'and' as const,
      rules: [{ field: 'status', op: 'eq' as const, value: 'posted' }],
    },
  }
  const filtered = applyBuiltInUrlFilters(
    { ...definition, query: tuned },
    new URLSearchParams({
      lotNumber: ' recall-42 ',
      itemId: ITEM_ID,
      expiresOnOrBefore: '2027-02-28',
      expiring: '1',
    }),
  )
  assert.deepEqual(filtered.columns, tuned.columns, 'URL filters must not replace an org-tuned plan')
  assert.deepEqual(filtered.filters, {
    combinator: 'and',
    rules: [
      tuned.filters,
      { field: 'lot_number', op: 'contains', value: 'recall-42' },
      { field: 'item_id', op: 'eq', value: ITEM_ID },
      { field: 'expires_on', op: 'lte', value: '2027-02-28' },
      { field: 'expires_on', op: 'is_not_null' },
    ],
  })
})

test('lot URL controls reject malformed active identifiers and impossible dates', () => {
  assert.throws(
    () => applyBuiltInUrlFilters(definition, new URLSearchParams({ itemId: "' or true --" })),
    /Invalid report parameter: itemId/,
  )
  assert.throws(
    () => applyBuiltInUrlFilters(definition, new URLSearchParams({ expiresOnOrBefore: '2027-02-31' })),
    /Invalid report parameter: expiresOnOrBefore/,
  )
})

test('lot recall pages remain org-scoped and stable beyond the legacy 10,000-row cap', () => {
  const filtered = applyBuiltInUrlFilters(definition, new URLSearchParams({
    lotNumber: 'LOT-9',
    itemId: ITEM_ID,
  }))
  const compiled = compileCustomQuery(entity, filtered, ORG_ID, {
    page: { offset: 10_000, limit: 100 },
  })

  assert.match(compiled.text, /COUNT\(\*\) OVER\(\)/)
  assert.match(compiled.text, /ORDER BY im\.moved_at DESC NULLS LAST, im\.id DESC NULLS LAST/)
  assert.match(compiled.text, /LIMIT 100 OFFSET 10000$/)
  assert.match(compiled.text, /WHERE im\.org_id = \$1/)
  assert.equal(compiled.values[0], ORG_ID)
  assert.ok(compiled.values.includes(ITEM_ID))
  assert.ok(compiled.values.includes('%LOT-9%'))
  assert.match(compiled.countText ?? '', /^SELECT COUNT\(\*\).*FROM inventory_movements im .*WHERE im\.org_id = \$1/s)

  // Every label join is pinned to the movement's org; the compiler supplies
  // the first, bound org predicate for the base movement table.
  for (const join of ['lot', 'it', 'sl', 'dl', 'd', 'p']) {
    assert.match(entity.from, new RegExp(`\\b${join}\\.org_id\\s*=\\s*(?:im|d)\\.org_id`), join)
  }
})

test('paged rows carry native transaction drawer metadata without exposing hidden ids', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const result = await runCustomQuery(
    {
      async query(text: string, values?: unknown[]) {
        calls.push({ text, values })
        return {
          rows: [{
            lot_number: 'LOT-9',
            expires_on: '2027-02-28',
            item_code: 'ITEM-9',
            item_name: 'Recall item',
            kind: 'issue',
            moved_at: '2026-08-24T12:00:00.000Z',
            quantity: '-2',
            location_code: 'MAIN',
            document_number: 'INV-1042',
            party_name: 'Customer',
            transaction_entry_id: ENTRY_ID,
            document_id: DOC_ID,
            document_kind: 'sales_invoice',
            __report_total_rows: '10001',
          }],
        }
      },
    },
    definition.query,
    {
      orgId: ORG_ID,
      entityMap: REPORT_ENTITY_MAP,
      page: { offset: 10_000, limit: 100 },
    },
  )

  assert.equal(calls.length, 1)
  assert.equal(result.rowCount, 1)
  assert.deepEqual(result.pageInfo, {
    offset: 10_000,
    limit: 100,
    totalRows: 10_001,
    hasNext: false,
    hasPrevious: true,
  })
  assert.deepEqual(result.groups[0]?.cellLinks?.[0]?.[8], {
    kind: 'transaction',
    entryId: ENTRY_ID,
    docId: DOC_ID,
    docKind: 'sales_invoice',
  })
  assert.deepEqual(result.groups[0]?.columns, [
    'Lot #', 'Expiry', 'Item code', 'Item', 'Movement type',
    'Moved at', 'Quantity', 'Stock location', 'Transaction #', 'Party',
  ])
})

test('legacy, native screen, saved-view and export paths share the built-in filter contract', () => {
  const legacy = read('../app/(app)/reports/lot-recall/page.tsx')
  assert.match(legacy, /builtInReportDefinitionId\(authz\.user\.orgId, 'lot-recall'\)/)
  assert.match(legacy, /redirect\(`\/reports\/custom\/run\/\$\{definitionId\}/)
  assert.doesNotMatch(legacy, /queryLotRecall/)
  for (const param of ['lotNumber', 'itemId', 'expiresOnOrBefore', 'expiring']) {
    assert.match(legacy, new RegExp(`'${param}'`))
  }

  const screen = read('../app/(app)/reports/custom/run/[id]/page.tsx')
  assert.match(screen, /BUILT_IN_REPORT_DEFINITION_MAP/)
  assert.match(screen, /applyBuiltInUrlFilters/)
  assert.match(screen, /reportPeriodField\(definition\.query\)[\s\S]*applyBuiltInUrlFilters/)
  assert.match(screen, /key === 'page' \|\| key === 'perPage' \|\| key === 'format'/)
  assert.match(screen, /<SaveViewButton\b/)

  const exportRun = read('./report-run.ts')
  assert.match(exportRun, /reportPeriodField\(query\)[\s\S]*applyBuiltInUrlFilters/)
  assert.match(exportRun, /executeReportAllPages\(orgId, query\)/)

  const executor = read('./custom-reports.ts')
  assert.match(executor, /entity\.defaultPeriodField === null\) return null/)
  assert.match(executor, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/)
  assert.match(executor, /while \(offset < \(expectedRows \?\? 0\)\)/)
})

test('legacy lot-recall entry fails closed and forwards only its allowlisted controls', () => {
  const legacy = read('../app/(app)/reports/lot-recall/page.tsx')

  // The route renders per-user authorization state, so it must never be
  // statically cached, and every gate below resolves before any redirect.
  assert.match(legacy, /export const dynamic = 'force-dynamic'/)
  assert.match(legacy, /requirePermission\('reports\.read'\)/)
  assert.match(legacy, /!\(await isFeatureEnabled\(authz\.user\.orgId, 'inventory'\)\)\) notFound\(\)/)
  assert.match(
    legacy,
    /if \(!definitionId\) notFound\(\)/,
    'an org without the seeded built-in must 404, never redirect to another tenant\'s id',
  )

  // The forward list is a boundary: exactly the recall controls plus the
  // engine's paging keys ride along, so anything else smuggled into an old
  // saved link never reaches the native runner.
  const allowlist = legacy.match(/const FORWARDED_PARAMS = new Set\(\[(?<body>[^\]]*)\]\)/)
  assert.ok(allowlist?.groups?.body, 'FORWARDED_PARAMS must remain a declared allowlist')
  const forwarded = [...allowlist.groups.body.matchAll(/'([^']+)'/g)].map((entry) => entry[1])
  assert.deepEqual(
    [...forwarded].sort(),
    ['expiresOnOrBefore', 'expiring', 'itemId', 'lotNumber', 'page', 'perPage'],
    'the allowlist owns the recall filters plus page/perPage — nothing more',
  )
  assert.match(legacy, /FORWARDED_PARAMS\.has\(key\)[^\n]*continue/)
  // Repeated params survive as repeated values instead of collapsing.
  assert.match(legacy, /Array\.isArray\(raw\) \? raw : raw \? \[raw\] : \[\]/)
  assert.match(legacy, /forwarded\.append\(key, value\)/)
  // A clean handoff: no stray '?' when nothing qualifies for forwarding.
  assert.match(legacy, /redirect\(`\/reports\/custom\/run\/\$\{definitionId\}\$\{query \? `\?\$\{query\}` : ''\}`\)/)
})

test('native report paging is URL-backed and uses the engine count', () => {
  const screen = read('../app/(app)/reports/custom/run/[id]/page.tsx')
  assert.match(screen, /pickString\(sp\.page\)/)
  assert.match(screen, /pickString\(sp\.perPage\)/)
  assert.match(screen, /executeReportPage\(authz\.user\.orgId, query/)
  assert.match(screen, /total=\{result\.pageInfo\.totalRows\}/)
  assert.match(screen, /Number\.MAX_SAFE_INTEGER \/ pagination\.maxPageSize/)
  assert.doesNotMatch(screen, /pickString\(sp\.page\)[\s\S]{0,120}10_000/)
  assert.match(screen, /<Pagination/)
})
