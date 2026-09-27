import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const { db, withBypassContext, withOrgContext } = (await import(root + 'engine/src/platform/db.ts')) as typeof import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import(root + 'node_modules/drizzle-orm/index.js')
const { createScratchOrg, dropScratchOrg } = (await import(root + 'engine/src/testing/fixtures.ts')) as typeof import('@openbooks/engine/src/testing/fixtures.ts')
const { recomputeSaasMetrics } = await import(root + 'engine/src/billing/metrics/metrics-ledger.ts')
const { BUILT_IN_REPORT_DEFINITIONS, BUILT_IN_REPORT_DEFINITION_MAP } = (await import(root + 'packages/reports/src/built-ins.ts')) as typeof import('@openbooks/reports')

type Org = Awaited<ReturnType<typeof createScratchOrg>>
type Group = { columns: string[]; rows: (string | number | null | undefined)[][]; undefinedCells?: (string | null)[][] }
type Result = { groups: Group[] }
type Authz = { user: { id: string; email: string; name: string; roles: { key: string; name: string }[]; orgId: string; envKind: 'production'; productionOrgId: string; homeUserId: string; homeOrgId: string; isSuperAdmin: false }; permissions: Set<string>; allowedSubsidiaryIds: Set<string> | null }
type FuturePeriod = { starts_on: string; ends_on: string; fiscal_year: number; period_number: number; fiscal_calendar_id: string }

async function seedSubscription(org: Org, actor: string, customer: string, amount: string): Promise<string> {
  const plan = randomUUID(), subscription = randomUUID()
  const p = await db.execute<{ id: string }>(sql`insert into subscription_plans (id,org_id,name,amount,currency_code,interval,interval_count,created_by) values (${plan},${org.orgId},${`Metrics plan ${plan.slice(0,8)}`},${amount},'CAD','monthly',1,${actor}) returning id`)
  assert.equal(p.rows.length, 1)
  const s = await db.execute<{ id: string }>(sql`insert into subscriptions (id,org_id,customer_id,plan_id,quantity,price_override,status,start_on,next_bill_on,auto_post,created_by) values (${subscription},${org.orgId},${customer},${plan},'1',${amount},'active','2026-03-01','2026-08-15',false,${actor}) returning id`)
  assert.equal(s.rows.length, 1)
  return subscription
}

async function postEntry(org: Org, subsidiary: string, number: string, lines: { account: string; amount: string }[]): Promise<void> {
  const id = randomUUID()
  await db.execute(sql`insert into journal_entries (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin) values (${id},${org.orgId},${org.bookId},${subsidiary},${number},'2026-07-15',${org.periodId},${number},'draft','manual')`)
  const values = lines.map((line, i) => sql`(${org.orgId},${id},${i + 1},${line.account},${subsidiary},${line.amount},'CAD',${line.amount},'1')`)
  const inserted = await db.execute<{ entry_id: string }>(sql`insert into journal_lines (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate) values ${values.reduce((a, v, i) => i ? sql`${a},${v}` : v)} returning entry_id`)
  assert.equal(inserted.rows.length, lines.length)
  const posted = await db.execute<{ id: string }>(sql`update journal_entries set status='posted',posted_at=now() where id=${id} returning id`)
  assert.equal(posted.rows.length, 1)
}

test('SaaS metrics built-ins execute consolidated formulas with feature and subsidiary gates', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg(), actor = randomUUID(), child = randomUUID(), customer = randomUUID()
  try {
    let subscription = ''
    await withBypassContext(async () => {
      const enabled = await db.execute<{ id: string }>(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true,"saasMetrics":true}'::jsonb) where id=${org.orgId} returning id`)
      assert.equal(enabled.rows.length, 1)
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country) values (${child},${org.orgId},${org.subsidiaryId},'Metrics Entity Two','CAD','CA')`)
      await db.execute(sql`insert into parties (id,org_id,kind,display_name,subsidiary_id) values (${customer},${org.orgId},'company','Metrics Customer Two',${child})`)
      subscription = await seedSubscription(org,actor,org.customerId,'100')
      await seedSubscription(org,actor,customer,'300')
      const cogs = randomUUID()
      await db.execute(sql`insert into accounts (id,org_id,number,name,type) values (${cogs},${org.orgId},'5988','Metrics cost of goods sold','cogs')`)
      await postEntry(org,org.subsidiaryId,'METRICS-ONE',[{account:org.accounts.revenue,amount:'-1000'},{account:cogs,amount:'100'},{account:org.accounts.bank,amount:'900'}])
      await postEntry(org,child,'METRICS-TWO',[{account:org.accounts.revenue,amount:'-200'},{account:cogs,amount:'100'},{account:org.accounts.bank,amount:'100'}])
      const period = await db.execute<FuturePeriod>(sql`select (date_trunc('month',current_date)+interval '1 month')::date::text starts_on,(date_trunc('month',current_date)+interval '2 months - 1 day')::date::text ends_on,extract(year from date_trunc('month',current_date)+interval '1 month')::int fiscal_year,extract(month from date_trunc('month',current_date)+interval '1 month')::int period_number,fiscal_calendar_id from accounting_periods where id=${org.periodId}`)
      assert.equal(period.rows.length,1)
      const future = period.rows[0]!, contract=randomUUID(), obligation=randomUUID(), schedule=randomUUID()
      await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,fiscal_calendar_id) values (${randomUUID()},${org.orgId},${future.fiscal_year},${future.period_number},${future.starts_on.slice(0,7)},${future.starts_on},${future.ends_on},${future.fiscal_calendar_id})`)
      await db.execute(sql`insert into revenue_contracts (id,org_id,customer_id,subsidiary_id,contract_number,status,starts_on,total_transaction_price,currency) values (${contract},${org.orgId},${org.customerId},${org.subsidiaryId},'METRICS-RUNOFF','active',${future.starts_on},'125','CAD')`)
      await db.execute(sql`insert into performance_obligations (id,org_id,contract_id,description,recognition_rule_id,allocated_price,recognition_starts_on,deferred_account_id,recognized_account_id,status) values (${obligation},${org.orgId},${contract},'Future service',${org.recognitionRuleId},'125',${future.starts_on},${org.accounts.deferred},${org.accounts.recognized},'open')`)
      await db.execute(sql`insert into recognition_schedules (id,org_id,obligation_id,book_id,status,total_amount,transaction_currency,transaction_fx_rate) values (${schedule},${org.orgId},${obligation},${org.bookId},'planned','125','CAD','1')`)
      await db.execute(sql`insert into recognition_schedule_lines (id,org_id,schedule_id,period_id,sequence,planned_amount) select ${randomUUID()},${org.orgId},${schedule},id,1,'125' from accounting_periods where org_id=${org.orgId} and starts_on=${future.starts_on}`)
    })
    for (const month of ['2026-03-01','2026-04-01','2026-05-01','2026-06-01']) await recomputeSaasMetrics(org.orgId,month)
    await withBypassContext(async () => {
      const changed = await db.execute<{ id: string }>(sql`update subscriptions set price_override='150' where id=${subscription} returning id`)
      assert.equal(changed.rows.length,1)
    })
    await recomputeSaasMetrics(org.orgId,'2026-07-01')
    const { executeReport } = await import('./custom-reports.ts')
    const { withReportAuthz } = await import('./report-execution-context.ts')
    const { hiddenReportEntityKeys, canRunReportEntity } = await import('./report-authz.ts')
    const principal = (scope: Set<string> | null): Authz => ({ user: { id:actor,email:'metrics@example.test',name:'Metrics Reader',roles:[],orgId:org.orgId,envKind:'production',productionOrgId:org.orgId,homeUserId:actor,homeOrgId:org.orgId,isSuperAdmin:false },permissions:new Set(['reports.read','usage.read']),allowedSubsidiaryIds:scope })
    const run = (slug: string, authz=principal(null), query=BUILT_IN_REPORT_DEFINITION_MAP[slug]!.query): Promise<Result> => withOrgContext(org.orgId,()=>withReportAuthz(authz,()=>executeReport(org.orgId,query,undefined,{})))
    const results = new Map<string,Result>()
    for (const definition of BUILT_IN_REPORT_DEFINITIONS.filter((item)=>['mrr-movements','arr-summary','revenue-churn','nrr-grr','cohort-retention','arpa-ltv','gross-margin','deferred-waterfall','bookings-billings-revenue'].includes(item.slug))) {
      const result=await run(definition.slug); assert.ok(result.groups.some((group)=>group.rows.length),`${definition.slug} should return a result row`); results.set(definition.slug,result)
    }
    const cell=(slug:string,label:string,match='2026-07'):string=>{const result=results.get(slug)!,group=result.groups.find((g)=>g.columns.includes(label));assert.ok(group,`${slug} column ${label} exists in ${JSON.stringify(result.groups)}`);const col=group.columns.indexOf(label);const row=group.rows.find((r)=>match===''||String(r[0]).includes(match));assert.ok(row,`${slug} row ${match} exists`);return String(row[col])}
    assert.equal(cell('mrr-movements','Expansion MRR'),'50.0000'); assert.equal(cell('mrr-movements','Opening MRR'),'400.0000'); assert.equal(cell('mrr-movements','Closing MRR'),'450.0000'); assert.equal(cell('mrr-movements','Quick ratio'),'No contraction or churn in the period')
    assert.equal(cell('arr-summary','Annual recurring revenue'),'5400.0000'); assert.equal(cell('revenue-churn','Revenue churn'),'0.00%'); assert.equal(cell('revenue-churn','Logo churn'),'0.00%')
    assert.equal(cell('nrr-grr','Net revenue retention'),'112.50%'); assert.equal(cell('nrr-grr','Gross revenue retention'),'100.00%')
    const quarter=await run('nrr-grr',principal(null),{...BUILT_IN_REPORT_DEFINITION_MAP['nrr-grr']!.query,breakouts:[{column:'month',bin:'quarter'}]})
    assert.ok(quarter.groups[0]!.rows.some((row)=>row.includes('112.50%')),'quarter NRR uses opening and closing stocks')
    const cohort=results.get('cohort-retention')!.groups[0]!, cohortRow=cohort.rows.find((row)=>String(row[0]).includes('2026-03')&&String(row[1])==='4')!
    assert.equal(cohortRow[cohort.columns.indexOf('MRR retention')],'112.50%'); assert.equal(cohortRow[cohort.columns.indexOf('Customer retention')],'100.00%')
    assert.equal(cell('arpa-ltv','Average revenue per account',''),'225.0000')
    assert.equal(cell('gross-margin','Gross margin'),'83.33%'); assert.notEqual('83.33%',((90+50)/2).toFixed(2)+'%','consolidated margin is calculated from summed revenue and costs')
    assert.equal(cell('deferred-waterfall','Planned recognition',''),'125.0000')
    assert.equal(cell('bookings-billings-revenue','Bookings'),'600.0000'); assert.equal(cell('bookings-billings-revenue','Billings'),'0.0000'); assert.equal(cell('bookings-billings-revenue','Recognised revenue'),'0.0000')
    const restricted=await run('mrr-movements',principal(new Set([org.subsidiaryId])))
    assert.ok(restricted.groups[0]!.rows.some((row)=>row.includes('150.0000')),'restricted reader sees its legal entity only')
    await withBypassContext(async()=>{const off=await db.execute<{id:string}>(sql`update orgs set settings=jsonb_set(settings,'{features}',settings->'features'||'{"saasMetrics":false}'::jsonb) where id=${org.orgId} returning id`);assert.equal(off.rows.length,1)})
    await withOrgContext(org.orgId,async()=>{const authz=principal(null);assert.ok((await hiddenReportEntityKeys(authz)).includes('saas_metrics_facts'));assert.equal(await canRunReportEntity(authz,BUILT_IN_REPORT_DEFINITION_MAP['mrr-movements']!.query),false)})
    await assert.rejects(run('mrr-movements'),/Report access denied|saasMetrics feature is disabled/)
    assert.equal(cell('arpa-ltv','Lifetime value',''),'No revenue churn in the period')
  } finally { await dropScratchOrg(org.orgId) }
})
