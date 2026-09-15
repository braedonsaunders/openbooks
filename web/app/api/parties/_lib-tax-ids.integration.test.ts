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
