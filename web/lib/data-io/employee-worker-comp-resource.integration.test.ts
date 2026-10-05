import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { SessionUser } from '../auth'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/platform/database'
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import { employeeWorkerCompResource } from './employee-worker-comp-resource'

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __workerCompSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__workerCompSession.user}' }
  return next(specifier, context)
} })
const { GET, PATCH } = await import('../../app/api/parties/[id]/route')

async function fixture() {
  const { orgId, subsidiaryId } = await createScratchOrg()
  const actorId = (await seedFlowActors(orgId)).adminId
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${orgId} and key='admin'`)
  await db.execute(sql`update orgs set settings=settings || '{"features":{"payroll":true}}'::jsonb where id=${orgId}`)
  const employeeId = randomUUID(), groupId = randomUUID(), otherGroupId = randomUUID()
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
    values (${employeeId},${orgId},'employee','Worker compensation employee',${subsidiaryId})`)
  await db.execute(sql`insert into employee_roles(org_id,party_id,employee_number,job_title,hired_on)
    values (${orgId},${employeeId},'00042','Field technician','2025-01-01')`)
  for (const [id, code] of [[groupId, 'FIELD'], [otherGroupId, 'SHOP']]) {
    await db.execute(sql`insert into worker_comp_groups(id,org_id,code,name,rate_percent,max_assessable)
      values (${id},${orgId},${code},${code},'1.3200','121700.0000')`)
  }
  const row = { employee: employeeId, group: groupId, expectedGroup: '', reason: 'Verified source employee classification' }
  const context = { orgId, actorId, allowedSubsidiaryIds: null, dryRun: false }
  const snapshot = async () => (await db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'parties',(select jsonb_agg(to_jsonb(p) order by p.id) from parties p where org_id=${orgId}),
    'roles',(select jsonb_agg(to_jsonb(e) order by e.id) from employee_roles e where org_id=${orgId}),
    'groups',(select jsonb_agg(to_jsonb(g) order by g.id) from worker_comp_groups g where org_id=${orgId}),
    'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where org_id=${orgId})) as state`)).rows[0]!.state
  return { orgId, subsidiaryId, actorId, employeeId, groupId, otherGroupId, row, context, snapshot, resource: employeeWorkerCompResource(orgId) }
}

test('classification preview writes nothing; apply preserves employee facts, audits the assignment and replays without effects', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    const before = await fx.snapshot()
    assert.equal((await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun: true })).updated, 1)
    assert.deepEqual(await fx.snapshot(), before)
    const roleBefore = (await db.execute<Record<string, unknown>>(sql`select * from employee_roles where org_id=${fx.orgId} and party_id=${fx.employeeId}`)).rows[0]!
    assert.equal((await fx.resource.write([fx.row], 'upsert', fx.context)).updated, 1)
    const roleAfter = (await db.execute<Record<string, unknown>>(sql`select * from employee_roles where org_id=${fx.orgId} and party_id=${fx.employeeId}`)).rows[0]!
    assert.equal(roleAfter.worker_comp_group_id, fx.groupId)
    const omitChange = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !['worker_comp_group_id', 'updated_at', 'updated_by'].includes(key)))
    assert.deepEqual(omitChange(roleAfter), omitChange(roleBefore))
    const audits = (await db.execute<{ actor_id: string; changes: { before: unknown; after: unknown; reason: string } }>(sql`select actor_id,changes from audit_log where org_id=${fx.orgId} and table_name='employee_roles'`)).rows
    assert.equal(audits.length, 1)
    assert.equal(audits[0]!.actor_id, fx.actorId)
    assert.deepEqual(audits[0]!.changes.before, { workerCompGroupId: null })
    assert.deepEqual(audits[0]!.changes.after, { workerCompGroupId: fx.groupId })
    assert.equal(audits[0]!.changes.reason, fx.row.reason)
    const after = await fx.snapshot()
    assert.equal((await fx.resource.write([fx.row], 'upsert', fx.context)).updated, 0)
    assert.deepEqual(await fx.snapshot(), after)
    assert.equal((await fx.resource.read({ allowedSubsidiaryIds: null })).rows[0]!.group, fx.groupId)
    assert.equal((await fx.resource.read({ allowedSubsidiaryIds: new Set() })).rows.length, 0)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('classification preview and apply refuse foreign groups, missing employees, stale assignments, duplicate rows and missing authority without effects', async () => withBypassContext(async () => {
  const fx = await fixture(), foreign = await createScratchOrg()
  try {
    const foreignGroup = randomUUID()
    await db.execute(sql`insert into worker_comp_groups(id,org_id,code,name) values (${foreignGroup},${foreign.orgId},'FOREIGN','Foreign group')`)
    const before = await fx.snapshot()
    for (const dryRun of [true, false]) {
      for (const [row, context, message] of [
        [{ ...fx.row, group: foreignGroup }, fx.context, /unavailable in this organization/],
        [{ ...fx.row, employee: foreign.customerId }, fx.context, /not available in your legal entity/],
        [{ ...fx.row, expectedGroup: fx.otherGroupId }, fx.context, /assignment changed/],
        [{ ...fx.row, group: '' }, fx.context, /cannot clear a classification/],
        [{ ...fx.row, reason: '' }, fx.context, /reason or source reference/],
        [fx.row, { ...fx.context, allowedSubsidiaryIds: new Set<string>() }, /not available in your legal entity/],
        [fx.row, { ...fx.context, actorId: randomUUID() }, /manage permission/],
      ] as const) {
        const result = await fx.resource.write([row], 'upsert', { ...context, dryRun })
        assert.equal(result.failed, 1)
        assert.match(result.errors[0]!.message, message)
      }
      const duplicate = await fx.resource.write([fx.row, fx.row], 'upsert', { ...fx.context, dryRun })
      assert.equal(duplicate.failed, 2)
      assert.match(duplicate.errors[0]!.message, /more than once/)
    }
    assert.deepEqual(await fx.snapshot(), before)
    await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${fx.orgId} and key='admin'`)
    for (const dryRun of [true, false]) assert.match((await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun })).errors[0]!.message, /not available in your legal entity/)
    assert.deepEqual(await fx.snapshot(), before)
    await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${fx.orgId} and key='admin'`)
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,payroll}','false') where id=${fx.orgId}`)
    for (const dryRun of [true, false]) assert.match((await fx.resource.write([fx.row], 'upsert', { ...fx.context, dryRun })).errors[0]!.message, /Company Settings → Features/)
    assert.deepEqual(await fx.snapshot(), before)
  } finally { await dropScratchOrgReporting(foreign.orgId); await dropScratchOrgReporting(fx.orgId) }
}))

test('a stale classification import cannot replace a newer assignment', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    assert.equal((await fx.resource.write([fx.row], 'upsert', fx.context)).updated, 1)
    const before = await fx.snapshot()
    for (const dryRun of [true, false]) {
      const refused = await fx.resource.write([{ ...fx.row, group: fx.otherGroupId }], 'upsert', { ...fx.context, dryRun })
      assert.equal(refused.failed, 1)
      assert.match(refused.errors[0]!.message, /export and review the current group/)
    }
    assert.deepEqual(await fx.snapshot(), before)
    assert.equal((await fx.resource.write([{ ...fx.row, group: fx.otherGroupId, expectedGroup: fx.groupId }], 'upsert', fx.context)).updated, 1)
  } finally { await dropScratchOrgReporting(fx.orgId) }
}))

test('the employee drawer saves the same classification and retains complete employee before and after audit evidence', async () => withBypassContext(async () => {
  const fx = await fixture()
  try {
    session.user = { id: fx.actorId, orgId: fx.orgId, name: 'Employee administrator', email: 'employee@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: fx.orgId, homeOrgId: fx.orgId, homeUserId: fx.actorId }
    const params = { params: Promise.resolve({ id: fx.employeeId }) }
    const loaded = await withOrgContext(fx.orgId, () => GET(new Request('http://employees.test/api'), params))
    assert.equal(loaded.status, 200)
    const payload = await loaded.json() as { party: { updated_at: string } }
    const before = await fx.snapshot()
    const refused = await withOrgContext(fx.orgId, () => PATCH(new Request('http://employees.test/api', {
      method: 'PATCH', body: JSON.stringify({ expectedUpdatedAt: payload.party.updated_at,
        roles: { employee: { enabled: true, workerCompGroupId: fx.groupId } }, addresses: [{ country: 'ZZ' }] }),
    }), params))
    assert.equal(refused.status, 422)
    assert.match((await refused.json() as { error: string }).error, /Country must be a valid ISO/)
    assert.deepEqual(await fx.snapshot(), before, 'a later drawer refusal rolls back the classification and both audit records')
    const saved = await withOrgContext(fx.orgId, () => PATCH(new Request('http://employees.test/api', {
      method: 'PATCH', body: JSON.stringify({ expectedUpdatedAt: payload.party.updated_at, changeReason: fx.row.reason,
        roles: { employee: { enabled: true, employeeNumber: '00042', jobTitle: 'Field technician', hiredOn: '2025-01-01', workerCompGroupId: fx.groupId } } }),
    }), params))
    assert.equal(saved.status, 200, await saved.clone().text())
    const actual = await saved.json() as { employee: { worker_comp_group_id: string } }
    assert.equal(actual.employee.worker_comp_group_id, fx.groupId)
    const evidence = (await db.execute<{ changes: { before: { employeeRole: Record<string, unknown> }; after: { employeeRole: Record<string, unknown> } } }>(sql`select changes from audit_log where org_id=${fx.orgId} and table_name='parties' and row_id=${fx.employeeId}`)).rows[0]!.changes
    assert.ok(evidence.before.employeeRole, 'Employee changes must retain the complete pre-save role record in the audit')
    assert.ok(evidence.after.employeeRole, 'Employee changes must retain the complete saved role record in the audit')
    assert.equal(evidence.before.employeeRole.worker_comp_group_id, null)
    assert.equal(evidence.after.employeeRole.worker_comp_group_id, fx.groupId)
    assert.equal(evidence.before.employeeRole.employee_number, '00042')
    assert.equal(evidence.after.employeeRole.job_title, 'Field technician')
    assert.equal((await db.execute(sql`select id from audit_log where org_id=${fx.orgId} and table_name='employee_roles'`)).rows.length, 1)
  } finally { session.user = null; await dropScratchOrgReporting(fx.orgId) }
}))
