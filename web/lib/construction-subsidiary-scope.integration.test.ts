import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'
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
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { randomUUID } = await import('node:crypto')
const construction = await import('../app/api/construction/route')
const subcontracts = await import('../app/api/subcontracts/route')

const NOT_FOUND = { error: 'not found' }
const post = (handler: (req: Request) => Promise<Response>, orgId: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => handler(new Request('http://audit.local/api', { method: 'POST', body: JSON.stringify(body) })))
const get = (handler: (req: Request) => Promise<Response>, orgId: string, query: string) =>
  withOrgContext(orgId, () => handler(new Request('http://audit.local/api?' + query)))

/**
 * Progress billing and subcontract surfaces are project-scoped: a caller whose
 * roles restrict them to some subsidiaries must not reach another subsidiary's
 * schedule of values, applications, change orders, or subcontracts — by id,
 * by list, or through a child row. The denial must be indistinguishable from a
 * missing record.
 */
test('construction and subcontract routes enforce the caller subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}', coalesce(settings->'features','{}'::jsonb) || '{"subcontracts": true}'::jsonb) where id=${org.orgId}`)
    session.user = { id: actor, orgId: org.orgId, name: 'Billing controller', email: 'billing@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), other = randomUUID(), visible = randomUUID(), hidden = randomUUID()
    const hiddenSov = randomUUID(), hiddenContract = randomUUID(), visibleContract = randomUUID(), visibleChange = randomUUID()
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`)
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'scratch fixture baseline')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${visible},${org.orgId},${org.subsidiaryId},'VIS','Visible job',${org.customerId},${typeId},'active',true),
             (${hidden},${org.orgId},${other},'HID','Hidden job',${org.customerId},${typeId},'active',true)`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order) values (${hiddenSov},${org.orgId},${hidden},'Hidden line','1000',1)`)
    await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,title,currency,original_commitment,status)
      values (${hiddenContract},${org.orgId},${hidden},${org.vendorId},'SC-HIDDEN','Hidden scope','CAD','5000','draft'),
             (${visibleContract},${org.orgId},${visible},${org.vendorId},'SC-VISIBLE','Visible scope','CAD','5000','draft')`)
    await db.execute(sql`insert into subcontract_change_orders(id,org_id,subcontract_id,number,amount) values (${visibleChange},${org.orgId},${visibleContract},'CO-1','250')`)

    const restrict = (ids: string[] | null) => db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(ids ? { mode: 'list', subsidiaryIds: ids } : { mode: 'all' })}::jsonb where org_id=${org.orgId} and key='reviewer'`)
    await restrict([org.subsidiaryId])

    // --- construction: hidden project is a missing project -----------------
    const hiddenGet = await get(construction.GET, org.orgId, `projectId=${hidden}`)
    assert.equal(hiddenGet.status, 404); assert.deepEqual(await hiddenGet.json(), NOT_FOUND)
    const missingGet = await get(construction.GET, org.orgId, `projectId=${randomUUID()}`)
    assert.equal(missingGet.status, 404); assert.deepEqual(await missingGet.json(), NOT_FOUND)
    assert.equal((await get(construction.GET, org.orgId, `projectId=${visible}`)).status, 200)
    for (const body of [
      { action: 'addSov', projectId: hidden, description: 'Excavation', scheduledValue: '1000' },
      { action: 'updateSov', id: hiddenSov, description: 'Renamed', scheduledValue: '1200' },
      { action: 'deleteSov', id: hiddenSov },
      { action: 'addChangeOrder', projectId: hidden, number: 'CO-9', amount: '100' },
      { action: 'createPayApp', projectId: hidden, periodEnd: '2026-07-31' },
      { action: 'releaseRetainage', projectId: hidden, periodEnd: '2026-07-31', amount: '10' },
      { action: 'updateSov', id: 'not-a-uuid', description: 'x', scheduledValue: '1' },
    ]) {
      const response = await post(construction.POST, org.orgId, body)
      const text = await response.text()
      assert.equal(response.status, 404, `${body.action}: ${text}`)
      assert.deepEqual(JSON.parse(text), NOT_FOUND)
    }
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from sov_lines where org_id=${org.orgId}`)).rows[0]!.n, 1)
    // Dates are refused as domain errors, never as a database failure.
    const badDate = await post(construction.POST, org.orgId, { action: 'releaseRetainage', projectId: visible, periodEnd: '2026-02-30', amount: '10' })
    assert.equal(badDate.status, 422); assert.match((await badDate.json()).error, /valid calendar date/)

    // --- subcontracts ------------------------------------------------------
    const list = await get(subcontracts.GET, org.orgId, '')
    assert.equal(list.status, 200)
    assert.deepEqual(((await list.json()).subcontracts as { id: string }[]).map((s) => s.id), [visibleContract])
    const hiddenDetail = await get(subcontracts.GET, org.orgId, `id=${hiddenContract}`)
    assert.equal(hiddenDetail.status, 404); assert.deepEqual(await hiddenDetail.json(), NOT_FOUND)
    assert.equal((await get(subcontracts.GET, org.orgId, `id=${visibleContract}`)).status, 200)
    for (const body of [
      { action: 'createSubcontract', projectId: hidden, vendorId: org.vendorId, number: 'SC-NEW', title: 'New', originalCommitment: '100' },
      { action: 'updateSubcontract', id: hiddenContract, title: 'Renamed', originalCommitment: '100', defaultRetainagePercent: '10' },
      { action: 'addSovLine', subcontractId: hiddenContract, description: 'Line', scheduledValue: '100' },
      { action: 'addChangeOrder', subcontractId: hiddenContract, number: 'CO-H', amount: '10' },
      { action: 'submitSubcontract', id: hiddenContract },
      { action: 'createPayApplication', subcontractId: hiddenContract, periodEnd: '2026-07-31' },
      { action: 'transitionSubcontract', id: hiddenContract, transition: 'void' },
    ]) {
      const response = await post(subcontracts.POST, org.orgId, body)
      const text = await response.text()
      assert.equal(response.status, 404, `${body.action}: ${text}`)
      assert.deepEqual(JSON.parse(text), NOT_FOUND)
    }
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from subcontracts where org_id=${org.orgId}`)).rows[0]!.n, 2)
    const noDate = await post(subcontracts.POST, org.orgId, { action: 'approveChangeOrder', id: visibleChange })
    assert.equal(noDate.status, 422); assert.match((await noDate.json()).error, /valid calendar date/)

    // --- unrestricted caller sees everything ------------------------------
    await restrict(null)
    assert.equal((await get(construction.GET, org.orgId, `projectId=${hidden}`)).status, 200)
    assert.equal((await get(subcontracts.GET, org.orgId, `id=${hiddenContract}`)).status, 200)
    assert.equal(((await (await get(subcontracts.GET, org.orgId, '')).json()).subcontracts as unknown[]).length, 2)
    // Empty scope denies everything.
    await restrict([])
    assert.equal((await get(construction.GET, org.orgId, `projectId=${visible}`)).status, 404)
    assert.equal((await get(subcontracts.GET, org.orgId, `id=${visibleContract}`)).status, 404)
    assert.deepEqual((await (await get(subcontracts.GET, org.orgId, '')).json()).subcontracts, [])
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
