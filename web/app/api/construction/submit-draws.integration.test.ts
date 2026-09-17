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
 * Draw-entry inputs arrive as strings; an untouched "Materials stored" cell
 * submits "". The submit path must read a blank draw as zero — the tester
 * typed 5000 / left-blank and the application silently 422d, while typing
 * an explicit 0 submitted fine.
 */
test('submitPayApp reads blank draw amounts as zero', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
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
      values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'draws fixture')`)
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
      values (${project},${org.orgId},${org.subsidiaryId},'DRAW','Draw test job',${org.customerId},${typeId},'active',true)`)
    await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,retainage_percent,sort_order) values (${line},${org.orgId},${project},'Finishes','250000','5',1)`)

    const created = await post(construction.POST, org.orgId, { action: 'createPayApp', projectId: project, periodEnd: org.date })
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
    const appId = (await created.json() as { id: string }).id

    const submitted = await post(construction.POST, org.orgId, {
      action: 'submitPayApp',
      payApplicationId: appId,
      lines: [{ sovLineId: line, thisPeriodCompleted: '5000', materialsStored: '' }],
    })
    assert.equal(submitted.status, 200, JSON.stringify(await submitted.clone().json()))
    const status = (await db.execute<{ status: string }>(sql`select status from pay_applications where id=${appId}`)).rows[0]!.status
    assert.equal(status, 'submitted')
  } finally { session.user = null; await dropScratchOrg(org.orgId) }
})
