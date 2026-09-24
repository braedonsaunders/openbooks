import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
registerHooks({resolve(specifier,context,next){
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFieldTicket, loadFieldTicket, updateTicketHeader, FieldTicketError } = await import('./field-tickets')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * The header form forwards any shape-valid documentDate to the ticket update.
 * An impossible calendar day (2026-02-30) must fail closed as a domain error
 * before any write — not reach the DATE column and surface as a 500 from
 * PostgreSQL.
 */
test('the ticket header refuses an impossible document date', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,fieldTickets}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'HDR-DATE', 'Header date job',
                ${org.customerId}, 'active', true, '{}'::jsonb)`)

      const created = await createFieldTicket(org.orgId, actor, { projectId, allowedSubsidiaryIds: null})
      const loaded = await loadFieldTicket(org.orgId, created.id)

      await assert.rejects(
        updateTicketHeader(org.orgId, actor, created.id, { documentDate: '2026-02-30' }, loaded.revision, null),
        (e) => e instanceof FieldTicketError && /Invalid ticket date/.test(e.message),
      )
      const after = await loadFieldTicket(org.orgId, created.id)
      assert.equal(after.documentDate, loaded.documentDate)
      assert.equal(after.revision, loaded.revision)

      // A real calendar day still saves.
      await updateTicketHeader(org.orgId, actor, created.id, { documentDate: '2026-02-27' }, after.revision, null)
      assert.equal((await loadFieldTicket(org.orgId, created.id)).documentDate, '2026-02-27')
    } finally { await dropScratchOrg(org.orgId) }
  })
})
