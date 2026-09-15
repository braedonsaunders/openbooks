import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import type { SessionUser } from './auth'
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __wipNteSwitchSession: session })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__wipNteSwitchSession.user}' }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
  return next(specifier, context)
}})
const { sql } = await import('drizzle-orm')
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const wip = await import('./wip-billing')
const headerRoute = await import('../app/api/projects/[id]/route')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/**
 * The NTE cap must follow the CURRENT policy, not just the creation-time
 * snapshot. A worksheet priced under an open policy, approved, then carried
 * into a not-to-exceed policy by a project-type switch must face the ceiling
 * at conversion — otherwise the switch silently drops the cap the sibling
 * billing path still enforces.
 */
test('converting after a switch to NTE enforces the new ceiling', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,wipBilling}', 'true'::jsonb, true) where id = ${org.orgId}`)
      const preparer = (await seedFlowActors(org.orgId)).adminId
      const approver = await createScratchUser(org.orgId, 'Billing approver', 'admin')
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key in ('admin','reviewer')`)
      session.user = { id: preparer, orgId: org.orgId, name: 'Preparer', email: 'prep@scratch.test', roles: [], isSuperAdmin: false, envKind: 'production', productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: preparer }
      const tm = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'time_and_materials')!
      const nte = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'not_to_exceed')!
      const tmType = randomUUID(), nteType = randomUUID(), project = randomUUID()
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${tmType},${org.orgId},'time_and_materials','Time & Materials','time_and_materials',${JSON.stringify(tm.invoicingProfile)}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values (${nteType},${org.orgId},'not_to_exceed','Not-to-Exceed','time_and_materials',${JSON.stringify(nte.invoicingProfile)}::jsonb,${JSON.stringify(nte.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values (${org.orgId},${tmType},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'nte switch fixture'),
              (${org.orgId},${nteType},'2000-01-01',${JSON.stringify(nte.financialProfile)}::jsonb,'nte switch fixture')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,contract_value,status,is_active,custom)
        values (${project},${org.orgId},${org.subsidiaryId},'NTE-SW','NTE switch job',${org.customerId},${tmType},'100.0000','active',true,'{}'::jsonb)`)
      const employee = randomUUID(), entry = randomUUID()
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values (${employee},${org.orgId},'employee','Switch Hand',${org.subsidiaryId},true,'{}'::jsonb)`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,is_billable,billing_status,bill_rate,project_id,item_id)
        values (${entry},${org.orgId},${employee},${org.date},'8','approved',true,'unbilled','100',${project},${org.items.service})`)
      // The ceiling is already fully claimed by a prior draft invoice.
      const doc = randomUUID(), line = randomUUID()
      await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,currency,status,subtotal,tax_total,total)
        values (${doc},${org.orgId},'customer_invoice',${'INV-'+doc},${org.customerId},${org.subsidiaryId},${project},${org.date},'CAD','draft','100','0','100')`)
      await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,is_billable,project_id)
        values (${line},${org.orgId},${doc},1,${org.accounts.revenue},'Billed',1,'100','100',true,${project})`)

      // Priced and approved under the open policy, where no cap applies.
      const prebill = await wip.createPrebill(org.orgId, preparer, { projectId: project, periodEnd: org.date }, null)
      await wip.transitionPrebill(org.orgId, preparer, prebill.id, 'submit', undefined, null)
      await wip.transitionPrebill(org.orgId, approver, prebill.id, 'approve', undefined, null)

      // The job moves under the NTE policy with zero remaining capacity.
      const switched = await withOrgContext(org.orgId, () => headerRoute.PATCH(
        new Request('http://audit.local/api', { method: 'PATCH', body: JSON.stringify({ projectTypeId: nteType }) }),
        { params: Promise.resolve({ id: project }) },
      ))
      assert.equal(switched.status, 200)

      const invoicesBefore = (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n
      await assert.rejects(
        wip.convertPrebill(org.orgId, approver, prebill.id, null),
        /remaining not-to-exceed capacity/,
      )
      const invoicesAfter = (await db.execute<{ n: number }>(sql`select count(*)::int as n from documents where org_id=${org.orgId} and kind='customer_invoice'`)).rows[0]!.n
      assert.equal(invoicesAfter, invoicesBefore)
    } finally { session.user = null; await dropScratchOrg(org.orgId) }
  })
})
