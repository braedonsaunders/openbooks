import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// The unsaved New-ticket drawer persists a ticket only on Save, under a
// per-session request key that becomes the ticket id. Replays of that key
// (a retried or doubled Save) must resolve to the one ticket and one number
// the first attempt created; a replay naming a different project refuses.
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createFieldTicket, FieldTicketCreateConflictError } = await import('./field-tickets')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

async function ticketCount(orgId: string): Promise<number> {
  const rows = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents where org_id = ${orgId} and kind = 'field_ticket'`)
  return Number(rows.rows[0]?.n ?? 0)
}

test('a replayed create key returns the first ticket and allocates one number', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
        features: { projects: true, fieldTickets: true },
      })}::jsonb where id = ${org.orgId}`)
      const actor = (await seedFlowActors(org.orgId)).adminId
      const projectId = randomUUID()
      const otherProjectId = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-KEY', 'Keyed job', ${org.customerId}, 'active', true, '{}'::jsonb),
               (${otherProjectId}, ${org.orgId}, ${org.subsidiaryId}, 'FT-OTHER', 'Other job', ${org.customerId}, 'active', true, '{}'::jsonb)`)
      const requestId = randomUUID()
      const input = { projectId, period: 'daily' as const, date: org.date, allowedSubsidiaryIds: null, requestId }

      const [first, second] = await Promise.all([
        createFieldTicket(org.orgId, actor, input),
        createFieldTicket(org.orgId, actor, input),
      ])
      assert.equal(first.id, requestId, 'the request key becomes the ticket id')
      assert.equal(second.id, requestId)
      assert.equal(second.documentNumber, first.documentNumber, 'both attempts name the same number')
      assert.deepEqual([first.created, second.created].sort(), [false, true], 'exactly one attempt creates')
      assert.equal(await ticketCount(org.orgId), 1)

      const replay = await createFieldTicket(org.orgId, actor, input)
      assert.deepEqual(replay, { id: requestId, documentNumber: first.documentNumber, created: false })

      await assert.rejects(
        createFieldTicket(org.orgId, actor, { ...input, projectId: otherProjectId }),
        FieldTicketCreateConflictError,
        'a key reused for another project is a conflict, never the older ticket',
      )
      assert.equal(await ticketCount(org.orgId), 1)

      const fresh = await createFieldTicket(org.orgId, actor, { ...input, requestId: randomUUID() })
      assert.equal(fresh.created, true, 'a new drawer session creates a new ticket')
      assert.notEqual(fresh.documentNumber, first.documentNumber)
      assert.equal(await ticketCount(org.orgId), 2)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})
