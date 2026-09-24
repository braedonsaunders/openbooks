import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __constructionScopeSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__constructionScopeSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { randomUUID } = await import('node:crypto')
const construction = await import('./route')

const DB = !!process.env.OPENBOOKS_DB_URL

// H-CONSTRUCTION-REHOME (route half): every construction path resolves the
// project's subsidiary at entry and rechecks it under the project row lock
// inside the write transaction. An A-only caller must get the uniform
// not-found for B's project on reads and on every write — and the allowed
// A-project flow must keep working, including the snapshot GET.

async function fixture() {
  const org = await createScratchOrg()
  const owner = await createScratchUser(org.orgId, 'Owner', 'scope_owner')
  const owner2 = await createScratchUser(org.orgId, 'Owner 2', 'scope_owner2')
  const scoped = await createScratchUser(org.orgId, 'A clerk', 'scope_clerk')
  let subB = ''
  await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key in ('scope_owner','scope_owner2')`)
  const subRow = await db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    select ${randomUUID()}, ${org.orgId}, s.id, 'Entity B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
      from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)
  subB = subRow.rows[0]!.id
  await db.execute(sql`
    update app_roles set permissions='["ar.read","ar.create","ar.approve","ar.post"]'::jsonb,
      subsidiary_restriction=${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id=${org.orgId} and key='scope_clerk'`)
  const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
  const typeId = randomUUID()
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'scope fixture')`)
  const projectA = randomUUID()
  const projectB = randomUUID()
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
    values (${projectA},${org.orgId},${org.subsidiaryId},'SCOPE-A','In-scope job',${org.customerId},${typeId},'active',true)`)
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
    values (${projectB},${org.orgId},${subB},'SCOPE-B','Out-of-scope job',${org.customerId},${typeId},'active',true)`)
  const lineB = randomUUID()
  await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,retainage_percent,sort_order)
    values (${lineB},${org.orgId},${projectB},'Finishes','250000','5',1)`)
  const user = (id: string, name: string, email: string): SessionUser => ({
    id, orgId: org.orgId, name, email, roles: [], isSuperAdmin: false, envKind: 'production',
    productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id,
  })
  const asOwner = () => { session.user = user(owner, 'Owner', 'owner@scratch.test') }
  const asOwner2 = () => { session.user = user(owner2, 'Owner 2', 'owner2@scratch.test') }
  const asScoped = () => { session.user = user(scoped, 'A clerk', 'clerk@scratch.test') }
  const get = (projectId: string) =>
    withOrgContext(org.orgId, () => construction.GET(new Request(`http://audit.local/api?projectId=${projectId}`)))
  const post = (body: Record<string, unknown>) =>
    withOrgContext(org.orgId, () => construction.POST(new Request('http://audit.local/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })))
  const close = async () => {
    session.user = null
    await dropScratchOrg(org.orgId)
  }
  return { org, projectA, projectB, lineB, asOwner, asOwner2, asScoped, get, post, close }
}

test('an A-only caller sees only not-found for B’s project reads and SOV writes', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    f.asScoped()
    const get = await f.get(f.projectB)
    assert.equal(get.status, 404, 'GET on B’s project is not-found')
    for (const body of [
      { action: 'addSov', projectId: f.projectB, description: 'X', scheduledValue: '100' },
      { action: 'updateSov', id: f.lineB, description: 'X', scheduledValue: '100' },
      { action: 'deleteSov', id: f.lineB },
      { action: 'addChangeOrder', projectId: f.projectB, number: 'CO-1', amount: '100' },
    ]) {
      const res = await f.post(body)
      assert.equal(res.status, 404, `expected not-found for ${body.action}`)
    }
    const lines = (await db.execute<{ n: string }>(sql`select count(*) as n from sov_lines where org_id=${f.org.orgId} and project_id=${f.projectB}`)).rows[0]!.n
    assert.equal(lines, '1', 'no SOV line was added, changed, or removed on B’s project')
    const orders = (await db.execute<{ n: string }>(sql`select count(*) as n from change_orders where org_id=${f.org.orgId} and project_id=${f.projectB}`)).rows[0]!.n
    assert.equal(orders, '0', 'no change order landed on B’s project')
  } finally {
    await f.close()
  }
})

test('an A-only caller cannot touch B’s pay-application lifecycle', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    f.asOwner()
    const created = await f.post({ action: 'createPayApp', projectId: f.projectB, periodEnd: f.org.date })
    assert.equal(created.status, 201)
    const appId = (await created.json() as { id: string }).id

    f.asScoped()
    const submitted = await f.post({
      action: 'submitPayApp', payApplicationId: appId,
      lines: [{ sovLineId: f.lineB, thisPeriodCompleted: '5000', materialsStored: '0' }],
    })
    assert.equal(submitted.status, 404, 'restricted submit is not-found')
    let status = (await db.execute<{ status: string }>(sql`select status from pay_applications where id=${appId}`)).rows[0]!.status
    assert.equal(status, 'draft', 'the refused submit advances nothing')

    f.asOwner()
    assert.equal((await f.post({
      action: 'submitPayApp', payApplicationId: appId,
      lines: [{ sovLineId: f.lineB, thisPeriodCompleted: '5000', materialsStored: '0' }],
    })).status, 200)
    f.asOwner2()
    // Owner 2 approves (segregation of duties: the submitter cannot approve).
    const approved = await f.post({ action: 'approvePayApp', payApplicationId: appId })
    assert.equal(approved.status, 200)

    f.asScoped()
    assert.equal((await f.post({ action: 'approvePayApp', payApplicationId: appId })).status, 404)
    assert.equal((await f.post({ action: 'voidPayApp', payApplicationId: appId })).status, 404)
    assert.equal((await f.post({ action: 'billPayApp', payApplicationId: appId })).status, 404)
    assert.equal((await f.post({ action: 'releaseRetainage', projectId: f.projectB, periodEnd: f.org.date, amount: '10' })).status, 404)
    status = (await db.execute<{ status: string }>(sql`select status from pay_applications where id=${appId}`)).rows[0]!.status
    assert.equal(status, 'approved', 'none of the refused writes moved the application')
  } finally {
    await f.close()
  }
})

test('the allowed A-project flow keeps working, including the snapshot GET', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    f.asScoped()
    const get = await f.get(f.projectA)
    assert.equal(get.status, 200, JSON.stringify(await get.clone().json()).slice(0, 300))
    const added = await f.post({ action: 'addSov', projectId: f.projectA, description: 'Allowed', scheduledValue: '1000' })
    assert.equal(added.status, 201)
    const created = await f.post({ action: 'createPayApp', projectId: f.projectA, periodEnd: f.org.date })
    assert.equal(created.status, 201)
  } finally {
    await f.close()
  }
})
