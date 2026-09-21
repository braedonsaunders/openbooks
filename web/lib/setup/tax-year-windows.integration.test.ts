import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'server-only'
      ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
      : next(specifier, context)
  },
})
const { db, env, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { listTaxYearWindows } = await import('@openbooks/engine/src/tax-returns/macrs-calendar.ts')
const { createSetupRecord, updateSetupRecord, deleteSetupRecord } = await import('./write.ts')

test('the shared setup writer preserves two short years with one filing label, ownership and audit evidence', { skip: !env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    const actor = { orgId: org.orgId, id: actorId, permissions: ['*'] }
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        update orgs set settings = settings || jsonb_build_object('features',
          coalesce(settings->'features', '{}'::jsonb) || '{"fixedAssets":true,"multiSubsidiary":false}'::jsonb)
         where id=${org.orgId}`)
      const firstInput = {
        subsidiaryId: org.subsidiaryId, regime: 'ca_cca', yearStart: '2024-01-01', yearEnd: '2024-06-30',
        filingYear: '2024', reason: 'Approved change of company tax year end',
      }
      const first = await createSetupRecord(actor, 'tax-year-windows', firstInput)
      assert.equal(first.status, 200, JSON.stringify(first.body))
      const second = await createSetupRecord(actor, 'tax-year-windows', {
        ...firstInput, yearStart: '2024-07-01', yearEnd: '2024-12-31', reason: 'Approved final short tax year',
      })
      assert.equal(second.status, 200, JSON.stringify(second.body))
      assert.notEqual(first.body.id, second.body.id)
      const windows = await listTaxYearWindows(db, org.orgId, { subsidiaryId: org.subsidiaryId, regime: 'ca_cca' })
      assert.deepEqual(windows.map((window) => [window.id, window.yearStart, window.yearEnd, window.filingYear]), [
        [first.body.id, '2024-01-01', '2024-06-30', 2024],
        [second.body.id, '2024-07-01', '2024-12-31', 2024],
      ])
      const overlap = await createSetupRecord(actor, 'tax-year-windows', {
        ...firstInput, yearStart: '2024-06-30', yearEnd: '2024-07-31',
      })
      assert.equal(overlap.status, 400)
      assert.match(String(overlap.body.error), /overlap.*2024-01-01.*2024-06-30/i)
      const moved = await updateSetupRecord(actor, 'tax-year-windows', {
        ...firstInput, id: first.body.id, yearStart: '2023-12-31',
      })
      assert.equal(moved.status, 400)
      assert.match(String(moved.body.error), /identity/i)
      const missingEntity = await createSetupRecord(actor, 'tax-year-windows', { ...firstInput, subsidiaryId: '' })
      assert.equal(missingEntity.status, 400)
      assert.match(String(missingEntity.body.error), /subsidiaryId.*required|legal entity/i)
      const wrongOrg = await createSetupRecord(actor, 'tax-year-windows', { ...firstInput, subsidiaryId: org.bookId })
      assert.equal(wrongOrg.status, 400)
      assert.match(String(wrongOrg.body.error), /active legal entity|this organization/i)
      assert.equal((await listTaxYearWindows(db, org.orgId, { subsidiaryId: org.subsidiaryId, regime: 'ca_cca' })).length, 2)

      const audit = (await db.execute<{ actor_id: string; changes: { after: Record<string, unknown> } }>(sql`
        select actor_id, changes from audit_log where org_id=${org.orgId}
          and table_name='tax_year_windows' and row_id=${first.body.id} and action='insert'`)).rows
      assert.equal(audit.length, 1)
      assert.equal(audit[0]!.actor_id, actorId)
      assert.equal(audit[0]!.changes.after.reason, firstInput.reason)
      assert.equal(audit[0]!.changes.after.subsidiary_id, org.subsidiaryId)

      const removed = await deleteSetupRecord(actor, 'tax-year-windows', String(second.body.id))
      assert.equal(removed.status, 200, JSON.stringify(removed.body))
      const afterDelete = await listTaxYearWindows(db, org.orgId, { subsidiaryId: org.subsidiaryId, regime: 'ca_cca' })
      assert.deepEqual(afterDelete.map((window) => window.id), [first.body.id])
      const deletedAgain = await deleteSetupRecord(actor, 'tax-year-windows', String(second.body.id))
      assert.equal(deletedAgain.status, 404, 'a zero-row delete must not claim success')

      // A real computed-period reference exercises the service refusal before
      // PostgreSQL's FK would reduce it to a generic "in use" error.
      const pool = (await db.execute<{ id: string }>(sql`
        insert into tax_depreciation_pools (org_id, book_id, subsidiary_id, regime, class_code, rate)
        values (${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'ca_cca', '8', '20') returning id`)).rows[0]!
      await db.execute(sql`
        insert into tax_pool_periods (org_id, pool_id, tax_year, tax_year_window_id, year_start, year_end, opening_balance)
        values (${org.orgId}, ${pool.id}, 2024, ${first.body.id}, '2024-01-01', '2024-06-30', '0')`)
      const citedDelete = await deleteSetupRecord(actor, 'tax-year-windows', String(first.body.id))
      assert.equal(citedDelete.status, 409)
      assert.match(String(citedDelete.body.error), /2024-01-01.*2024-06-30.*computed pool result.*cannot be deleted/i)
      assert.doesNotMatch(String(citedDelete.body.error), /23503|foreign key|Failed query/)
      const citedEdit = await updateSetupRecord(actor, 'tax-year-windows', {
        ...firstInput, id: first.body.id, yearEnd: '2024-07-01',
      })
      assert.equal(citedEdit.status, 400)
      assert.match(String(citedEdit.body.error), /dates are frozen/i)
    })
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
