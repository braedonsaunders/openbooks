import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/platform/db'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/testing/fixtures'
import { resolveAuthzByUserId } from '../../../../../lib/authz-core'
import { withAuthzContext } from '../../../../../lib/authz-context'
import { GET } from './route'

test('kit availability validates item IDs and lists warehouses admitted by the caller entity', {
  skip: !process.env.OPENBOOKS_DB_URL,
}, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const branchId = randomUUID()
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Kit reader', 'kit-reader'))
    await withBypassContext(async () => {
      await db.execute(sql`update app_roles set permissions='["items.read"]'::jsonb,
        subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
        where org_id=${org.orgId} and key='kit-reader'`)
      await db.execute(sql`update orgs set settings=jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"inventory":true,"warehousing":true}'::jsonb)
        where id=${org.orgId}`)
      await db.execute(sql`insert into subsidiaries(id,org_id,name,parent_id,base_currency,country,is_active,is_elimination,custom)
        values(${branchId},${org.orgId},'Other kit entity',${org.subsidiaryId},'CAD','CA',true,false,'{}'::jsonb)`)
      await db.execute(sql`update items set kind='kit' where org_id=${org.orgId} and id=${org.items.assembly}`)
      await db.execute(sql`update locations set subsidiary_id=${org.subsidiaryId}, subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.locationId}`)
      await db.execute(sql`update locations set subsidiary_id=${branchId}, subsidiary_include_children=false
        where org_id=${org.orgId} and id=${org.locationId2}`)
      await db.execute(sql`insert into warehouses(stock_location_id,org_id,name,status)
        values(${org.stockLocationId},${org.orgId},'Main warehouse','active'),
              (${org.stockLocationId2},${org.orgId},'Branch warehouse','active')`)
    })

    const call = (id: string) => withOrgContext(org.orgId, async () => {
      const authz = await resolveAuthzByUserId(org.orgId, actorId)
      assert.ok(authz)
      return withAuthzContext(authz, () => GET(new Request(`http://kit.test/api/items/${id}/kit-availability`), {
        params: Promise.resolve({ id }),
      }))
    })
    const valid = await call(org.items.assembly)
    assert.equal(valid.status, 200, await valid.clone().text())
    const payload = await valid.json()
    assert.deepEqual(payload.warehouses.map((warehouse: { warehouseId: string }) => warehouse.warehouseId), [org.stockLocationId])

    const malformed = await call('not-a-uuid')
    assert.equal(malformed.status, 404)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
