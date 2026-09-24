import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state: { gate: { user: { id: string; orgId: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null }
Object.assign(globalThis, { __paymentMandateReadScope: state })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier.endsWith('/lib/authz') && (context.parentURL ?? '').includes('/api/admin/payment-operations/')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export async function guardPermission() { return globalThis.__paymentMandateReadScope.gate }
    `) }
  }
  return next(specifier, context)
} })

const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET } = await import('./route.ts')

test('payment mandate list hides mandates for parties outside the caller scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    const hiddenSubsidiary = randomUUID()
    const hiddenParty = randomUUID()
    await withBypassContext(async () => {
      await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
        values (${hiddenSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted subsidiary', 'CAD', 'CA')`)
      await db.execute(sql`insert into parties(id, org_id, kind, display_name, subsidiary_id, is_active)
        values (${hiddenParty}, ${org.orgId}, 'organization', 'Restricted customer', ${hiddenSubsidiary}, true)`)
      for (const [partyId, suffix] of [[org.customerId, 'visible'], [hiddenParty, 'hidden']] as const) {
        const bankId = randomUUID()
        const mandateId = randomUUID()
        await db.execute(sql`insert into party_bank_accounts
          (id, org_id, party_id, bank_name, country, currency, routing, account_last_four, approved_at, approved_by, created_by, updated_by)
          values (${bankId}, ${org.orgId}, ${partyId}, ${suffix}, 'CA', 'CAD', '{}'::jsonb, ${suffix === 'visible' ? '1111' : '2222'}, ${org.date}, ${actorId}, ${actorId}, ${actorId})`)
        await db.execute(sql`insert into payment_mandates
          (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference, status, signed_on, valid_from, created_by, updated_by)
          values (${mandateId}, ${org.orgId}, ${partyId}, ${bankId}, 'nacha', ${`MANDATE-${suffix}`}, 'active', ${org.date}, ${org.date}, ${actorId}, ${actorId})`)
      }
    })
    state.gate = { user: { id: actorId, orgId: org.orgId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) }
    const response = await withOrgContext(org.orgId, () => GET(new Request('http://openbooks.test/api/admin/payment-operations/mandates'), { params: Promise.resolve({ resource: 'mandates' }) }))
    assert.equal(response.status, 200)
    const result = await response.json() as { rows: Array<{ mandate_reference: string }> }
    assert.deepEqual(result.rows.map((row) => row.mandate_reference), ['MANDATE-visible'])
  } finally {
    state.gate = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
