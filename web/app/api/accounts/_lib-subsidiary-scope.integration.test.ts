import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@openbooks/engine/')) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice('@openbooks/engine/'.length)}`, import.meta.url).href,
        context,
      )
    }
    if (context.parentURL?.includes('/schema/src/') && /^\.{1,2}\//.test(specifier) && !/\.[cm]?tsx?$/.test(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { db, env, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadAccount } = await import('./_lib.ts')

test('URL drawer account reads hide out-of-scope subsidiaries and retain shared chart accounts', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const hiddenAccount = randomUUID()
    const sharedAccount = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden Drawer Entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id, is_summary, is_active)
        values (${hiddenAccount}, ${scratch.orgId}, '1096', 'Hidden subsidiary account', 'asset_bank', ${hiddenSubsidiary}, false, true),
               (${sharedAccount}, ${scratch.orgId}, '1097', 'Shared chart account', 'expense', null, false, true)
      `)
    })

    const restricted = new Set([scratch.subsidiaryId])
    assert.equal(await loadAccount(hiddenAccount, scratch.orgId, restricted), null)
    assert.equal(await loadAccount(hiddenAccount, scratch.orgId, new Set()), null)
    assert.equal((await loadAccount(hiddenAccount, scratch.orgId, null))?.account.id, hiddenAccount)
    assert.equal((await loadAccount(sharedAccount, scratch.orgId, restricted))?.account.id, sharedAccount)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})

test('shared account drawer child counts omit subsidiary-owned children outside the caller scope', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const scratch = await withBypass(() => createScratchOrg())
  try {
    const hiddenSubsidiary = randomUUID()
    const sharedParent = randomUUID()
    const visibleChild = randomUUID()
    const hiddenChild = randomUUID()
    await withBypass(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${scratch.orgId}, ${scratch.subsidiaryId}, 'Hidden child entity', 'CAD', 'CA')
      `)
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, subsidiary_id, parent_id, is_summary, is_active)
        values (${sharedParent}, ${scratch.orgId}, '1094', 'Shared summary', 'asset_other', null, null, true, true),
               (${visibleChild}, ${scratch.orgId}, '1095', 'Visible child account', 'asset_other', ${scratch.subsidiaryId}, ${sharedParent}, false, true),
               (${hiddenChild}, ${scratch.orgId}, '1093', 'Hidden child account', 'asset_other', ${hiddenSubsidiary}, ${sharedParent}, false, true)
      `)
    })

    const unrestricted = await loadAccount(sharedParent, scratch.orgId, null)
    const restricted = await loadAccount(sharedParent, scratch.orgId, new Set([scratch.subsidiaryId]))
    assert.equal(unrestricted?.childCount, 2)
    assert.equal(unrestricted?.activeChildCount, 2)
    assert.equal(restricted?.childCount, 1)
    assert.equal(restricted?.activeChildCount, 1)
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId))
  }
})
