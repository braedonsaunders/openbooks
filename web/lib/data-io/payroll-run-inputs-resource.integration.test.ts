import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { createPayRun } from '@openbooks/engine/src/payroll/run-lifecycle.ts'
import { seedPayrollComponents } from '@openbooks/engine/src/payroll/run-setup.ts'
import { preflightPayRunAdjustment } from '@openbooks/engine/src/payroll/run-adjustments.ts'
import { recurringBenefitsRunSource } from '@openbooks/engine/src/payroll/benefit-plan-inputs.ts'
import { payrollRunInputsResource } from './payroll-run-inputs-resource'
import { transactionResource, transactionDescriptor } from './transaction-resources'
import { DOC_KINDS } from '../document-kinds'

const DB = !!process.env.OPENBOOKS_DB_URL

test('payroll ledger projections cannot use the generic transaction importer in preview or apply', async () => {
  const descriptor = transactionDescriptor(DOC_KINDS.pay_run!)
  assert.equal(descriptor.supportsImport, false); assert.equal(descriptor.canPost, false)
  assert.equal(transactionDescriptor(DOC_KINDS.vendor_bill!).supportsImport, true)
  const resource = transactionResource(DOC_KINDS.pay_run!, 'bound-org')
  for (const dryRun of [true, false]) await assert.rejects(resource.write([], 'insert', {
    orgId: 'bound-org', actorId: 'actor', dryRun, allowedSubsidiaryIds: null,
  }), /cannot be imported as ledger documents.*Pay run component inputs.*calculate and review/)
})

async function fixture() {
  const { orgId, subsidiaryId } = await createScratchOrg()
  const actorId = (await seedFlowActors(orgId)).adminId
  await db.execute(sql`update orgs set settings=settings || '{"features":{"payroll":true}}'::jsonb where id=${orgId}`)
  await seedPayrollComponents(orgId, actorId, 'CA')
  const employeeId = randomUUID(), scheduleId = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,short_code,is_active)
    values (${employeeId},${orgId},'person','Import Employee','IMPORT-EE',true)`)
  await db.execute(sql`insert into pay_schedules(id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,is_active,created_by,updated_by)
    values (${scheduleId},${orgId},'Import Schedule','biweekly',26,'2026-07-18',3,true,${actorId},${actorId})`)
  await db.execute(sql`insert into employee_payroll_profiles(org_id,employee_party_id,pay_schedule_id,country,province,pay_basis,is_active,created_by,updated_by)
    values (${orgId},${employeeId},${scheduleId},'CA','ON','salary',true,${actorId},${actorId})`)
  const run = await createPayRun({ orgId, actorId, payScheduleId: scheduleId, periodStart: '2026-07-05', periodEnd: '2026-07-18' })
  const componentId = (await db.execute<{ id: string }>(sql`select id from pay_components where org_id=${orgId} and code='BONUS'`)).rows[0]!.id
  const row = { run: run.documentId, employee: employeeId, component: 'BONUS', amount: '125.25', hours: '2.25', replaceComponent: true, note: 'Approved historical earnings input' }
  const context = { orgId, actorId, allowedSubsidiaryIds: null, dryRun: false }
  return { orgId, actorId, employeeId, componentId, subsidiaryId, documentId: run.documentId, row, context, resource: payrollRunInputsResource(orgId) }
}

test('pay run input import requires its bound organization, explicit scope, and separate payroll review', async () => {
  const resource = payrollRunInputsResource('bound-org')
  await assert.rejects(resource.write([], 'insert', { orgId: 'bound-org', actorId: 'actor', dryRun: true }), /explicit subsidiary scope/)
  await assert.rejects(resource.write([], 'insert', { orgId: 'different-org', actorId: 'actor', dryRun: true, allowedSubsidiaryIds: null }), /organization does not match/)
  await assert.rejects(resource.write([], 'insert', { orgId: 'bound-org', actorId: 'actor', dryRun: false, allowedSubsidiaryIds: null, post: true }), /cannot post payroll.*calculate and review/)
})

test('pay run input preview preserves calculated state; apply records exact inputs and audit once; retry does not duplicate', { skip: !DB }, async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    await db.execute(sql`update pay_runs set run_status='calculated',gross_total=999,net_total=800,employee_count=1,calculated_at=now() where org_id=${fx.orgId} and document_id=${fx.documentId}`)
    const snapshot = async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
      'run',(select to_jsonb(r) from pay_runs r where org_id=${fx.orgId} and document_id=${fx.documentId}),
      'inputs',(select jsonb_agg(to_jsonb(a)) from pay_run_adjustments a where org_id=${fx.orgId}),
      'audit',(select jsonb_agg(to_jsonb(a)) from audit_log a where org_id=${fx.orgId})) as state`)).rows[0]!.state
    const before = await snapshot()
    assert.deepEqual(await fx.resource.write([fx.row], 'insert', { ...fx.context, dryRun: true }), { created: 1, updated: 0, failed: 0, errors: [] })
    assert.deepEqual(await snapshot(), before, 'preview may not invalidate or write payroll')
    assert.deepEqual(await fx.resource.write([fx.row], 'insert', fx.context), { created: 1, updated: 0, failed: 0, errors: [] })
    const saved = (await db.execute<{ amount: string; hours: string; replace_component: boolean }>(sql`select amount::text,hours::text,replace_component from pay_run_adjustments where org_id=${fx.orgId}`)).rows
    assert.deepEqual(saved, [{ amount: '125.2500', hours: '2.25', replace_component: true }])
    const run = (await db.execute<{ run_status: string; gross_total: string; calculated_at: unknown }>(sql`select run_status,gross_total::text,calculated_at from pay_runs where org_id=${fx.orgId} and document_id=${fx.documentId}`)).rows[0]
    assert.deepEqual(run, { run_status: 'draft', gross_total: '0.0000', calculated_at: null })
    const audit = (await db.execute<{ changes: { before: unknown; after: { hours: string }; reason: string }; actor_id: string }>(sql`select changes,actor_id from audit_log where org_id=${fx.orgId} and table_name='pay_run_adjustments'`)).rows
    assert.equal(audit.length, 1); assert.equal(audit[0]!.actor_id, fx.actorId); assert.equal(audit[0]!.changes.before, null)
    assert.equal(audit[0]!.changes.after.hours, '2.25'); assert.equal(audit[0]!.changes.reason, fx.row.note)
    const applied = await snapshot()
    for (const dryRun of [true, false]) {
      assert.deepEqual(await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun }), { created: 0, updated: 0, failed: 0, errors: [] })
      const changed = await fx.resource.write([{ ...fx.row, amount: '125.26' }], 'upsert', { ...fx.context, dryRun })
      assert.equal(changed.failed, 1); assert.match(changed.errors[0]!.message, /different details.*remove its existing adjustment.*preview/)
      assert.deepEqual(await snapshot(), applied)
    }
    const exported = await fx.resource.read({ allowedSubsidiaryIds: null })
    assert.equal(exported.rows.length, 1); assert.equal(exported.rows[0]!.hours, '2.25')
    assert.equal((await fx.resource.read({ allowedSubsidiaryIds: new Set() })).rows.length, 0)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('pay run input preview and apply refuse the same invalid amounts, hours, policies, duplicates and hidden records', { skip: !DB }, async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    for (const [overrides, message] of [
      [{ amount: '12,34' }, /write "12,34" as "12\.34"/],
      [{ amount: '1e3' }, /scientific/i],
      [{ hours: '2.255' }, /decimal places/i],
      [{ hours: '-2' }, /non-negative/],
      [{ replaceComponent: 'perhaps' }, /must be a boolean/],
      [{ note: '' }, /reason or source reference/],
      [{ component: 'TAX' }, /component cannot be adjusted/],
      [{ employee: randomUUID() }, /Employee not found/],
    ] as const) {
      const preview = await fx.resource.write([{ ...fx.row, ...overrides }], 'insert', { ...fx.context, dryRun: true })
      const apply = await fx.resource.write([{ ...fx.row, ...overrides }], 'insert', fx.context)
      assert.deepEqual(apply, preview); assert.equal(apply.failed, 1); assert.match(apply.errors[0]!.message, message)
    }
    for (const dryRun of [true, false]) {
      const duplicate = await fx.resource.write([fx.row, { ...fx.row, employee: 'IMPORT-EE', component: fx.componentId }], 'insert', { ...fx.context, dryRun })
      assert.equal(duplicate.failed, 2); assert.ok(duplicate.errors.every(error => /more than once.*combine/.test(error.message)))
      const hidden = await fx.resource.write([fx.row], 'insert', { ...fx.context, dryRun, allowedSubsidiaryIds: new Set() })
      assert.equal(hidden.failed, 1); assert.match(hidden.errors[0]!.message, /Pay run not found/)
    }
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from pay_run_adjustments where org_id=${fx.orgId}`)).rows[0]!.n, 0)
    await assert.rejects(preflightPayRunAdjustment({ orgId: fx.orgId, actorId: fx.actorId, documentId: fx.documentId,
      mutation: { action: 'exclude', employeePartyId: fx.employeeId } as never }), /preflight only supports adding a line/)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false'::jsonb) where id=${fx.orgId}`)
    await assert.rejects(fx.resource.write([fx.row], 'insert', fx.context), /Payroll is disabled.*Company Settings/)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('pay run input apply revalidates editability after a successful preview', { skip: !DB }, async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    assert.equal((await fx.resource.write([fx.row], 'insert', { ...fx.context, dryRun: true })).created, 1)
    const benefitSource = await recurringBenefitsRunSource(db, fx.orgId, fx.documentId)
    await db.execute(sql`update pay_runs set run_status='committed',benefit_source_snapshot=${JSON.stringify(benefitSource)}::jsonb where org_id=${fx.orgId} and document_id=${fx.documentId}`)
    const apply = await fx.resource.write([fx.row], 'insert', fx.context)
    assert.equal(apply.failed, 1); assert.match(apply.errors[0]!.message, /pay run is not editable/)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from pay_run_adjustments where org_id=${fx.orgId}`)).rows[0]!.n, 0)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))
