import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, env, withBypassContext, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { resolveAuthzByUserId } from '../authz'
import { createTransfer, loadTransfer } from '../data-io/transfer-store'
import { commandTransfer, uploadTransferPart } from '../data-io/transfer-commands'
import { processTransfer } from '../data-io/transfer-worker'
import type { TransferJob } from '../data-io/transfer-contract'
import { MigrationPlanRefusal, readMigrationPlan, recordGoLive, updateMigrationPlan } from './plan'
import { draftOpeningBalances, OpeningBalanceRefusal, previewOpeningBalances } from './opening-balances'
import { loadJourneyFacts, measureCutoverChecks } from './journey'

test('migration plan, staged files and the opening journal run through the native commands', { skip: !env.OPENBOOKS_DB_URL, timeout: 180_000 }, async (t) => {
  const org = await withBypassContext(() => createScratchOrg())
  const other = await withBypassContext(() => createScratchOrg())
  const actor = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  try {
    await withOrgTransaction(org.orgId, () => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`))
    const authz = await withOrgTransaction(org.orgId, () => resolveAuthzByUserId(org.orgId, actor))
    assert.ok(authz)
    const me = { orgId: org.orgId, id: actor }
    const inOrg = <T>(fn: () => Promise<T>) => withOrgTransaction(org.orgId, fn)

    const stage = async (filename: string, text: string, resource = 'items'): Promise<TransferJob> => {
      const bytes = Buffer.from(text)
      let job = await inOrg(() => createTransfer(authz, { requestKey: randomUUID(), kind: 'import', resource, format: 'csv', filename, bytes: bytes.length }))
      job = await inOrg(() => uploadTransferPart(authz, job.id, 0, bytes))
      job = await inOrg(() => commandTransfer(authz, job.id, { action: 'finish-upload', revision: job.revision }))
      const token = randomUUID()
      await withOrgTransaction(org.orgId, () => db.execute(sql`update data_transfer_jobs set claim_token=${token},claim_until=now()+interval '10 minutes' where org_id=${org.orgId} and id=${job.id}`))
      await processTransfer(org.orgId, job.id, token)
      job = await inOrg(() => loadTransfer(org.orgId, job.id))
      assert.equal(job.state, 'mapping', job.error ?? '')
      return job
    }

    await t.test('plan changes are audited and every reference is checked against this organization', async () => {
      const { after } = await inOrg(() => updateMigrationPlan(me, { path: 'spreadsheet', sourceSystem: 'spreadsheet', sourceLabel: 'Legacy desktop ledger', cutoverDate: '2026-10-01' }, 'test plan'))
      assert.equal(after.path, 'spreadsheet')
      assert.equal(after.updatedBy, actor)
      const audit = await inOrg(() => db.execute<{ reason: string; path: string }>(sql`
        select changes->>'reason' as reason, changes->'migrationPlan'->'after'->>'path' as path
          from audit_log where org_id=${org.orgId} and table_name='orgs' and changes ? 'migrationPlan' order by at desc, id desc limit 1`))
      assert.deepEqual(audit.rows[0], { reason: 'test plan', path: 'spreadsheet' })

      const foreignConnection = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
        insert into connections (org_id, source, display_name, auth_kind, status) values (${other.orgId}, 'example', 'Other org', 'token', 'unconfigured') returning id`)).rows[0]!.id)
      await assert.rejects(inOrg(() => updateMigrationPlan(me, { connectionId: foreignConnection }, 'test')), (error: unknown) => error instanceof MigrationPlanRefusal && error.status === 404)
      await assert.rejects(inOrg(() => updateMigrationPlan(me, { openingBalanceAccountId: randomUUID() }, 'test')), (error: unknown) => error instanceof MigrationPlanRefusal && error.status === 404)
      assert.equal((await inOrg(() => readMigrationPlan(org.orgId))).connectionId, null, 'a refused change leaves the plan untouched')
    })

    await t.test('a staged file is re-targeted to another resource before validation, and its history follows', async () => {
      const job = await stage('chart.csv', 'number,name,type\n7001,Migration Test Cash,asset_bank\n')
      assert.equal(job.resource, 'items')
      const moved = await inOrg(() => commandTransfer(authz, job.id, { action: 'select-resource', revision: job.revision, resource: 'accounts' }))
      assert.equal(moved.resource, 'accounts')
      assert.equal(moved.state, 'mapping')
      assert.ok(moved.fields.some((field) => field.key === 'number'), 'the staged job carries the new resource fields')
      const history = await inOrg(() => db.execute<{ resource_key: string; resource_label: string }>(sql`select resource_key, resource_label from import_jobs where org_id=${org.orgId} and id=${job.id}`))
      assert.equal(history.rows[0]!.resource_key, 'accounts')
      const event = await inOrg(() => db.execute<{ before: string; after: string }>(sql`
        select evidence->>'beforeResource' as before, evidence->>'resource' as after from data_transfer_events
         where org_id=${org.orgId} and job_id=${job.id} and action='resource-selected'`))
      assert.deepEqual(event.rows[0], { before: 'items', after: 'accounts' })
      await assert.rejects(inOrg(() => commandTransfer(authz, job.id, { action: 'select-resource', revision: job.revision, resource: 'parties' })), /changed concurrently/)
    })

    const numbers = await inOrg(async () => Object.fromEntries((await db.execute<{ id: string; number: string }>(sql`
      select id, number from accounts where org_id=${org.orgId} and id in (${org.accounts.bank}, ${org.accounts.revenue}, ${org.accounts.clearing})`)).rows.map((row) => [row.id, row.number])))
    const bank = numbers[org.accounts.bank]!, revenue = numbers[org.accounts.revenue]!, clearing = numbers[org.accounts.clearing]!
    assert.ok(bank && revenue && clearing, 'fixture accounts carry numbers')

    await t.test('an out-of-balance trial balance is refused with the difference, never plugged', async () => {
      const job = await stage('tb-off.csv', `Account,Debit,Credit\n${bank},1000.00,\n${revenue},,999.99\n`)
      const request = { transferId: job.id, columns: { account: 'Account', debit: 'Debit', credit: 'Credit' }, documentDate: '2026-09-30' }
      await assert.rejects(inOrg(() => previewOpeningBalances({ ...authz, allowedSubsidiaryIds: new Set<string>() }, request)),
        (error: unknown) => error instanceof OpeningBalanceRefusal && error.status === 403)
      await assert.rejects(inOrg(() => previewOpeningBalances(authz, { ...request, documentDate: '2026-10-01' })), /day before the recorded cutover/)
      await assert.rejects(
        inOrg(() => previewOpeningBalances(authz, { transferId: job.id, columns: { account: 'Account', debit: 'Debit', credit: 'Credit' }, documentDate: '2026-09-30' })),
        (error: unknown) => error instanceof OpeningBalanceRefusal && /difference 0\.0100/.test(error.message),
      )
    })

    await t.test('a balanced trial balance becomes one draft journal recorded on the plan', async () => {
      const job = await stage('tb.csv', `Account,Debit,Credit\n${bank},1250.50,\n${revenue},,1000.00\nTotal,1250.50,1250.50\n${clearing},,250.50\n`)
      const columns = { account: 'Account', debit: 'Debit', credit: 'Credit' }
      const preview = await inOrg(() => previewOpeningBalances(authz, { transferId: job.id, columns, documentDate: '2026-09-30', excludeRows: [3] }))
      assert.equal(preview.totalDebits, '1250.5000')
      assert.equal(preview.net, '0.0000')
      const key = `opening-${randomUUID()}`
      const drafted = await inOrg(() => draftOpeningBalances(authz, { transferId: job.id, columns, documentDate: '2026-09-30', excludeRows: [3] }, key))
      assert.equal(drafted.status, 'draft')
      const lines = await inOrg(() => db.execute<{ account_id: string; amount: string }>(sql`
        select account_id, amount::text from document_lines where org_id=${org.orgId} and document_id=${drafted.journalId} order by line_number`))
      assert.deepEqual(lines.rows.map((line) => [line.account_id, line.amount]), [
        [org.accounts.bank, '1250.5000'], [org.accounts.revenue, '-1000.0000'], [org.accounts.clearing, '-250.5000'],
      ])
      const doc = await inOrg(() => db.execute<{ status: string; document_date: string }>(sql`select status, document_date::text from documents where org_id=${org.orgId} and id=${drafted.journalId}`))
      assert.deepEqual(doc.rows[0], { status: 'draft', document_date: '2026-09-30' })
      assert.equal((await inOrg(() => readMigrationPlan(org.orgId))).openingJournalId, drafted.journalId)
      const replay = await inOrg(() => draftOpeningBalances(authz, { transferId: job.id, columns, documentDate: '2026-09-30', excludeRows: [3] }, key))
      assert.equal(replay.journalId, drafted.journalId, 'the same command key finds the same draft')
      await assert.rejects(inOrg(() => draftOpeningBalances(authz, { transferId: job.id, columns, documentDate: '2026-09-30', excludeRows: [3] }, `another-${randomUUID()}`)),
        (error: unknown) => error instanceof OpeningBalanceRefusal && error.status === 409)
      assert.equal((await inOrg(() => readMigrationPlan(org.orgId))).openingJournalId, drafted.journalId)
    })

    await t.test('go-live refuses while a required check is open, and records nothing', async () => {
      await assert.rejects(inOrg(() => recordGoLive(me, async () => [], 'test go-live')), /Missing: foundation/)
      await assert.rejects(inOrg(() => recordGoLive(me, async () => [
        { key: 'foundation', state: 'pass', required: false, href: '/admin/setup/readiness', facts: {} },
      ], 'test go-live')), /Missing: foundation/)
      await assert.rejects(
        inOrg(() => recordGoLive(me, async () => measureCutoverChecks(org.orgId, await loadJourneyFacts(org.orgId)), 'test go-live')),
        (error: unknown) => error instanceof MigrationPlanRefusal && /openingJournalPosted/.test(error.message),
      )
      assert.equal((await inOrg(() => readMigrationPlan(org.orgId))).goLive, null)
      await inOrg(() => updateMigrationPlan(me, { path: 'mirror' }, 'test'))
      await assert.rejects(
        inOrg(() => recordGoLive(me, async () => [], 'test go-live')),
        (error: unknown) => error instanceof MigrationPlanRefusal && /system of record/.test(error.message),
      )
    })
  } finally {
    await withBypassContext(() => db.execute(sql`delete from connections where org_id=${other.orgId}`))
    await dropScratchOrgReporting(org.orgId)
    await dropScratchOrgReporting(other.orgId)
  }
})
