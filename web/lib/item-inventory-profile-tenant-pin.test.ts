import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/items/[id]/costing/route.ts', import.meta.url), 'utf8')

test('item inventory-profile upserts pin the known tenant on the item_id conflict write', () => {
  assert.match(
    route,
    /insert into item_inventory_profiles[\s\S]*?on conflict \(item_id\) do update set[\s\S]*?where item_inventory_profiles\.org_id = \$\{orgId\}/,
  )
})
