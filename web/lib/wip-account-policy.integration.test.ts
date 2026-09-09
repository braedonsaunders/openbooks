import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { db, withBypassContext, withOrgTransaction } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const wip = await import('./wip-billing')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
type Fixture = { org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; approver: string; project: string; prebill: string; entry: string }

async function fixture(account: 'missing' | 'revenue' | 'invAsset', run: (f: Fixture) => Promise<void>) {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actors = await seedFlowActors(org.orgId)
      const profile = BUILTIN_PROJECT_TYPES.find((type) => type.key === 'time_and_materials')!
      const typeId = randomUUID(), project = randomUUID(), employee = randomUUID(), entry = randomUUID()
      const accountId = account === 'missing' ? null : org.accounts[account]
      await db.execute(sql`update items set income_account_id=${accountId} where org_id=${org.orgId} and id=${org.items.service}`)
      await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
        values(${typeId},${org.orgId},'wip_account_policy','WIP account policy','time_and_materials',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`)
      await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
        values(${org.orgId},${typeId},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch WIP account policy')`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,custom)
        values(${project},${org.orgId},${org.subsidiaryId},'WAC','WIP account job',${org.customerId},${typeId},'active',true,'{}'::jsonb)`)
      await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
        values(${employee},${org.orgId},'employee','WIP worker',${org.subsidiaryId})`)
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,project_id,item_id,is_billable,status,bill_rate,bill_rate_currency)
        values(${entry},${org.orgId},${employee},${org.date},'2.0000',${project},${org.items.service},true,'approved','100.1234','CAD')`)
      const prebill = await wip.createPrebill(org.orgId, actors.adminId, { projectId: project, periodEnd: org.date })
      assert.equal(prebill.sourceCount, 1)
      await wip.transitionPrebill(org.orgId, actors.adminId, prebill.id, 'submit')
      await wip.transitionPrebill(org.orgId, actors.approver1Id, prebill.id, 'approve')
      await run({ org, actor: actors.adminId, approver: actors.approver1Id, project, prebill: prebill.id, entry })
    } finally { await dropScratchOrg(org.orgId) }
  })
}

async function snapshot(f: Fixture) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(w) order by w.id) from wip_prebills w where w.org_id=${f.org.orgId}) as worksheets,
    (select jsonb_agg(to_jsonb(l) order by l.id) from wip_prebill_lines l where l.org_id=${f.org.orgId}) as source_snapshots,
    (select jsonb_agg(to_jsonb(t) order by t.id) from time_entries t where t.org_id=${f.org.orgId}) as time_sources,
    (select jsonb_agg(to_jsonb(r) order by r.id) from billing_requests r where r.org_id=${f.org.orgId}) as requests,
    (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${f.org.orgId}) as documents,
    (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l where l.org_id=${f.org.orgId}) as document_lines,
    (select jsonb_agg(to_jsonb(n) order by n.id) from number_sequences n where n.org_id=${f.org.orgId}) as numbers,
    (select jsonb_agg(to_jsonb(e) order by e.id) from wip_prebill_events e where e.org_id=${f.org.orgId}) as events,
    (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.org_id=${f.org.orgId}) as audit
  `)).rows[0]
}

async function refused(f: Fixture, message: RegExp) {
  const before = await snapshot(f)
  await assert.rejects(wip.convertPrebill(f.org.orgId, f.actor, f.prebill), (error: unknown) =>
    error instanceof wip.WipBillingError && message.test(error.message) && /void this prebill.*new prebill for approval/.test(error.message))
  assert.deepEqual(await snapshot(f), before, 'refusal preserves source, numbering, invoice, requests, and audit evidence')
}

async function convertedWith(f: Fixture, accountId: string) {
  const converted = await wip.convertPrebill(f.org.orgId, f.actor, f.prebill)
  assert.equal(converted.idempotent, false)
  const lines = (await db.execute(sql`select id, account_id, amount::text, time_entry_id from document_lines
    where org_id=${f.org.orgId} and document_id=${converted.id} order by line_number`)).rows
  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.account_id, accountId)
  assert.equal(lines[0]!.amount, '200.2500')
  assert.equal(lines[0]!.time_entry_id, f.entry)
  assert.deepEqual((await db.execute(sql`select billing_status, invoiced_by_line_id from time_entries
    where org_id=${f.org.orgId} and id=${f.entry}`)).rows[0], { billing_status: 'billed', invoiced_by_line_id: lines[0]!.id })
  const beforeRetry = await snapshot(f)
  assert.deepEqual(await wip.convertPrebill(f.org.orgId, f.actor, f.prebill), { id: converted.id, documentNumber: converted.documentNumber, idempotent: true })
  assert.deepEqual(await snapshot(f), beforeRetry)
}

test('WIP conversion refuses missing frozen account despite available chart revenue without writes', enabled, async () => fixture('missing', async (f) => {
  await refused(f, /line 1 has no configured income account/)
  await db.execute(sql`update items set income_account_id=${f.org.accounts.revenue} where org_id=${f.org.orgId} and id=${f.org.items.service}`)
  await wip.transitionPrebill(f.org.orgId, f.actor, f.prebill, 'void', 'Correct source accounting configuration')
  const replacement = await wip.createPrebill(f.org.orgId, f.actor, { projectId: f.project, periodEnd: f.org.date })
  await wip.transitionPrebill(f.org.orgId, f.actor, replacement.id, 'submit')
  await wip.transitionPrebill(f.org.orgId, f.approver, replacement.id, 'approve')
  await convertedWith({ ...f, prebill: replacement.id }, f.org.accounts.revenue)
}))

for (const kind of ['inactive', 'summary'] as const) {
  test(`WIP conversion refuses ${kind} frozen account without writes`, enabled, async () => fixture('revenue', async (f) => {
    if (kind === 'inactive') await db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)
    else await db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)
    await refused(f, /line 1 requires an active, non-summary account in this organization/)
  }))
}

test('WIP conversion refuses a foreign organization account snapshot without writes', enabled, async () => fixture('revenue', async (f) => {
  const other = await createScratchOrg()
  try {
    // Defer the existing FK inside this fixture transaction so the service's
    // independent tenant check is exercised before restoring the valid source.
    await withOrgTransaction(f.org.orgId, async () => {
      await db.execute(sql`set constraints wip_prebill_line_income_org_fk deferred`)
      await db.execute(sql`update wip_prebill_lines set income_account_id=${other.accounts.revenue} where org_id=${f.org.orgId} and prebill_id=${f.prebill}`)
      await refused(f, /line 1 requires an active, non-summary account in this organization/)
      await db.execute(sql`update wip_prebill_lines set income_account_id=${f.org.accounts.revenue} where org_id=${f.org.orgId} and prebill_id=${f.prebill}`)
    })
  } finally { await dropScratchOrg(other.orgId) }
}))

test('WIP conversion preserves approved account when source item policy changes and retries idempotently', enabled, async () => fixture('revenue', async (f) => {
  await db.execute(sql`update items set income_account_id=${f.org.accounts.recognized} where org_id=${f.org.orgId} and id=${f.org.items.service}`)
  await convertedWith(f, f.org.accounts.revenue)
}))

test('WIP conversion preserves explicit non-income account policy', enabled, async () => fixture('invAsset', async (f) => {
  await convertedWith(f, f.org.accounts.invAsset)
}))
