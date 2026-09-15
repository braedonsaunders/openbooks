import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../lib/auth'
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __constructionSovSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__constructionSovSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { randomUUID } = await import('node:crypto')
const construction = await import('./route')

const post = (handler: (req: Request) => Promise<Response>, orgId: string, body: Record<string, unknown>) =>
  withOrgContext(orgId, () => handler(new Request('http://audit.local/api', { method: 'POST', body: JSON.stringify(body) })))

/**
 * A schedule line created by an approved change order is controlled: its
 * value moved the contract sum alongside the contract value with a paper
 * trail. Editing it directly (like deleting it) must go through a change
 * order, or the billed ceiling silently diverges from the approved contract.
 */
test('updateSov refuses a change-order-controlled schedule line', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Billing controller', email: 'billing@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID(), plain = randomUUID(), coLine = randomUUID(), co = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'sov control fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'SOV','SOV control job',${org.customerId},${typeId},'active',true)`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order) values (${plain},${org.orgId},${project},'Direct line','1000',1)`)
    // The exact state an approved unallocated change order leaves behind: the
    // contract value moved with it and the created line carries its id.
    await db.execute(sql`insert into change_orders(id,org_id,project_id,number,description,amount,status,approved_on,approved_by,created_by,updated_by)
      values (${co},${org.orgId},${project},'CO-1','Extra scope','5000','approved',${org.date},${actor},${actor},${actor})`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order,change_order_id) values (${coLine},${org.orgId},${project},'CO-1','5000',2,${co})`)
    await db.execute(sql`update projects set contract_value='5000' where org_id=${org.orgId} and id=${project}`)

    const refused = await post(construction.POST, org.orgId, { action: 'updateSov', id: coLine, description: 'Repriced', scheduledValue: '10000' })
    assert.equal(refused.status, 422)
    assert.match((await refused.json()).error, /change order/i)
    assert.equal((await db.execute<{ v: string }>(sql`select scheduled_value::text as v from sov_lines where id=${coLine}`)).rows[0]!.v, '5000.0000')

    // Ordinary lines stay editable before billing begins.
    const allowed = await post(construction.POST, org.orgId, { action: 'updateSov', id: plain, description: 'Renamed', scheduledValue: '1200' })
    assert.equal(allowed.status, 200)

    const malformed = await post(construction.POST, org.orgId, {
      action: 'addChangeOrder', projectId: project, number: 'CO-BAD', amount: '100', targetSovLineId: 'not-a-uuid',
    })
    assert.equal(malformed.status, 422)
    assert.match((await malformed.json()).error, /target schedule line/i)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})

test('approving a targeted change order controls the repriced schedule line', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const preparer = await createScratchUser(org.orgId, 'Change-order preparer', 'reviewer')
    const approver = await createScratchUser(org.orgId, 'Change-order approver', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    const user = (id: string, name: string, email: string) => ({
      id, orgId: org.orgId, name, email, roles: [], isSuperAdmin: false,
      envKind: 'production' as const, productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: id,
    })
    session.user = user(preparer, 'Change-order preparer', 'preparer@scratch.test')

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID(), target = randomUUID(), co = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'targeted_change_order','Targeted change order','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'targeted change order fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,contract_value)
      values (${project},${org.orgId},${org.subsidiaryId},'TCO','Targeted change order job',${org.customerId},${typeId},'active',true,'1000')`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order)
      values (${target},${org.orgId},${project},'Base scope','1000',1)`)
    await db.execute(sql`insert into change_orders(id,org_id,project_id,number,description,amount,target_sov_line_id,status,created_by,updated_by)
      values (${co},${org.orgId},${project},'CO-1','Revised scope','500',${target},'draft',${preparer},${preparer})`)

    session.user = user(approver, 'Change-order approver', 'approver@scratch.test')
    const approved = await post(construction.POST, org.orgId, { action: 'approveChangeOrder', id: co, approvedOn: org.date })
    assert.equal(approved.status, 200)
    assert.deepEqual((await db.execute<{ change_order_id: string | null; scheduled_value: string }>(sql`
      select change_order_id, scheduled_value::text from sov_lines where org_id=${org.orgId} and id=${target}
    `)).rows[0], { change_order_id: co, scheduled_value: '1500.0000' })

    const refused = await post(construction.POST, org.orgId, { action: 'updateSov', id: target, description: 'Unauthorized reprice', scheduledValue: '1600' })
    assert.equal(refused.status, 422)
    assert.match((await refused.json()).error, /change order/i)
    assert.equal((await db.execute<{ scheduled_value: string }>(sql`select scheduled_value::text from sov_lines where org_id=${org.orgId} and id=${target}`)).rows[0]!.scheduled_value, '1500.0000')
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})

/**
 * The income-account pin binds its id into a uuid column. A malformed id
 * must be the same clean 422 as an unknown account — never a PostgreSQL
 * uuid cast error escaping as a 500. Same class as the change-order target
 * id fix; this is its addSov/updateSov sibling.
 */
test('SOV writes refuse a malformed income account with a domain error', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'SOV writer', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'SOV writer', email: 'sov@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID(), plain = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'sov account fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'SOV-ACCT','SOV account job',${org.customerId},${typeId},'active',true)`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,sort_order) values (${plain},${org.orgId},${project},'Direct line','1000',1)`)

    const addRefused = await post(construction.POST, org.orgId, {
      action: 'addSov', projectId: project, description: 'Bad account line', scheduledValue: '100', incomeAccountId: 'not-a-uuid',
    })
    assert.equal(addRefused.status, 422)
    assert.match((await addRefused.json()).error, /Income account/)

    const updateRefused = await post(construction.POST, org.orgId, {
      action: 'updateSov', id: plain, description: 'Renamed', scheduledValue: '1200', incomeAccountId: 'not-a-uuid',
    })
    assert.equal(updateRefused.status, 422)
    assert.match((await updateRefused.json()).error, /Income account/)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from sov_lines where org_id=${org.orgId} and project_id=${project}`)).rows[0]!.n, 1)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})

/**
 * Change-order numbers are unique per project in storage. Reusing a number
 * (double submit, retry after a partial failure) must fail closed as a
 * domain error — never escape as a PostgreSQL unique violation (a 500).
 */
test('addChangeOrder refuses a duplicate change-order number', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'CO writer', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'CO writer', email: 'co@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID(), co = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'co number fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'SOV-DUP','CO number job',${org.customerId},${typeId},'active',true)`)
    await db.execute(sql`insert into change_orders(id,org_id,project_id,number,description,amount,status,created_by,updated_by)
      values (${co},${org.orgId},${project},'CO-1','First scope','500','draft',${actor},${actor})`)

    const refused = await post(construction.POST, org.orgId, {
      action: 'addChangeOrder', projectId: project, number: 'CO-1', amount: '250',
    })
    assert.equal(refused.status, 422)
    assert.match((await refused.json()).error, /already exists/)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from change_orders where org_id=${org.orgId} and project_id=${project}`)).rows[0]!.n, 1)

    // Simultaneous double submit: the unique index serializes the pair, so
    // exactly one insert wins and the loser fails closed (422 pre-check or
    // 409 race mapping) instead of escaping as a 500 — whichever interleaving
    // occurs.
    const raced = await Promise.all([
      post(construction.POST, org.orgId, { action: 'addChangeOrder', projectId: project, number: 'CO-RACE', amount: '100' }),
      post(construction.POST, org.orgId, { action: 'addChangeOrder', projectId: project, number: 'CO-RACE', amount: '100' }),
    ])
    const statuses = raced.map((response) => response.status).sort()
    assert.equal(statuses[0], 201)
    assert.ok(statuses[1] === 422 || statuses[1] === 409, `loser fails closed, got ${statuses[1]}`)
    assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from change_orders where org_id=${org.orgId} and project_id=${project} and number='CO-RACE'`)).rows[0]!.n, 1)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
