import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env, withBypassContext, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { resolveAuthzByUserId } from '../authz'
import { createTransfer, loadTransfer, transferMetadataScope } from './transfer-store'
import { commandTransfer, uploadTransferPart } from './transfer-commands'
import { processTransfer, transferBytes } from './transfer-worker'
import { TRANSFER_CHUNK_BYTES, type TransferJob } from './transfer-contract'
import { readExportWindow, finishExportPage, type ExportPage } from './export-page'

test('durable transfers preserve tenant boundaries, approvals and atomic checkpoints', { skip: !env.OPENBOOKS_DB_URL, timeout: 180_000 }, async (t) => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  const tenant = <T>(fn: () => Promise<T>) => withOrgTransaction(org.orgId, fn)
  try {
    await tenant(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`))
    const authz = await tenant(() => resolveAuthzByUserId(org.orgId, actor))
    assert.ok(authz)
    const run = async (job: TransferJob) => {
      const token = randomUUID()
      await tenant(() => db.execute(sql`update data_transfer_jobs set claim_token=${token},claim_until=now()+interval '10 minutes' where org_id=${org.orgId} and id=${job.id}`))
      await processTransfer(org.orgId, job.id, token)
      return tenant(() => loadTransfer(org.orgId, job.id))
    }
    const source = async (prefix: string, count: number, duplicate = false) => {
      const text = ['code,name,kind', ...Array.from({ length: count }, (_, i) => `${prefix}-${duplicate && i === count - 1 ? 0 : i},Item ${i},service`)].join('\n')
      const bytes = Buffer.from(text)
      let job = await tenant(() => createTransfer(authz, { requestKey: randomUUID(), kind: 'import', resource: 'items', format: 'csv', filename: `${prefix}.csv`, bytes: bytes.length }))
      for (let offset = 0; offset < bytes.length; offset += TRANSFER_CHUNK_BYTES) job = await tenant(() => uploadTransferPart(authz, job.id, offset / TRANSFER_CHUNK_BYTES, bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES)))
      job = await tenant(() => commandTransfer(authz, job.id, { action: 'finish-upload', revision: job.revision }))
      job = await run(job)
      assert.equal(job.state, 'mapping', job.error ?? '')
      return job
    }
    const preview = async (job: TransferJob) => run(await tenant(() => commandTransfer(authz, job.id, {
      action: 'preview', revision: job.revision, options: { mapping: { code: 'code', name: 'name', kind: 'kind' }, importMode: 'insert' },
    })))
    const countItems = (prefix: string) => tenant(async () => Number((await db.execute<{ n: string }>(sql`select count(*) n from items where org_id=${org.orgId} and code like ${`${prefix}-%`}`)).rows[0]!.n))

    await t.test('duplicates across batch boundaries refuse approval with every source row identified', async () => {
      const job = await preview(await source('DUPLICATE', 251, true))
      assert.equal(job.state, 'ready', job.error ?? '')
      assert.equal(job.preview.failed, 2)
      assert.deepEqual([...new Set(job.preview.errors.map((error) => error.row))], [1, 251])
      assert.match(job.preview.errors[0]!.message, /keep one record per natural key/)
      const evidence = await tenant(() => db.execute<{ source: string; approval: string }>(sql`select
        evidence->>'sourceHash' as source,evidence->>'approvalHash' as approval from data_transfer_events
        where org_id=${org.orgId} and job_id=${job.id} and action='preview-completed'`))
      assert.ok(evidence.rows[0]!.source)
      assert.equal(evidence.rows[0]!.approval, job.approvalHash, 'Approval evidence contains the hash that was actually published')
      await assert.rejects(tenant(() => commandTransfer(authz, job.id, { action: 'commit', revision: job.revision, approvalHash: job.approvalHash! })), /clean preview.*correct the row errors/)
      assert.equal(await countItems('DUPLICATE'), 0)
    })

    await t.test('a refused second batch rolls back its effects and audit, then retry resumes exactly once', async () => {
      const job = await preview(await source('CHECKPOINT', 501))
      assert.equal(job.preview.failed, 0, JSON.stringify(job.preview.errors))
      await withBypassContext(() => db.execute(sql`alter table items add constraint transfer_test_refusal check (code<>'CHECKPOINT-250') not valid`))
      let committing = await tenant(() => commandTransfer(authz, job.id, { action: 'commit', revision: job.revision, approvalHash: job.approvalHash! }))
      try {
        const failed = await run(committing)
        assert.equal(failed.state, 'failed')
        assert.equal(failed.processedRows, 250)
        assert.equal(failed.outcome.created, 250)
        assert.match(failed.error ?? '', /batch was refused and rolled back.*retry from the stored checkpoint/)
        assert.equal(await countItems('CHECKPOINT'), 250)
        const audit = await tenant(() => db.execute<{ n: string }>(sql`select count(*) n from audit_log a join items i on i.org_id=a.org_id and i.id=a.row_id where a.org_id=${org.orgId} and a.table_name='items' and i.code like 'CHECKPOINT-%'`))
        assert.equal(Number(audit.rows[0]!.n), 250)
        committing = failed
      } finally { await withBypassContext(() => db.execute(sql`alter table items drop constraint transfer_test_refusal`)) }
      const retry = await tenant(() => commandTransfer(authz, committing.id, { action: 'retry', revision: committing.revision }))
      const retryHistory = await tenant(() => db.execute<{ failed_count: number }>(sql`select failed_count from import_jobs where org_id=${org.orgId} and id=${retry.id}`))
      assert.equal(retryHistory.rows[0]!.failed_count, 0, 'History exposes the new checkpoint rather than the refused batch outcome')
      const complete = await run(retry)
      assert.equal(complete.state, 'completed', complete.error ?? '')
      assert.equal(complete.processedRows, 501)
      assert.equal(complete.outcome.created, 501)
      assert.equal(await countItems('CHECKPOINT'), 501)
      const replay = await tenant(() => commandTransfer(authz, complete.id, { action: 'commit', revision: job.revision, approvalHash: job.approvalHash! }))
      assert.equal(replay.id, complete.id)
      assert.equal(replay.state, 'completed')
      const history = await tenant(() => db.execute<{ status: string; created_count: number }>(sql`select status,created_count from import_jobs where org_id=${org.orgId} and id=${complete.id}`))
      assert.deepEqual(history.rows[0], { status: 'committed', created_count: 501 })
    })

    await t.test('revoked import authority reaches the operator and commits no records', async () => {
      const job = await preview(await source('REVOKED', 3))
      const committing = await tenant(() => commandTransfer(authz, job.id, { action: 'commit', revision: job.revision, approvalHash: job.approvalHash! }))
      await tenant(() => db.execute(sql`insert into user_permission_overrides (org_id,user_id,permission,effect) values (${org.orgId},${actor},'data.import','deny')`))
      try {
        const failed = await run(committing)
        assert.equal(failed.state, 'failed')
        assert.match(failed.error ?? '', /data.import permission is required.*restore it/)
        assert.equal(failed.outcome.created, 0)
        assert.equal(await countItems('REVOKED'), 0)
      } finally { await tenant(() => db.execute(sql`delete from user_permission_overrides where org_id=${org.orgId} and user_id=${actor} and permission='data.import'`)) }
    })

    await t.test('a replaced worker cannot overwrite the new claim and a shutdown keeps work resumable', async () => {
      const job = await source('FENCED', 1)
      const requested = await tenant(() => commandTransfer(authz, job.id, { action: 'preview', revision: job.revision, options: { mapping: { code: 'code', name: 'name', kind: 'kind' } } }))
      const replacement = randomUUID()
      await tenant(() => db.execute(sql`update data_transfer_jobs set claim_token=${replacement},claim_until=now()+interval '10 minutes' where org_id=${org.orgId} and id=${job.id}`))
      await processTransfer(org.orgId, job.id, randomUUID())
      let current = await tenant(() => loadTransfer(org.orgId, job.id))
      assert.equal(current.claimToken, replacement)
      assert.equal(current.state, requested.state)
      const abort = new AbortController(); abort.abort()
      await processTransfer(org.orgId, job.id, replacement, abort.signal)
      current = await tenant(() => loadTransfer(org.orgId, job.id))
      assert.equal(current.claimToken, null)
      assert.equal(current.state, 'previewing')
      assert.equal((await run(current)).state, 'ready')
    })

    await t.test('tenant RLS hides job sources and source evidence cannot be rewritten', async () => {
      const job = await source('ISOLATED', 1)
      await assert.rejects(withOrgTransaction(other.orgId, () => loadTransfer(other.orgId, job.id)), /Transfer not found/)
      const hidden = await withOrgTransaction(other.orgId, () => db.execute<{ n: string }>(sql`select count(*) n from data_transfer_chunks where job_id=${job.id}`))
      assert.equal(Number(hidden.rows[0]!.n), 0)
      const forged = await withOrgTransaction(other.orgId, async () => {
        await db.execute(sql`select set_config('app.bypass_rls','on',true)`)
        return db.execute<{ n: string }>(sql`select count(*) n from data_transfer_chunks where job_id=${job.id}`)
      })
      assert.equal(Number(forged.rows[0]!.n), 0, 'A runtime connection cannot authorize its own RLS bypass')
      const immutable = (error: unknown) => error instanceof Error && /evidence are immutable.*create a new transfer/i.test(String((error.cause as Error | undefined)?.message ?? error.message))
      await assert.rejects(tenant(() => db.execute(sql`update data_transfer_chunks set data='changed'::bytea where org_id=${org.orgId} and job_id=${job.id}`)), immutable)
      await assert.rejects(tenant(() => db.execute(sql`update data_transfer_rows set data='{}'::jsonb where org_id=${org.orgId} and job_id=${job.id}`)), immutable)
      await assert.rejects(tenant(() => db.execute(sql`delete from data_transfer_events where org_id=${org.orgId} and job_id=${job.id}`)), immutable)
    })

    await t.test('exports pass the legacy row ceiling with a complete bounded cursor and checksum', async () => {
      await tenant(() => db.execute(sql`insert into items (org_id,code,name,kind,custom)
        select ${org.orgId},'EXPORT-'||n,'Export item '||n,'service','{}'::jsonb from generate_series(1,50001) n`))
      const job = await tenant(() => createTransfer(authz, { requestKey: randomUUID(), kind: 'export', resource: 'items', format: 'csv', filename: 'items.csv', bytes: 0, options: { columns: ['code', 'name'] } }))
      const complete = await run(job)
      assert.equal(complete.state, 'completed', complete.error ?? '')
      assert.ok(complete.totalRows > 50_000)
      const parts = []
      for await (const part of transferBytes(org.orgId, job.id, 'output')) parts.push(part)
      const output = Buffer.concat(parts)
      assert.equal(output.length, complete.bytes)
      assert.match(output.toString(), /EXPORT-50001,Export item 50001/)
      assert.equal(output.toString().split('\r\n').length - 2, complete.totalRows)
    })

    await t.test('export windows bound bytes before hydrating payloads and preserve exact numeric decoding', async () => {
      const page: ExportPage = { size: 10, after: null, next: null, done: false }
      const result = await tenant(() => readExportWindow(db, sql`select n::text as "__transferId",n as "__transferOrder",repeat('x',2000000) as payload,
        999999999999998.99::numeric as amount from generate_series(1,10) n order by n`, { page, allowedSubsidiaryIds: null }))
      assert.equal(result.rows.length, 4)
      assert.equal(result.rows[0]!.amount, '999999999999998.99')
      finishExportPage(result.rows, 'test records', { page, allowedSubsidiaryIds: null })
      assert.equal(page.done, false)
      assert.equal(page.next, '4', 'Numeric identities retain their database order rather than a lexical cast')
      await assert.rejects(tenant(() => readExportWindow(db, sql`select '1' as "__transferId",1 as "__transferOrder",repeat('x',4194305) as payload`,
        { page: { size: 1, after: null, next: null, done: false }, allowedSubsidiaryIds: null })), /exceeds the 4 MiB.*review this resource/)
    })

    await t.test('recent transfer filenames do not outlive the operator’s subsidiary authority', async () => {
      const job = await tenant(() => createTransfer({ ...authz, allowedSubsidiaryIds: new Set([org.subsidiaryId]) }, {
        requestKey: randomUUID(), kind: 'export', resource: 'items', format: 'csv', filename: 'scoped-items.csv', bytes: 0, options: { columns: ['code'] },
      }))
      const visible = (scope: ReadonlySet<string> | null) => tenant(() => db.execute(sql`select id from data_transfer_jobs where org_id=${org.orgId} and id=${job.id} and ${transferMetadataScope(scope, sql`scope`)}`))
      assert.equal((await visible(new Set([org.subsidiaryId]))).rows.length, 1)
      assert.equal((await visible(new Set([other.subsidiaryId]))).rows.length, 0)
      assert.equal((await visible(new Set())).rows.length, 0)
      assert.equal((await visible(null)).rows.length, 1)
    })

    await t.test('long imports yield a claim without publishing an incomplete approval', async () => {
      const started = await source('QUANTUM', 5001)
      const first = await preview(started)
      assert.equal(first.state, 'previewing')
      assert.equal(first.processedRows, 5000)
      assert.equal(first.approvalHash, null)
      assert.equal(first.claimToken, null)
      const resumed = await run(first)
      assert.equal(resumed.state, 'ready', resumed.error ?? '')
      assert.equal(resumed.processedRows, 5001)
      assert.equal(resumed.preview.failed, 0)
      assert.ok(resumed.approvalHash)
      assert.equal(await countItems('QUANTUM'), 0)
    })
  } finally {
    await dropScratchOrgReporting(org.orgId)
    await dropScratchOrgReporting(other.orgId)
  }
})
