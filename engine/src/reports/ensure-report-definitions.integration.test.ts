import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '../platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '../testing/fixtures.ts'
import { STANDARD_STATEMENT_DEFINITIONS } from '@openbooks/reports'
import { SEEDED_CATALOG_REPORTS } from './catalog-reports.ts'
import { ensureReportDefinitions } from './ensure-report-definitions.ts'

test('batched catalog refresh preserves custom and edited reports while refreshing owned definitions', async () => {
  const org = await createScratchOrg()
  try {
    const actorId = await createScratchUser(org.orgId, 'Report administrator', 'admin')
    await withOrgTransaction(org.orgId, async () => {
      await ensureReportDefinitions(org.orgId)
      const custom = SEEDED_CATALOG_REPORTS[0]!
      const edited = SEEDED_CATALOG_REPORTS[1]!
      const owned = SEEDED_CATALOG_REPORTS[2]!
      const statement = STANDARD_STATEMENT_DEFINITIONS[0]!
      await db.execute(sql`update report_definitions set kind='custom',name='Tenant custom report' where org_id=${org.orgId} and slug=${custom.slug}`)
      await db.execute(sql`update report_definitions set updated_by=${actorId},name='Tenant edited report' where org_id=${org.orgId} and slug=${edited.slug}`)
      await db.execute(sql`update report_definitions set updated_by=${actorId},name='Tenant edited statement' where org_id=${org.orgId} and slug=${statement.slug}`)
      await db.execute(sql`update report_definitions set name='Previous catalog name' where org_id=${org.orgId} and slug=${owned.slug}`)
      const read = async () => (await db.execute<Record<string, unknown>>(sql`
        select id,slug,name,description,kind,query,statement,report_type,system,updated_by,updated_at
          from report_definitions where org_id=${org.orgId} order by slug
      `)).rows
      const before = await read()
      await ensureReportDefinitions(org.orgId)
      const after = await read()
      assert.equal(after.length, before.length)
      for (const slug of [custom.slug, edited.slug, statement.slug]) {
        assert.deepEqual(after.find(row => row.slug === slug), before.find(row => row.slug === slug), `${slug}: tenant-owned definition must be unchanged`)
      }
      const refreshed = after.find(row => row.slug === owned.slug)!
      assert.equal(refreshed.id, before.find(row => row.slug === owned.slug)!.id)
      assert.equal(refreshed.name, owned.name)
      assert.deepEqual(refreshed.query, owned.query)
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
