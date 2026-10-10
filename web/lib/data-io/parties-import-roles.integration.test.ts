import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'

// Imported parties must land where the product reads them: the stored kind
// stays canonical, every named role becomes a native role row, and the
// export reads those rows back — so an exported file re-imports losslessly
// and a re-import never mints a duplicate role.
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { MASTER_BY_KEY, masterResource } = await import('./master-data-resources.ts')

test(
  'parties import maps displayed kinds and role flags to native roles',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypass(() => createScratchOrg())
    const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId
    try {
      const resource = masterResource(MASTER_BY_KEY.get('parties')!, org.orgId)
      const ctx = {
        orgId: org.orgId,
        actorId,
        dryRun: false,
        allowedSubsidiaryIds: null,
      }
      const roleCount = async (table: string): Promise<number> =>
        Number(
          (
            await db.execute<{ count: string }>(
              sql`select count(*)::text as count from ${sql.raw(table)} where org_id = ${org.orgId}`,
            )
          ).rows[0]?.count ?? '0',
        )
      await withOrgContext(org.orgId, async () => {
        const first = await resource.write(
          [
            { shortCode: 'ACME', displayName: 'Acme Co', kind: 'Company', isVendor: 'yes' },
            { shortCode: 'BETA', displayName: 'Beta LLC', kind: 'Vendor' },
          ],
          'upsert',
          ctx,
        )
        assert.equal(first.created, 2, JSON.stringify(first.errors))

        const stored = (await db.execute<{ short_code: string; kind: string }>(sql`
          select short_code, kind from parties where org_id = ${org.orgId} order by short_code`)).rows
        assert.deepEqual(
          stored.map((r) => [r.short_code, r.kind]),
          [['ACME', 'company'], ['BETA', 'vendor']],
        )
        assert.equal(await roleCount('vendor_roles'), 2)
        assert.equal(await roleCount('customer_roles'), 0)

        const read = await resource.read()
        const acme = read.rows.find((r) => r.shortCode === 'ACME')
        const beta = read.rows.find((r) => r.shortCode === 'BETA')
        assert.equal(acme?.isVendor, true)
        assert.equal(acme?.isCustomer, false)
        assert.equal(beta?.isVendor, true)

        const second = await resource.write(
          [
            { shortCode: 'ACME', displayName: 'Acme Co', kind: 'Company', isVendor: 'yes' },
            { shortCode: 'BETA', displayName: 'Beta LLC', kind: 'Vendor' },
          ],
          'upsert',
          ctx,
        )
        assert.equal(second.updated, 2, JSON.stringify(second.errors))
        assert.equal(await roleCount('vendor_roles'), 2, 're-import mints no duplicate role row')

        const refused = await resource.write(
          [{ shortCode: 'PAR-1', displayName: 'Partner Co', kind: 'Partner' }],
          'upsert',
          ctx,
        )
        assert.deepEqual(refused, {
          created: 0,
          updated: 0,
          failed: 1,
          errors: [{
            row: 1,
            message: 'kind: invalid value "Partner" — use one of: company, person, customer, vendor, employee',
          }],
        })
      })
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
