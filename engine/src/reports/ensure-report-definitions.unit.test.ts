import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { STANDARD_STATEMENT_DEFINITIONS, validateCustomQuery } from '@openbooks/reports'
import { SEEDED_CATALOG_REPORTS } from './catalog-reports.ts'

const queries: SQL[] = []
;(globalThis as typeof globalThis & { reportCatalogQueries: SQL[] }).reportCatalogQueries = queries
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../platform/db.ts') return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export const db={execute:async query=>{globalThis.reportCatalogQueries.push(query);return {rows:[]}}};
    export const withOrgTransaction=()=>{throw new Error('Disabled board reporting must not write a package')};
  `) }
  return next(specifier, context)
} })
const { ensureReportDefinitions } = await import('./ensure-report-definitions.ts')

test('catalog refresh batches complete validated families and retains tenant ownership guards', async () => {
  queries.length = 0
  const orgId = '11111111-1111-4111-8111-111111111111'
  await ensureReportDefinitions(orgId)
  const dialect = new PgDialect()
  const writes = queries.map(query => dialect.sqlToQuery(query)).filter(query => /insert into report_definitions/.test(query.sql))
  assert.equal(writes.length, 2, 'refresh must not issue one write per definition')
  const expected = [
    SEEDED_CATALOG_REPORTS.flatMap(def => [orgId, def.slug, def.name, def.description, JSON.stringify(validateCustomQuery(def.query))]),
    STANDARD_STATEMENT_DEFINITIONS.flatMap(def => [orgId, def.slug, def.name, def.description, JSON.stringify({kind:def.statementKind,params:def.params ?? {}})]),
  ]
  writes.forEach((write, index) => {
    assert.deepEqual(write.params, [...expected[index]!, orgId], 'every bound definition and tenant must survive batching')
    assert.match(write.sql, /where report_definitions\.kind = 'built_in' and report_definitions\.updated_by is null/)
    assert.match(write.sql, /and report_definitions\.org_id = \$\d+/)
    assert.match(write.sql, /on conflict \(org_id, slug\) do update/)
  })
})
