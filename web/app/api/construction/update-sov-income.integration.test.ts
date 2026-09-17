import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from '../../../lib/auth'

const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __constructionDrawsSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__constructionDrawsSession.user}' }
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
 * F-t03-002: once billing begins, SOV value fields are change-order
 * controlled — but the income account is posting metadata, not a contract
 * term. An approved application whose lines predate the income-account
 * requirement can never reach invoicing unless a locked line still accepts
 * an income-account-only change. Anything beyond the income account must
 * still refuse with the controlled-line message.
 */
test('updateSov accepts an income-account-only change on an application-used line', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg()
  try {
    const actor = await createScratchUser(org.orgId, 'Billing controller', 'reviewer')
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`)
    session.user = { id: actor, orgId: org.orgId, name: 'Billing controller', email: 'billing@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor }

    const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
    const typeId = randomUUID(), project = randomUUID(), line = randomUUID()
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'sov income fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'SOVINC','SOV income test job',${org.customerId},${typeId},'active',true)`)
    const altIncome = randomUUID()
    await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${altIncome}, ${org.orgId}, '4999', 'Alt Service Revenue', 'income', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,item_no,description,scheduled_value,retainage_percent,income_account_id,sort_order) values (${line},${org.orgId},${project},'01-MOB','Mobilization','50000','10',${org.accounts.revenue},1)`)

    const created = await post(construction.POST, org.orgId, { action: 'createPayApp', projectId: project, periodEnd: org.date })
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
    const appId = (await created.json() as { id: string }).id
    const submitted = await post(construction.POST, org.orgId, {
      action: 'submitPayApp',
      payApplicationId: appId,
      lines: [{ sovLineId: line, thisPeriodCompleted: '5000', materialsStored: '0' }],
    })
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))

    const incomeOnly = await post(construction.POST, org.orgId, {
      action: 'updateSov', id: line, itemNo: '01-MOB', description: 'Mobilization',
      scheduledValue: '50000', retainagePercent: '10', incomeAccountId: altIncome,
    })
    assert.equal(incomeOnly.status, 200, JSON.stringify(await incomeOnly.clone().json()))
    const stored = (await db.execute<{ income_account_id: string; description: string; scheduled_value: string }>(sql`select income_account_id, description, scheduled_value from sov_lines where id=${line}`)).rows[0]!
    assert.equal(stored.income_account_id, altIncome)
    assert.equal(stored.description, 'Mobilization')

    const repriced = await post(construction.POST, org.orgId, {
      action: 'updateSov', id: line, itemNo: '01-MOB', description: 'Mobilization repriced',
      scheduledValue: '60000', retainagePercent: '10', incomeAccountId: altIncome,
    })
    assert.equal(repriced.status, 422)
    assert.match((await repriced.json() as { error: string }).error, /immutable|change order/i)
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
