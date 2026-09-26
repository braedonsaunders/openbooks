import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const testStateKey = Symbol.for('openbooks.subcontracts-view-scope-test')
const state: { authz: unknown } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[testStateKey] = state

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.subcontracts-view-scope-test')]
  export async function requirePermission() { return state.authz }
  export function can(authz, permission) { return authz.permissions.has(permission) }
`
const mockIntl = `export async function getTranslations() { return key => key }`
const mockFeature = `export async function isFeatureEnabled(_orgId, feature) { return feature === 'multiCurrency' }`
const mockGate = `export async function requireSubcontractsFeature() {}`

const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: false,
  intl: mockIntl,
  authz: mockAuthz,
  features: false,
  extra: {
    '../../../lib/features': mockFeature,
    '../../../lib/subcontracts-gate': mockGate,
  },
})

const { loadSubcontracts } = await import('./view.ts') as typeof import('./view.ts')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')

function insertParty(orgId: string, id: string, name: string, subsidiaryId: string | null) {
  return db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active)
    values (${id}, ${orgId}, 'company', ${name}, ${subsidiaryId}, true)
  `)
}

test('subcontract pickers expose only projects and parties in the caller subsidiary scope', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const branchId = randomUUID()
  const visibleProject = `Visible project ${randomUUID()}`
  const hiddenProject = `Hidden project ${randomUUID()}`
  const visibleVendor = `Visible vendor ${randomUUID()}`
  const hiddenVendor = `Hidden vendor ${randomUUID()}`
  const visibleParty = `Visible party ${randomUUID()}`
  const hiddenParty = `Hidden party ${randomUUID()}`
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Subcontract Scope Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `)
      for (const [name, subsidiaryId] of [[visibleProject, org.subsidiaryId], [hiddenProject, branchId]] as const) {
        await db.execute(sql`
          insert into projects (org_id, subsidiary_id, code, name, is_active, status, custom)
          values (${org.orgId}, ${subsidiaryId}, ${randomUUID()}, ${name}, true, 'active', '{}'::jsonb)
        `)
      }
      for (const [name, subsidiaryId] of [[visibleVendor, org.subsidiaryId], [hiddenVendor, branchId]] as const) {
        const partyId = randomUUID()
        await insertParty(org.orgId, partyId, name, subsidiaryId)
        await db.execute(sql`
          insert into vendor_roles (org_id, party_id, currency, is_active)
          values (${org.orgId}, ${partyId}, 'CAD', true)
        `)
      }
      await insertParty(org.orgId, randomUUID(), visibleParty, org.subsidiaryId)
      await insertParty(org.orgId, randomUUID(), hiddenParty, branchId)
    })

    state.authz = {
      user: { id: randomUUID(), orgId: org.orgId },
      permissions: new Set(['ap.read', 'ap.create', 'ap.approve', 'ap.post', 'ap.pay']),
      allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    }
    await withOrgContext(org.orgId, async () => {
      const data = await loadSubcontracts()
      assert.ok(data.projects.some((item) => item.name === visibleProject))
      assert.ok(!data.projects.some((item) => item.name === hiddenProject), 'projects in another subsidiary stay out of the picker')
      assert.ok(data.vendors.some((item) => item.name === visibleVendor))
      assert.ok(!data.vendors.some((item) => item.name === hiddenVendor), 'vendors in another subsidiary stay out of the picker')
      assert.ok(data.parties.some((item) => item.name === visibleParty))
      assert.ok(!data.parties.some((item) => item.name === hiddenParty), 'joint-party options in another subsidiary stay out of the picker')
    })
  } finally {
    state.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
