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
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { loadParty } = await import('./_lib.ts')
const { db, env, withBypass, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  '@openbooks/engine/src/test-fixtures.ts',
)

/**
 * Regression coverage (party PII boundary): the directory flyout payload
 * shipped the party row's full `tax_ids` identifier bag to every
 * parties.read holder, although no drawer surface reads it and the governed
 * query layer deliberately withholds full tax identifiers from reportable
 * projections. The payload now omits the sealed identifiers while keeping
 * every field the drawer renders.
 */
test(
  'party directory payload omits sealed tax identifiers',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, partyId } = await withBypass(async () => {
      const created = await createScratchOrg()
      await seedFlowActors(created.orgId)
      const party = randomUUID()
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, tax_ids)
        values (${party}, ${created.orgId}, 'company', 'Sealed Tax Co',
                '{"CA": {"bn": "123456789RT0001"}}'::jsonb)
      `)
      return { org: created, partyId: party }
    })

    try {
      const payload = await withOrgContext(org.orgId, () =>
        loadParty(partyId, org.orgId, new Set([org.subsidiaryId])),
      )
      assert.ok(payload)
      assert.equal((payload.party as { display_name: string }).display_name, 'Sealed Tax Co')
      assert.ok(!('tax_ids' in (payload.party as Record<string, unknown>)))
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)

/**
 * Cross-role regression: the CRM account drawers run on crm.accounts.read
 * (no parties.read required) yet received the full directory bundle — vendor
 * compliance evidence, employee HR facts, sealed bank routing, and AR
 * totals — although they render party identity plus CRM facts only. The CRM
 * bundle keeps relationship facts (identity, addresses, contacts) and drops
 * everything a sales drawer has no consumer for.
 */
test(
  'crm party bundle omits role rows, bank details, and transaction totals',
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const { org, partyId } = await withBypass(async () => {
      const created = await createScratchOrg()
      await seedFlowActors(created.orgId)
      const party = randomUUID()
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, email)
        values (${party}, ${created.orgId}, 'company', 'Crm Bundle Co', 'crm@example.test')
      `)
      await db.execute(sql`
        insert into addresses (org_id, party_id, label, line1, city)
        values (${created.orgId}, ${party}, 'HQ', '1 Main St', 'Toronto')
      `)
      await db.execute(sql`
        insert into vendor_roles (org_id, party_id, tin_last4, tin_type)
        values (${created.orgId}, ${party}, '0000', 'ssn')
      `)
      await db.execute(sql`
        insert into employee_roles (org_id, party_id, employee_number, hired_on)
        values (${created.orgId}, ${party}, 'E-1', '2020-01-15')
      `)
      await db.execute(sql`
        insert into party_bank_accounts (org_id, party_id, bank_name, account_last_four)
        values (${created.orgId}, ${party}, 'Vault Bank', '1234')
      `)
      return { org: created, partyId: party }
    })

    try {
      const crm = await withOrgContext(org.orgId, () =>
        loadParty(partyId, org.orgId, new Set([org.subsidiaryId]), { bundle: 'crm' }),
      )
      assert.ok(crm)
      assert.equal((crm.party as { display_name: string }).display_name, 'Crm Bundle Co')
      assert.equal(crm.addresses.length, 1)
      assert.equal(crm.customer, null)
      assert.equal(crm.vendor, null)
      assert.equal(crm.employee, null)
      assert.deepEqual(crm.bankAccounts, [])
      assert.deepEqual(crm.transactionSummary, { count: 0, openCount: 0, lastDate: null, currencies: [] })
      assert.deepEqual(crm.additionalSubsidiaryIds, [])

      // The directory bundle is unchanged: editors keep every fact.
      const full = await withOrgContext(org.orgId, () =>
        loadParty(partyId, org.orgId, new Set([org.subsidiaryId])),
      )
      assert.ok(full)
      assert.ok(full.vendor)
      assert.ok(full.employee)
      assert.equal(full.bankAccounts.length, 1)
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId))
    }
  },
)
