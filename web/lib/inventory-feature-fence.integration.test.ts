import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { issueInventory, receiveInventory } from '@openbooks/engine/src/inventory/movements.ts'
import { assertInventoryOffHoldsNoStock } from '@openbooks/engine/src/inventory/profile-policy.ts'
import { featureDisableBlocked, featureDisableStatuses } from './features'

/**
 * With Inventory off, sales post revenue without relieving stock or booking
 * COGS. The switch is therefore refused while any stock is held, and the
 * posting side refuses by name for stock that is still on the books.
 */
test('Inventory cannot be turned off while stock is on hand, and turns off once it is cleared', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const item = org.items.fifo
    await receiveInventory(org.orgId, null, {
      itemId: item, stockLocationId: org.stockLocationId, quantity: '10', unitCost: '4',
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    })
    const held = (await featureDisableStatuses(org.orgId, ['inventory'])).inventory!
    assert.equal(held.blocked, true)
    assert.deepEqual(held.impacts.find((impact) => impact.labelKey === 'inventoryItemsOnHand'), { labelKey: 'inventoryItemsOnHand', count: 1 })

    // Stock that predates the refusal: the posting side names the item.
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":false}'::jsonb) where id=${org.orgId}`)
    await assert.rejects(assertInventoryOffHoldsNoStock(db, org.orgId, [item], 'invoice'),
      /Inventory is turned off, but .+ still has stock on hand .+ turn Inventory back on under Company Settings → Features/)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`)

    await issueInventory(org.orgId, null, {
      itemId: item, stockLocationId: org.stockLocationId, quantity: '10', subsidiaryId: org.subsidiaryId, date: org.date,
    })
    assert.equal(await featureDisableBlocked(org.orgId, 'inventory'), false)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
