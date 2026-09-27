import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { SummarizeRowsPlan } from '@openbooks/reports'

const root = pathToFileURL(process.cwd() + '/').href
const { db, pool, withBypassContext, withOrgContext } = await import(root + 'engine/src/platform/db.ts') as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = await import(root + 'engine/src/testing/fixtures.ts') as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { runCustomQuery, shapeSummarizedRows, summarizeRows } = await import(root + 'packages/reports/src/run.ts') as typeof import('@openbooks/reports')
const { REPORT_ENTITY_MAP } = await import(root + 'packages/reports/src/entities.ts') as typeof import('@openbooks/reports')
const { reportResultToCsv } = await import(root + 'packages/office/src/index.ts') as typeof import('@openbooks/office')

type FixtureDocument = { kind: 'customer_invoice' | 'customer_payment'; posting_date: string; currency: 'CAD'; total: string }

test('filtered formula totals, undefined labels and CSV match the in-memory producer', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const documents: FixtureDocument[] = [
    { kind: 'customer_invoice', posting_date: '2026-01-12', currency: 'CAD', total: '100.0000' },
    { kind: 'customer_payment', posting_date: '2026-01-20', currency: 'CAD', total: '20.0000' },
    { kind: 'customer_payment', posting_date: '2026-02-10', currency: 'CAD', total: '10.0000' },
  ]
  const measures = [
    {
      fn: 'sum', key: 'collected', label: 'Collected', column: 'total', hidden: true,
      filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'customer_payment' }] },
    },
    {
      fn: 'sum', key: 'billed', label: 'Billed', column: 'total', hidden: true,
      filter: { combinator: 'and', rules: [{ field: 'kind', op: 'eq', value: 'customer_invoice' }] },
    },
    {
      fn: 'formula', key: 'collection_rate', label: 'Collection rate', format: 'percent',
      expr: { op: '/', left: { ref: 'collected' }, right: { ref: 'billed' } },
    },
  ] as const
  const query = {
    entity: 'documents', mode: 'summarize', columns: [],
    breakouts: [{ column: 'posting_date', bin: 'month' }],
    groupBy: 'posting_date', totals: { grand: true },
    sorts: [{ column: 'collection_rate', direction: 'asc' }],
    filters: { combinator: 'and', rules: [{ field: 'currency', op: 'eq', value: 'CAD' }] },
    measures,
  }
  try {
    await withBypassContext(async () => {
      for (const [index, document] of documents.entries()) {
        const id = randomUUID()
        await db.execute(sql`
          insert into documents
            (id, org_id, subsidiary_id, kind, status, document_number, document_date, posting_date,
             currency, subtotal, tax_total, total)
          values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${document.kind}, 'draft',
                  ${`FORMULA-${index}-${id.slice(0, 8)}`}, ${document.posting_date}, ${document.posting_date},
                  ${document.currency}, ${document.total}, '0.0000', ${document.total})`)
      }
    })
    const sqlResult = await withOrgContext(org.orgId, () => runCustomQuery(pool, query, {
      orgId: org.orgId,
      entityMap: REPORT_ENTITY_MAP,
      allowedSubsidiaryIds: [org.subsidiaryId],
    }))
    const jan = sqlResult.groups.find((group) => group.title.endsWith('2026-01'))
    const feb = sqlResult.groups.find((group) => group.title.endsWith('2026-02'))
    const grand = sqlResult.groups.find((group) => group.title === 'Grand totals')
    assert.deepEqual(jan?.rows[0], ['20.00%'])
    assert.deepEqual(feb?.rows[0], ['Undefined — divides by zero'])
    assert.deepEqual(grand?.rows[0], ['30.00%'])
    assert.equal(feb?.undefinedCells?.[0]?.[0], 'Undefined — divides by zero')

    const inMemoryPlan: SummarizeRowsPlan = {
      entity: REPORT_ENTITY_MAP.documents!,
      breakouts: [{ column: 'posting_date', bin: 'month' as const }],
      groupBy: 'posting_date',
      totals: { grand: true },
      measures: [
        { fn: 'sum', key: 'collected', label: 'Collected', column: 'total', hidden: true, filter: (row: Readonly<Record<string, unknown>>) => row.kind === 'customer_payment' },
        { fn: 'sum', key: 'billed', label: 'Billed', column: 'total', hidden: true, filter: (row: Readonly<Record<string, unknown>>) => row.kind === 'customer_invoice' },
        { fn: 'formula', key: 'collection_rate', label: 'Collection rate', format: 'percent', expr: { op: '/', left: { ref: 'collected' }, right: { ref: 'billed' } } },
      ],
    }
    const shapedInMemory = shapeSummarizedRows(summarizeRows(documents, inMemoryPlan), inMemoryPlan)
    assert.deepEqual(shapedInMemory, sqlResult)
    assert.equal(reportResultToCsv(sqlResult), reportResultToCsv(shapedInMemory))
    assert.match(reportResultToCsv(sqlResult), /Undefined — divides by zero/)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
