import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'

const root = pathToFileURL(process.cwd() + '/').href
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
}})

const { sql } = await import('drizzle-orm')
const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { randomUUID } = await import('node:crypto')
const { createPayApplication, submitPayApplication } = await import('./construction-billing.ts')

const DB = !!process.env.OPENBOOKS_DB_URL

// H-CONSTRUCTION-REHOME (engine half): the pay-application writers recheck
// the caller's subsidiary scope under the project row lock. A caller scoped
// to entity A must not submit B's application even when the route's unlocked
// entry check is bypassed or stale — the engine refuses with the uniform
// not-found shape and writes nothing.

async function fixture() {
  const org = await createScratchOrg()
  const actor = (await seedFlowActors(org.orgId)).adminId
  const second = (await db.execute<{ id: string }>(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    select ${randomUUID()}, ${org.orgId}, s.id, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb
      from subsidiaries s where s.org_id = ${org.orgId} and s.parent_id is null limit 1 returning id`)).rows[0]!.id
  const sov = BUILTIN_PROJECT_TYPES.find((t) => t.key === 'schedule_of_values')!
  const typeId = randomUUID()
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values (${typeId},${org.orgId},'schedule_of_values','Schedule of Values','fixed_price',${JSON.stringify(sov.invoicingProfile)}::jsonb,${JSON.stringify(sov.backupProfile)}::jsonb)`)
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values (${org.orgId},${typeId},'2000-01-01',${JSON.stringify(sov.financialProfile)}::jsonb,'scope fixture')`)
  const projectB = randomUUID()
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active)
    values (${projectB},${org.orgId},${second},'SCOPE-B','Out-of-scope job',${org.customerId},${typeId},'active',true)`)
  const line = randomUUID()
  await db.execute(sql`insert into sov_lines(id,org_id,project_id,description,scheduled_value,retainage_percent,sort_order)
    values (${line},${org.orgId},${projectB},'Finishes','250000','5',1)`)
  return { org, actor, projectB, line, scopeA: new Set([org.subsidiaryId]) }
}

test('submitPayApplication refuses an out-of-scope project and writes nothing', { skip: !DB }, async () => {
  const { org, actor, projectB, line, scopeA } = await fixture()
  try {
    const app = await createPayApplication(org.orgId, actor, projectB, org.date, '10', null)
    await assert.rejects(
      submitPayApplication(org.orgId, actor, app.id, [
        { sovLineId: line, thisPeriodCompleted: '5000', materialsStored: '0' },
      ], scopeA),
      (error: unknown) => error instanceof ScopeNotFoundError,
      'an A-scoped caller must not submit B’s application',
    )
    const status = (await db.execute<{ status: string }>(sql`select status from pay_applications where id=${app.id}`)).rows[0]!.status
    assert.equal(status, 'draft', 'the refused submit leaves the application untouched')
    const draws = (await db.execute<{ n: string }>(sql`select count(*) as n from pay_application_lines where pay_application_id=${app.id} and this_period_completed <> '0'`)).rows[0]!.n
    assert.equal(draws, '0', 'no draw values persist from the refused submit')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('submitPayApplication still submits with unrestricted scope', { skip: !DB }, async () => {
  const { org, actor, projectB, line } = await fixture()
  try {
    const app = await createPayApplication(org.orgId, actor, projectB, org.date, '10', null)
    const computed = await submitPayApplication(org.orgId, actor, app.id, [
      { sovLineId: line, thisPeriodCompleted: '5000', materialsStored: '0' },
    ], null)
    assert.ok(Number(computed.grossThisPeriod) > 0)
    const status = (await db.execute<{ status: string }>(sql`select status from pay_applications where id=${app.id}`)).rows[0]!.status
    assert.equal(status, 'submitted')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

void root
