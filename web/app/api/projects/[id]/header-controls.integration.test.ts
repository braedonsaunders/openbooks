import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import type { SessionUser } from '../../../../lib/auth'

const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, {
  __projectHeaderSession: session,
  // Refusals render through the real English catalog, so the assertions read
  // the copy an operator actually sees.
  __projectHeaderApiErrors: JSON.parse(readFileSync(new URL('../../../../messages/en/apiErrors.json', import.meta.url), 'utf8')),
})
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>globalThis.__projectHeaderApiErrors[key]??key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__projectHeaderSession.user}' }
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrg, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { loadEntities } = await import('@openbooks/engine/src/sync/migrate.ts')
const { randomUUID } = await import('node:crypto')
const header = await import('./route')
const construction = await import('../../construction/route')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
type Org = Awaited<ReturnType<typeof createScratchOrg>>

const patch = (orgId: string, id: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => header.PATCH(
    new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  ))
const post = (orgId: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => construction.POST(new Request('http://audit.local/api', { method: 'POST', body: JSON.stringify(body) })))

async function signIn(org: Org, name: string): Promise<string> {
  const id = await createScratchUser(org.orgId, name, 'reviewer')
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
  return id
}
const actAs = (org: Org, id: string) => {
  session.user = { id, orgId: org.orgId, name: id, email: `${id}@scratch.test`, roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id }
}

async function projectType(org: Org, key: 'schedule_of_values' | 'time_and_materials'): Promise<string> {
  const builtin = BUILTIN_PROJECT_TYPES.find((t) => t.key === key)!
  const id = randomUUID()
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values (${id},${org.orgId},${key},${builtin.name},${builtin.billingMethod},${JSON.stringify(builtin.invoicingProfile)}::jsonb,${JSON.stringify(builtin.backupProfile)}::jsonb)`)
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values (${org.orgId},${id},'2000-01-01',${JSON.stringify(builtin.financialProfile)}::jsonb,'header control fixture')`)
  return id
}

async function project(org: Org, typeId: string | null, subsidiaryId: string | null, contractValue: string | null, custom: Record<string, string> = {}): Promise<string> {
  const id = randomUUID()
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
    values (${id},${org.orgId},${subsidiaryId},${'HC-' + id.slice(0, 8)},'Header control job',${org.customerId},${typeId},${contractValue},'active',true,${JSON.stringify(custom)}::jsonb)`)
  return id
}

const contractValue = async (id: string) =>
  (await db.execute<{ v: string | null }>(sql`select contract_value::text as v from projects where id=${id}`)).rows[0]!.v

/**
 * Once the first application for payment exists, the contract sum moves only
 * through an approved change order. Every writer of the column shares that
 * control: the project header edit and the migration mirror refuse a direct
 * change by name, and the refusal's remedy (record and approve a change
 * order) is a path that actually moves the contract value.
 */
test('contract value is controlled by change orders once billing begins', enabled, async () => {
  const org = await createScratchOrg()
  try {
    const preparer = await signIn(org, 'Contract preparer')
    const approver = await signIn(org, 'Contract approver')
    actAs(org, preparer)
    const sov = await projectType(org, 'schedule_of_values')
    const billed = await project(org, sov, org.subsidiaryId, '1000', { headerControlTest: 'JOB-1' })
    await db.execute(sql`insert into pay_applications(org_id,project_id,application_number,period_end,status)
      values (${org.orgId},${billed},1,${org.date},'void')`)

    // Before billing begins the header still edits the contract value.
    const unbilled = await project(org, sov, org.subsidiaryId, '1000')
    assert.equal((await patch(org.orgId, unbilled, { contractValue: '1250' })).status, 200)
    assert.equal(await contractValue(unbilled), '1250.0000')

    const refused = await patch(org.orgId, billed, { contractValue: '2000' })
    assert.equal(refused.status, 422)
    const body = await refused.json() as { error: string; code: string }
    assert.equal(body.code, 'contract_value_controlled')
    assert.match(body.error, /Record a change order under Change orders on the project’s Billing tab/)
    assert.equal(await contractValue(billed), '1000.0000')

    // Autosave resends the unchanged value: that is not a change.
    assert.equal((await patch(org.orgId, billed, { contractValue: '1000.00', notes: 'Kickoff held' })).status, 200)

    // The migration mirror is a writer too: a re-pulled contract sum is
    // refused on that record and lands nothing.
    const source = {
      name: 'header-control-test', refKey: 'headerControlTest', baseCurrency: 'CAD',
      accountingPeriods: async () => [], entities: async () => [], trialBalance: async () => [], monthlyActivity: async () => [],
      nativeChanges: async () => { throw new Error('not used by this test') },
    } as unknown as Parameters<typeof loadEntities>[0]
    const mirrored = await withOrg(org.orgId, () => loadEntities(source, org.orgId, null, undefined, undefined,
      [{ resource: 'projects', records: [{ sourceRef: 'JOB-1', fields: { name: 'Header control job', contractValue: '3000' } }] }]))
    assert.equal(mirrored.projects?.failed, 1)
    assert.match(mirrored.projects?.errors[0]?.message ?? '', /approved change order/)
    assert.equal(await contractValue(billed), '1000.0000')

    // The named remedy works: an approved change order moves the contract.
    const created = await post(org.orgId, { action: 'addChangeOrder', projectId: billed, number: 'CO-1', description: 'Added scope', amount: '500' })
    assert.equal(created.status, 201, await created.clone().text())
    actAs(org, approver)
    const approved = await post(org.orgId, { action: 'approveChangeOrder', id: (await created.json()).id, approvedOn: org.date })
    assert.equal(approved.status, 200, await approved.clone().text())
    assert.equal(await contractValue(billed), '1500.0000')

    // A billed project moved off applications for payment cannot reach the
    // change-order path, so the refusal says to restore the type first.
    await db.execute(sql`update projects set project_type_id=${await projectType(org, 'time_and_materials')} where id=${billed}`)
    const retyped = await patch(org.orgId, billed, { contractValue: '2000' })
    assert.equal(retyped.status, 422)
    const retypedBody = await retyped.json() as { error: string; code: string }
    assert.equal(retypedBody.code, 'contract_value_controlled_type_changed')
    assert.match(retypedBody.error, /Switch the project back to a project type that bills by applications for payment/)
    assert.equal(await contractValue(billed), '1500.0000')
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
