import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { db, env, withBypass } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { SETUP_ENTITY_BY_KEY } = await import('./registry.ts')
const { loadRefOptions } = await import('./ref-options.ts')

// F-t08-015: the FIT Remittance vendor listbox on the payroll setup
// components tab rendered only None. Its loader — loadRefOptions for the
// pay-components entity — had no `vendors` branch (the generic registry
// lookup finds no `vendors` entity and returns []), and carried no
// subsidiary scope. A subsidiary-scoped org must still see its org-wide
// (NULL-subsidiary) vendors alongside its own, exactly as the payroll
// settings picker and the accounts-tab vendor query already do.
async function seedVendor(orgId: string, name: string, subsidiaryId: string | null, active = true) {
  const partyId = randomUUID()
  await withBypass(() => db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active)
    values (${partyId}, ${orgId}, 'vendor', ${name}, ${subsidiaryId}, ${active})`))
  await withBypass(() => db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active)
    values (${orgId}, ${partyId}, ${active})`))
  return partyId
}

test('pay-components ref loader lists org-wide vendors for a subsidiary-scoped caller', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypass(() => createScratchOrg())
  try {
    const subA = randomUUID()
    // The scratch bootstrap already owns the org root: reuse it as the
    // out-of-scope sub and hang the scoped sub beneath it.
    const roots = await withBypass(() => db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${org.orgId} and parent_id is null limit 1`))
    const rootId = roots.rows[0]?.id
    assert.ok(rootId, 'scratch org must bootstrap a root subsidiary')
    const subB = rootId
    await withBypass(() => db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_active)
      values (${subA}, ${org.orgId}, ${subB}, 'Scoped Sub A', 'USD', 'US', true)`))
    await seedVendor(org.orgId, 'Org-wide Remittance Vendor', null)
    await seedVendor(org.orgId, 'Sub A Vendor', subA)
    await seedVendor(org.orgId, 'Sub B Vendor', subB)
    await seedVendor(org.orgId, 'Retired Vendor', null, false)

    const entity = SETUP_ENTITY_BY_KEY.get('pay-components')
    assert.ok(entity, 'pay-components must stay registered')

    // The exact regression: the listbox previously rendered only None.
    const scoped = await withBypass(() => loadRefOptions(entity, org.orgId, new Set([subA])))
    const scopedNames = (scoped.vendors ?? []).map((v) => v.label)
    assert.ok(scopedNames.includes('Org-wide Remittance Vendor'), `org-wide vendor must be visible to a scoped caller, saw: ${scopedNames}`)
    assert.ok(scopedNames.includes('Sub A Vendor'), `own-subsidiary vendor must be visible, saw: ${scopedNames}`)
    assert.ok(!scopedNames.includes('Sub B Vendor'), `out-of-scope vendor must stay hidden, saw: ${scopedNames}`)
    assert.ok(!scopedNames.includes('Retired Vendor'), `inactive vendor must stay hidden, saw: ${scopedNames}`)

    const open = await withBypass(() => loadRefOptions(entity, org.orgId, null))
    const openNames = (open.vendors ?? []).map((v) => v.label)
    for (const name of ['Org-wide Remittance Vendor', 'Sub A Vendor', 'Sub B Vendor']) {
      assert.ok(openNames.includes(name), `unrestricted caller must see ${name}, saw: ${openNames}`)
    }
    assert.ok(!openNames.includes('Retired Vendor'), `inactive vendor must stay hidden, saw: ${openNames}`)
  } finally { await withBypass(() => dropScratchOrg(org.orgId)) }
})
