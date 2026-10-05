import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgTransaction } from '@openbooks/engine/platform/database'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { resolveAuthzByUserId } from '../authz'
import { createTransfer, loadTransfer } from './transfer-store'
import { commandTransfer, uploadTransferPart } from './transfer-commands'
import { claimTransfer, processTransfer } from './transfer-worker'

test('targeted dispatch claims only the named tenant transfer and preserves active fencing', { skip: !process.env.OPENBOOKS_DB_URL, timeout: 60_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  try {
    const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`))
    const authz = await withOrgTransaction(org.orgId, () => resolveAuthzByUserId(org.orgId, actor))
    assert.ok(authz)
    const queue = async (name: string) => withOrgTransaction(org.orgId, async () => {
      const bytes = Buffer.from(`code,name,kind\n${name},${name},service`)
      let job = await createTransfer(authz, { requestKey: randomUUID(), kind: 'import', resource: 'items', format: 'csv', filename: `${name}.csv`, bytes: bytes.length })
      job = await uploadTransferPart(authz, job.id, 0, bytes)
      return commandTransfer(authz, job.id, { action: 'finish-upload', revision: job.revision })
    })
    const first = await queue('First')
    const second = await queue('Second')
    assert.equal(await claimTransfer({ orgId: other.orgId, id: second.id }), null)
    const claimed = await claimTransfer({ orgId: org.orgId, id: second.id })
    assert.ok(claimed)
    assert.equal(claimed.id, second.id)
    assert.equal(claimed.orgId, org.orgId)
    assert.equal(await claimTransfer({ orgId: org.orgId, id: second.id }), null, 'An active claim cannot be replaced')
    const untouched = await withOrgTransaction(org.orgId, () => loadTransfer(org.orgId, first.id))
    assert.equal(untouched.claimToken, null)
    assert.equal(untouched.processedRows, 0)
    await processTransfer(claimed.orgId, claimed.id, claimed.token)
    const complete = await withOrgTransaction(org.orgId, () => loadTransfer(org.orgId, second.id))
    assert.equal(complete.state, 'mapping', complete.error ?? '')
    assert.equal(complete.totalRows, 1)
    assert.equal(complete.claimToken, null)
    assert.equal(await claimTransfer({ orgId: org.orgId, id: second.id }), null, 'A transfer waiting for operator mapping is not runnable')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(other.orgId))
    await withBypassContext(() => dropScratchOrgReporting(org.orgId))
  }
})

test('queueing and targeted claiming share one transaction and rollback preserves the previous checkpoint', { skip: !process.env.OPENBOOKS_DB_URL, timeout: 60_000 }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`))
    const authz = await withOrgTransaction(org.orgId, () => resolveAuthzByUserId(org.orgId, actor))
    assert.ok(authz)
    const bytes = Buffer.from('code,name,kind\nAtomic,Atomic,service')
    const claim = await withOrgTransaction(org.orgId, async () => {
      let job = await createTransfer(authz, { requestKey: randomUUID(), kind: 'import', resource: 'items', format: 'csv', filename: 'atomic.csv', bytes: bytes.length })
      job = await uploadTransferPart(authz, job.id, 0, bytes)
      await commandTransfer(authz, job.id, { action: 'finish-upload', revision: job.revision })
      const claimed = await claimTransfer({ orgId: org.orgId, id: job.id })
      assert.ok(claimed, 'The operator must reserve its newly queued transfer before the command transaction commits')
      return claimed
    })
    assert.equal(await claimTransfer({ orgId: org.orgId, id: claim.id }), null, 'Another worker cannot replace the committed operator claim')
    await processTransfer(claim.orgId, claim.id, claim.token)
    const mapped = await withOrgTransaction(org.orgId, () => loadTransfer(org.orgId, claim.id))
    assert.equal(mapped.state, 'mapping', mapped.error ?? '')
    const aborted = new Error('Operator transaction aborted')
    await assert.rejects(withOrgTransaction(org.orgId, async () => {
      await commandTransfer(authz, claim.id, { action: 'preview', revision: mapped.revision, options: { mapping: { code: 'code', name: 'name', kind: 'kind' } } })
      assert.ok(await claimTransfer({ orgId: org.orgId, id: claim.id }))
      throw aborted
    }), (error: unknown) => error === aborted)
    const unchanged = await withOrgTransaction(org.orgId, () => loadTransfer(org.orgId, claim.id))
    assert.equal(unchanged.state, mapped.state)
    assert.equal(unchanged.revision, mapped.revision)
    assert.equal(unchanged.claimToken, null, 'An aborted operator command must leave no durable lease')
    assert.equal(await claimTransfer({ orgId: org.orgId, id: claim.id }), null, 'The rolled-back preview cannot be dispatched')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(org.orgId))
  }
})
