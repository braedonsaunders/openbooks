import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { readAuditEvent, readAuditPage } from './audit-reader'

test('audit windows and exact facets preserve tenant, filter and snapshot semantics', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const first = await withBypassContext(() => createScratchOrg())
  const second = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(first.orgId, 'Audit filter operator', 'audit_reader'))
    const ids = Array.from({ length: 7 }, () => randomUUID())
    const foreignEvent = randomUUID()
    const evidence = { before: { document: { kind: 'customer_invoice', total: '9007199254740993.1234' } }, after: null }
    // PostgreSQL retains this numeric token exactly; decoding it through a
    // JavaScript number would corrupt the immutable financial evidence.
    const evidenceJson = '{"before":{"document":{"kind":"customer_invoice","total":9007199254740993.1234}},"after":null}'
    await withBypassContext(async () => {
      for (const [i, id] of ids.entries()) await db.execute(sql`
        insert into audit_log (id, org_id, table_name, row_id, action, actor_id, at, changes)
        values (${id}, ${first.orgId}, ${i === 6 ? 'documents' : 'audit_window_example'}, ${randomUUID()},
          ${i === 6 ? 'delete' : i % 2 ? 'update' : 'insert'}, ${i % 2 ? actor : null},
          '2026-09-01T12:00:00Z', ${i === 6 ? evidenceJson : JSON.stringify({ amount: ['1.0000', '2.0000'] })}::jsonb)
      `)
      await db.execute(sql`insert into audit_log (id, org_id, table_name, row_id, action)
        values (${foreignEvent}, ${second.orgId}, 'audit_window_example', ${randomUUID()}, 'update')`)
    })
    await withOrgContext(first.orgId, async () => {
      const opts = { page: 1, perPage: 5, rtype: 'audit_window_example' }
      const firstPage = await readAuditPage(first.orgId, opts)
      const nextPage = await readAuditPage(first.orgId, { ...opts, page: 2 })
      assert.equal(firstPage.total, 6)
      assert.equal(firstPage.rows.length, 5)
      assert.equal(nextPage.rows.length, 1)
      assert.deepEqual([...firstPage.rows, ...nextPage.rows].map((r) => r.id), ids.slice(0, 6).sort().reverse())
      assert.ok(firstPage.rows.every((r) => r.changeCount === 1 && r.summaryKind === 'fields'))
      assert.equal((await readAuditPage(first.orgId, { ...opts, actor: 'system' })).total, 3)
      assert.equal((await readAuditPage(first.orgId, { ...opts, actor, action: 'update' })).total, 3)
      assert.equal((await readAuditPage(first.orgId, { ...opts, q: 'filter operator' })).total, 3)
      assert.equal((await readAuditPage(first.orgId, { ...opts, to: '2026-08-31' })).total, 0)
      assert.equal((await readAuditPage(first.orgId, { ...opts, from: '2026-09-01', to: '2026-09-01' })).total, 6)
      assert.ok(firstPage.recordTypes.some((r) => r.rtype === 'customer_invoice' && Number(r.n) === 1))
      const deleted = await readAuditPage(first.orgId, { ...opts, rtype: 'customer_invoice' })
      assert.equal(deleted.total, 1)
      assert.equal(deleted.rows[0]?.summaryKind, 'snapshot')
      assert.deepEqual((await readAuditEvent(first.orgId, ids[6]!))?.changes, evidence)
      assert.equal(await readAuditEvent(first.orgId, foreignEvent), null)
      // The caller's explicit org argument cannot override connection-level RLS.
      assert.equal(await readAuditEvent(second.orgId, foreignEvent), null)
      const empty = await readAuditPage(first.orgId, { ...opts, rtype: 'absent_audit_type' })
      assert.equal(empty.total, 0)
      assert.deepEqual(empty.rows, [])
      const actions = (rows: typeof empty.actions) => rows.map((r) => [r.action, r.n])
      const actors = (rows: typeof empty.actors) => rows.map((r) => [r.actor_id, r.actor_name, r.n])
      assert.deepEqual(actions(empty.actions), actions(firstPage.actions))
      assert.deepEqual(actors(empty.actors), actors(firstPage.actors))
    })
  } finally {
    await dropScratchOrg(first.orgId)
    await dropScratchOrg(second.orgId)
  }
})
