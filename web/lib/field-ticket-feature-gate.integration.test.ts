import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFieldTicket, FieldTicketNotFoundError } = await import('./field-tickets')

test('Field Ticket service refuses direct creation when Field Tickets is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-GATE', 'Field Ticket gate project', ${org.customerId}, 'active', true, '{}'::jsonb)
      `)

      await assert.rejects(
        createFieldTicket(org.orgId, actor, { projectId }),
        (error: unknown) => error instanceof FieldTicketNotFoundError && error.status === 404,
      )
      assert.equal(
        (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='field_ticket'`)).rows[0]!.n,
        0,
      )
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
