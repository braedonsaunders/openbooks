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
