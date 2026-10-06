import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { stubModules } from '../testing/stub-modules.ts'

stubModules({ intl: true, navigation: false, authz: false, features: false })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { searchOperationalRecords, resolveRecentOperationalRecords } = await import('./search-records.ts')

type Reader = Parameters<typeof searchOperationalRecords>[0]

function reader(orgId: string, permissions: string[], allowedSubsidiaryIds: Set<string> | null): Reader {
  return {
    user: {
      id: randomUUID(),
      orgId,
      name: 'Search reader',
      email: 'search@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: orgId,
      homeOrgId: orgId,
      homeUserId: randomUUID(),
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds,
  } as unknown as Reader
}

async function seedAssets() {
  const org = await createScratchOrg()
  const other = randomUUID()
  const categoryId = randomUUID()
  const inScope = randomUUID()
  const outOfScope = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"fixedAssets":true,"multiSubsidiary":true}'::jsonb) where id = ${org.orgId}`)
    await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'CAD', 'CA')`)
    await db.execute(sql`insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id, gain_loss_account_id, default_method, default_life_months, default_convention)
      values (${categoryId}, ${org.orgId}, 'Search equipment', ${org.accounts.invAsset}, ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment}, 'straight_line', 10, 'full_month')`)
    await db.execute(sql`insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on, acquisition_cost, salvage_value, depreciation_method, useful_life_months, depreciation_convention)
      values (${inScope}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'FA-SEARCH-1', 'Searchable forklift', 'in_service', ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10, 'full_month'),
             (${outOfScope}, ${org.orgId}, ${other}, ${categoryId}, 'FA-SEARCH-2', 'Searchable crane', 'in_service', ${org.date}, ${org.date}, 1000, 0, 'straight_line', 10, 'full_month')`)
  })
  return { org, inScope, outOfScope }
}

function assetIds(groups: Awaited<ReturnType<typeof searchOperationalRecords>>): string[] {
  return (groups.find((group) => group.type === 'asset')?.hits ?? []).map((hit) => hit.id).sort()
}

test('fixed-asset search answers to the asset list: grant, Features switch and subsidiary fence', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, inScope, outOfScope } = await seedAssets()
  try {
    const search = (who: Reader) => withOrgContext(org.orgId, () => searchOperationalRecords(who, 'searchable'))

    assert.deepEqual(assetIds(await search(reader(org.orgId, ['assets.read'], null))), [inScope, outOfScope].sort())
    assert.deepEqual(
      assetIds(await search(reader(org.orgId, ['assets.read'], new Set([org.subsidiaryId])))),
      [inScope],
      'a restricted reader never sees another entity\'s asset',
    )
    assert.deepEqual(assetIds(await search(reader(org.orgId, [], null))), [], 'no grant, no asset results')

    const hit = (await search(reader(org.orgId, ['assets.read'], null))).find((group) => group.type === 'asset')?.hits[0]
    assert.ok(hit)
    assert.equal(new URL(hit.href, 'https://openbooks.example').pathname, '/assets', 'results open the asset drawer on its list')

    await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fixedAssets}', 'false'::jsonb) where id = ${org.orgId}`))
    assert.deepEqual(assetIds(await search(reader(org.orgId, ['assets.read'], null))), [], 'Fixed assets switched off hides its results')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('recent assets re-resolve under the reader\'s current scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { org, inScope, outOfScope } = await seedAssets()
  try {
    const refs = [{ type: 'asset' as const, id: outOfScope }, { type: 'asset' as const, id: inScope }]
    const restricted = await withOrgContext(org.orgId, () =>
      resolveRecentOperationalRecords(reader(org.orgId, ['assets.read'], new Set([org.subsidiaryId])), refs))
    assert.deepEqual(restricted.map((hit) => hit.id), [inScope])
    assert.equal(restricted[0]?.title, 'Searchable forklift', 'titles are read fresh, never replayed')
    const revoked = await withOrgContext(org.orgId, () => resolveRecentOperationalRecords(reader(org.orgId, [], null), refs))
    assert.deepEqual(revoked, [])
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
