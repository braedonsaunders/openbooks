import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import pg from 'pg'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  return next(specifier, context)
} })
const { db, withBypassContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { BUILTIN_PROJECT_TYPES } = await import('@openbooks/schema')
const { createScratchOrg, createScratchUser, seedFlowActors, dropScratchOrg } = await import('@openbooks/engine/src/test-fixtures.ts')
const { generateInvoiceFromBillingRequest } = await import('./billing')
const { createBillingRequest } = await import('./billing-requests')
const { computeBillTotals, taxProfileMap } = await import('./bills')
const { submitAndReleaseIfUngated } = await import('@openbooks/engine/src/flows/submit.ts')
const { postDocument } = await import('@openbooks/engine/src/posting.ts')

type Org = Awaited<ReturnType<typeof createScratchOrg>>
type Fixture = { org: Org; actor: string; project: string }
const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
async function fixture(run: (f: Fixture) => Promise<void>) {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId
      const project = randomUUID()
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,projectRevenue}',to_jsonb(${org.accounts.recognized}::text)) where id=${org.orgId}`)
      await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
        values(${project},${org.orgId},${org.subsidiaryId},'ACCOUNTING','Accounting controls',${org.customerId},'active',true,'{}'::jsonb)`)
      await run({ org, actor, project })
    } finally { await dropScratchOrg(org.orgId) }
  })
}
async function request(f: Fixture, amount?: string) {
  return createBillingRequest(f.org.orgId, f.actor, { projectId: f.project, basis: amount === undefined ? 'date_range' : 'draw_amount', drawAmount: amount, cutoffDate: f.org.date, backupRequired: false })
}
async function configure(f: Fixture, profile: Record<string, unknown>) {
  await db.execute(sql`update projects set invoicing_profile=${JSON.stringify(profile)}::jsonb where org_id=${f.org.orgId} and id=${f.project}`)
}
async function capProject(f: Fixture, cap: string) {
  const tm = BUILTIN_PROJECT_TYPES.find(t => t.key === 'time_and_materials')!
  const type = randomUUID()
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${type},${f.org.orgId},'accounting_cap','Accounting cap','time_and_materials',${JSON.stringify({ ...tm.invoicingProfile, notToExceed: true })}::jsonb,${JSON.stringify(tm.backupProfile)}::jsonb)`)
  await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
    values(${f.org.orgId},${type},'2000-01-01',${JSON.stringify(tm.financialProfile)}::jsonb,'accounting concurrency fixture')`)
  await db.execute(sql`update projects set project_type_id=${type},contract_value=${cap} where org_id=${f.org.orgId} and id=${f.project}`)
}
async function source(f: Fixture, accountId: string | null, amount = '100', taxCodeId: string | null = null, reuseItem?: string, approve = true) {
  const item = reuseItem ?? randomUUID(), doc = randomUUID(), line = randomUUID()
  if (!reuseItem) await db.execute(sql`insert into items(id,org_id,kind,name,income_account_id,tax_code_id,is_active)
    values(${item},${f.org.orgId},'service',${'Service '+item},${accountId},${taxCodeId},true)`)
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,subsidiary_id,project_id,document_date,posting_date,currency,fx_rate,status,subtotal,tax_total,total)
    values(${doc},${f.org.orgId},'vendor_bill',${'COST-'+doc},${f.org.vendorId},${f.org.subsidiaryId},${f.project},${f.org.date},${f.org.date},'CAD',1,'draft',${amount},0,${amount})`)
  await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit_price,amount,is_billable)
    values(${line},${f.org.orgId},${doc},1,${item},${f.org.accounts.cogs},'Billable service',1,${amount},${amount},true)`)
  if (approve) await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${doc}`)
  return { item, doc, line }
}
async function snapshot(f: Fixture) {
  return (await db.execute(sql`select
    (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${f.org.orgId}) as documents,
    (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l where l.org_id=${f.org.orgId}) as lines,
    (select jsonb_agg(to_jsonb(r) order by r.id) from billing_requests r where r.org_id=${f.org.orgId}) as requests,
    (select jsonb_agg(to_jsonb(n) order by n.id) from number_sequences n where n.org_id=${f.org.orgId}) as numbers,
    (select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.org_id=${f.org.orgId}) as audit`)).rows[0]
}
async function accounts(f: Fixture, invoice: string) {
  return (await db.execute<{ account_id: string; amount: string }>(sql`select account_id,sum(amount)::text as amount from document_lines where org_id=${f.org.orgId} and document_id=${invoice} group by account_id order by account_id`)).rows
}

for (const mode of ['missing', 'inactive', 'summary', 'foreign', 'nonexistent'] as const) {
  test(`project billing refuses ${mode} explicit revenue mapping without consuming work or numbering`, enabled, async () => fixture(async f => {
    let account: string | null = f.org.accounts.recognized
    let foreign: Org | undefined
    try {
      if (mode === 'missing') account = null
      if (mode === 'nonexistent') account = randomUUID()
      if (mode === 'foreign') { foreign = await createScratchOrg(); account = foreign.accounts.revenue }
      if (mode === 'inactive') await db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${account}`)
      if (mode === 'summary') await db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${account}`)
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',(settings->'controlAccounts')-${'projectRevenue'}) where id=${f.org.orgId}`)
      if (account) await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,projectRevenue}',to_jsonb(${account}::text)) where id=${f.org.orgId}`)
      await source(f, null)
      const req = await request(f)
      const before = await snapshot(f)
      await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /account|revenue/i)
      assert.deepEqual(await snapshot(f), before)
    } finally { if (foreign) await dropScratchOrg(foreign.orgId) }
  }))
}
for (const policy of ['item_income', 'fixed', 'unbilled_receivable'] as const) {
  test(`project billing honors explicit ${policy} destination including non-income posting accounts`, enabled, async () => fixture(async f => {
    await configure(f, { revenueAccount: policy })
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,unbilledReceivable}',to_jsonb(${f.org.accounts.invAsset}::text)) where id=${f.org.orgId}`)
    await source(f, f.org.accounts.deferred)
    const inv = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
    const expected = policy === 'item_income' ? f.org.accounts.deferred : policy === 'fixed' ? f.org.accounts.recognized : f.org.accounts.invAsset
    assert.deepEqual(await accounts(f, inv.id), [{ account_id: expected, amount: '100.0000' }])
  }))
}
for (const invalid of ['inactive', 'summary'] as const) {
  test(`project billing refuses ${invalid} item destination rather than replacing it with the configured fallback`, enabled, async () => fixture(async f => {
    await source(f, f.org.accounts.revenue)
    if (invalid === 'inactive') await db.execute(sql`update accounts set is_active=false where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)
    else await db.execute(sql`update accounts set is_summary=true where org_id=${f.org.orgId} and id=${f.org.accounts.revenue}`)
    const req = await request(f)
    const before = await snapshot(f)
    await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /account/i)
    assert.deepEqual(await snapshot(f), before)
  }))
}
test('project item income needs no organization fallback when the item explicitly supplies a valid account', enabled, async () => fixture(async f => {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',(settings->'controlAccounts')-'projectRevenue') where id=${f.org.orgId}`)
  await source(f, f.org.accounts.revenue)
  const inv = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  assert.deepEqual(await accounts(f, inv.id), [{ account_id: f.org.accounts.revenue, amount: '100.0000' }])
}))
test('project draw uses configured project revenue instead of the first chart income account', enabled, async () => fixture(async f => {
  const inv = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f, '100')).id)
  assert.deepEqual(await accounts(f, inv.id), [{ account_id: f.org.accounts.recognized, amount: '100.0000' }])
}))
test('project unbilled-receivable policy refuses an absent control account before any writes', enabled, async () => fixture(async f => {
  await configure(f, { revenueAccount: 'unbilled_receivable' })
  await source(f, f.org.accounts.revenue)
  const req = await request(f)
  const before = await snapshot(f)
  await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /unbilled|account/i)
  assert.deepEqual(await snapshot(f), before)
}))
test('project grouped presentation retains item accounts and source-to-invoice lineage', enabled, async () => fixture(async f => {
  await configure(f, { rollup: { mode: 'by_group', groups: [{ label: 'Services', itemKinds: ['service'] }] } })
  const first = await source(f, f.org.accounts.revenue, '100')
  const second = await source(f, f.org.accounts.recognized, '200')
  const inv = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  const rows = (await db.execute<{ id: string; item_id: string; account_id: string; amount: string; source_id: string }>(sql`
    select l.id,l.item_id,l.account_id,l.amount::text,s.id as source_id from document_lines l
    join document_lines s on s.org_id=l.org_id and s.billed_by_line_id=l.id
    where l.org_id=${f.org.orgId} and l.document_id=${inv.id} order by s.id`)).rows
  const expected = [
    { item_id: first.item, account_id: f.org.accounts.revenue, amount: '100.0000', source_id: first.line },
    { item_id: second.item, account_id: f.org.accounts.recognized, amount: '200.0000', source_id: second.line },
  ].sort((a,b) => a.source_id.localeCompare(b.source_id))
  assert.deepEqual(rows.map(({ item_id, account_id, amount, source_id }) => ({ item_id, account_id, amount, source_id })), expected)
  assert.equal(new Set(rows.map(r => r.id)).size, 2)
}))
test('project billing computes tax within the net contract cap and posts its frozen component evidence', enabled, async () => fixture(async f => {
  await capProject(f, '100')
  const tax = randomUUID()
  await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active,collected_account_id,paid_account_id)
    values(${tax},${f.org.orgId},'PROJECT-5','Project tax 5%',true,${f.org.accounts.taxOutput},${f.org.accounts.taxInput})`)
  await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from) values(${f.org.orgId},${tax},'5','2026-01-01')`)
  await source(f, f.org.accounts.revenue, '100', tax)
  const expected = computeBillTotals([{ accountId: f.org.accounts.revenue, amount: '100', taxCodeId: tax }], await taxProfileMap(f.org.orgId, f.org.date))
  assert.equal(expected.taxTotal, '5.0000')
  const inv = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  const row = (await db.execute<{ subtotal: string; tax_total: string; total: string; tax_code_id: string; tax_amount: string }>(sql`
    select d.subtotal::text,d.tax_total::text,d.total::text,l.tax_code_id,l.tax_amount::text
    from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id
    where d.org_id=${f.org.orgId} and d.id=${inv.id}`)).rows[0]
  assert.deepEqual(row, { subtotal: '100.0000', tax_total: '5.0000', total: '105.0000', tax_code_id: tax, tax_amount: '5.0000' })
  const components = (await db.execute(sql`select c.tax_code_id,c.rate_percent::text,c.taxable_amount::text,c.tax_amount::text,c.collected_account_id
    from document_line_tax_components c join document_lines l on l.id=c.document_line_id and l.org_id=c.org_id
    where l.org_id=${f.org.orgId} and l.document_id=${inv.id}`)).rows
  assert.deepEqual(components, [{ tax_code_id: tax, rate_percent: '5.0000', taxable_amount: '100.0000', tax_amount: '5.0000', collected_account_id: f.org.accounts.taxOutput }])
  const approver = await createScratchUser(f.org.orgId, 'Project invoice poster', 'admin')
  assert.equal((await submitAndReleaseIfUngated('customer_invoice', inv.id, f.actor)).autoApproved, true)
  await postDocument(inv.id, { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } }, { audit: { actorId: approver, source: 'test' } })
  const ledger = (await db.execute<{ account_id: string; amount: string }>(sql`select l.account_id,sum(l.amount)::text as amount
    from journal_lines l join documents d on d.org_id=l.org_id and d.posted_entry_id=l.entry_id
    where d.org_id=${f.org.orgId} and d.id=${inv.id} group by l.account_id order by l.account_id`)).rows
  assert.deepEqual(ledger, [
    { account_id: f.org.accounts.ar, amount: '105.0000' },
    { account_id: f.org.accounts.revenue, amount: '-100.0000' },
    { account_id: f.org.accounts.taxOutput, amount: '-5.0000' },
  ].sort((a,b) => a.account_id.localeCompare(b.account_id)))
}))

for (const state of ['inactive', 'unrated', 'lapsed'] as const) {
  test(`project billing refuses ${state} tax instead of consuming work with zero tax`, enabled, async () => fixture(async f => {
    const tax = randomUUID()
    await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active,collected_account_id,paid_account_id)
      values(${tax},${f.org.orgId},'INVALID-PROJECT-TAX','Invalid project tax',${state !== 'inactive'},${f.org.accounts.taxOutput},${f.org.accounts.taxInput})`)
    if (state !== 'unrated') await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from,effective_to)
      values(${f.org.orgId},${tax},'5','2026-01-01',${state === 'lapsed' ? '2026-06-30' : null})`)
    await source(f, f.org.accounts.revenue, '100', tax)
    const req = await request(f)
    const before = await snapshot(f)
    await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /tax|effective rate/i)
    assert.deepEqual(await snapshot(f), before)
  }))
}

test('project billing refuses taxable over-cap work before consuming sources or numbering', enabled, async () => fixture(async f => {
  await capProject(f, '50')
  const tax = randomUUID()
  await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active,collected_account_id,paid_account_id)
    values(${tax},${f.org.orgId},'CAP-TAX','Taxable capped work',true,${f.org.accounts.taxOutput},${f.org.accounts.taxInput})`)
  await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from) values(${f.org.orgId},${tax},'5','2026-01-01')`)
  await source(f, f.org.accounts.revenue, '100', tax)
  const req = await request(f)
  const before = await snapshot(f)
  await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /tax|cap|not.to.exceed/i)
  assert.deepEqual(await snapshot(f), before)
}))

test('competing project billing requests serialize their not-to-exceed capacity claim', enabled, async () => fixture(async f => {
  await capProject(f, '100')
  const requests = [await request(f, '80'), await request(f, '80')]
  // Pause the first generator after its capacity read, at the actual document INSERT.
  // The second must wait on the project row, not reach INSERT with the same balance.
  const suffix = randomUUID().replaceAll('-', '')
  const fn = `billing_cap_${suffix}`, trigger = `billing_cap_${suffix}`
  const blocker = new pg.Client({ connectionString: process.env.OPENBOOKS_DB_URL })
  const gate = Math.floor(Math.random() * 1_000_000_000)
  const runs: Promise<unknown>[] = []
  let released = false
  await blocker.connect()
  try {
    await blocker.query('select pg_advisory_lock($1)', [gate])
    await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin if new.org_id = '${f.org.orgId}'::uuid and new.kind = 'customer_invoice' then perform pg_advisory_xact_lock(${gate}); end if; return new; end $$`))
    await db.execute(sql.raw(`create trigger ${trigger} before insert on documents for each row execute function ${fn}()`))
    for (const req of requests) runs.push(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id))
    const done = Promise.allSettled(runs)
    let waiting = 0
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const r = await blocker.query<{ count: string }>(`select count(*)::text as count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and (query ilike '%insert into documents%' or query ilike '%select br.%')`)
      waiting = Number(r.rows[0]!.count)
      if (waiting >= 2) break
      await delay(20)
    }
    assert.equal(waiting, 2, 'both real generators reached the coordinated lock boundary')
    await blocker.query('select pg_advisory_unlock($1)', [gate]); released = true
    const results = await done
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2, JSON.stringify(results))
    const totals = (await db.execute<{ total: string }>(sql`select total::text from documents where org_id=${f.org.orgId} and project_id=${f.project} and kind='customer_invoice' order by total`)).rows
    assert.deepEqual(totals, [{ total: '20.0000' }, { total: '80.0000' }])
  } finally {
    if (!released) await blocker.query('select pg_advisory_unlock($1)', [gate])
    await Promise.allSettled(runs)
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on documents`))
    await db.execute(sql.raw(`drop function if exists ${fn}()`))
    await blocker.end()
  }
}))


async function fivePercentTax(f: Fixture, inclusive = false) {
  const tax = randomUUID()
  await db.execute(sql`insert into tax_codes(id,org_id,code,name,is_active,collected_account_id,paid_account_id,price_includes_tax)
    values(${tax},${f.org.orgId},${'TAX-'+tax},'Five percent',true,${f.org.accounts.taxOutput},${f.org.accounts.taxInput},${inclusive})`)
  await db.execute(sql`insert into tax_rates(org_id,tax_code_id,rate_percent,effective_from) values(${f.org.orgId},${tax},5,'2026-01-01')`)
  return tax
}
async function totals(f: Fixture, invoice: string) {
  return (await db.execute(sql`select subtotal::text,tax_total::text,total::text from documents where org_id=${f.org.orgId} and id=${invoice}`)).rows[0]
}
for (const amount of ['105', '106.05']) {
  test(`tax-inclusive project charge ${amount} consumes its net value against a 100 cap`, enabled, async () => fixture(async f => {
    await capProject(f, '100')
    await source(f, f.org.accounts.revenue, amount, await fivePercentTax(f, true))
    const req = await request(f)
    if (amount === '105') {
      const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id)
      assert.deepEqual(await totals(f, invoice.id), { subtotal: '100.0000', tax_total: '5.0000', total: '105.0000' })
    } else {
      const before = await snapshot(f)
      await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /cap|not.to.exceed/i)
      assert.deepEqual(await snapshot(f), before)
    }
  }))
}

test('taxable lump-sum markup refuses atomically and embedded recovery taxes the full marked-up amount', enabled, async () => fixture(async f => {
  await configure(f, { markupPresentation: 'lump_sum' })
  await db.execute(sql`update projects set custom='{"markupPercent":"10"}'::jsonb where org_id=${f.org.orgId} and id=${f.project}`)
  await source(f, f.org.accounts.revenue, '100', await fivePercentTax(f))
  const req = await request(f)
  const before = await snapshot(f)
  await assert.rejects(generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id), /embedded|tax.*markup|markup.*tax/i)
  assert.deepEqual(await snapshot(f), before)
  await configure(f, { markupPresentation: 'embedded' })
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, req.id)
  assert.deepEqual(await totals(f, invoice.id), { subtotal: '110.0000', tax_total: '5.5000', total: '115.5000' })
}))

test('untaxed lump-sum markup preserves each source revenue account and department', enabled, async () => fixture(async f => {
  await configure(f, { markupPresentation: 'lump_sum' })
  await db.execute(sql`update projects set custom='{"markupPercent":"10"}'::jsonb where org_id=${f.org.orgId} and id=${f.project}`)
  const expected = []
  for (const account of [f.org.accounts.revenue, f.org.accounts.deferred]) {
    const department = randomUUID()
    await db.execute(sql`insert into departments(id,org_id,name) values(${department},${f.org.orgId},${department})`)
    const charge = await source(f, account, '100', null, undefined, false)
    await db.execute(sql`update document_lines set department_id=${department} where id=${charge.line} and org_id=${f.org.orgId}`)
    await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${charge.doc}`)
    expected.push({ account_id: account, department_id: department, amount: '110.0000' })
  }
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  const actual = (await db.execute(sql`select account_id,department_id,sum(amount)::text as amount from document_lines
    where org_id=${f.org.orgId} and document_id=${invoice.id} group by account_id,department_id order by account_id`)).rows
  assert.deepEqual(actual, expected.sort((a,b) => a.account_id.localeCompare(b.account_id)))
}))

for (const grouping of ['per_source_line', 'per_item'] as const) {
  test(`${grouping} presentation preserves independently rounded half-cent source charges`, enabled, async () => fixture(async f => {
    await configure(f, { lineGrouping: grouping })
    const first = await source(f, f.org.accounts.revenue, '0.005')
    const second = await source(f, f.org.accounts.revenue, '0.005', null, first.item)
    const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
    assert.deepEqual(await totals(f, invoice.id), { subtotal: '0.0200', tax_total: '0.0000', total: '0.0200' })
    const linked = (await db.execute(sql`select count(*)::text as count from document_lines s join document_lines i
      on i.org_id=s.org_id and i.id=s.billed_by_line_id where s.org_id=${f.org.orgId} and i.document_id=${invoice.id}
      and s.id in (${first.line},${second.line})`)).rows[0]
    assert.deepEqual(linked, { count: '2' })
  }))
}

test('per-item grouping retains eight-decimal project-charge quantities', enabled, async () => fixture(async f => {
  await configure(f, { lineGrouping: 'per_item' })
  const first = await source(f, f.org.accounts.revenue, '1', null, undefined, false)
  const second = await source(f, f.org.accounts.revenue, '1', null, first.item, false)
  for (const charge of [first, second]) {
    await db.execute(sql`update documents set kind='project_charge' where id=${charge.doc} and org_id=${f.org.orgId}`)
    await db.execute(sql`update document_lines set quantity='0.12345678',bill_rate='8.10',bill_amount='1' where id=${charge.line} and org_id=${f.org.orgId}`)
    await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${charge.doc}`)
  }
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  const lines = (await db.execute(sql`select quantity::text,amount::text from document_lines where org_id=${f.org.orgId} and document_id=${invoice.id}`)).rows
  assert.deepEqual(lines, [{ quantity: '0.24691356', amount: '2.0000' }])
}))

for (const dimension of ['department', 'unit', 'equipment', 'rate_version'] as const) {
  test(`per-item grouping preserves distinct ${dimension} source evidence`, enabled, async () => fixture(async f => {
    await configure(f, { lineGrouping: 'per_item' })
    const first = await source(f, f.org.accounts.revenue, '100', null, undefined, false)
    const second = await source(f, f.org.accounts.revenue, '100', null, first.item, false)
    const expected = []
    for (const charge of [first, second]) {
      const value = dimension === 'unit' ? 'Unit '+charge.line : randomUUID()
      if (dimension === 'department') {
        await db.execute(sql`insert into departments(id,org_id,name) values(${value},${f.org.orgId},${value})`)
        await db.execute(sql`update document_lines set department_id=${value} where org_id=${f.org.orgId} and id=${charge.line}`)
      } else if (dimension === 'unit') {
        await db.execute(sql`update document_lines set unit=${value} where org_id=${f.org.orgId} and id=${charge.line}`)
      } else if (dimension === 'equipment') {
        await db.execute(sql`insert into equipment_units(id,org_id,subsidiary_id,unit_number,name) values(${value},${f.org.orgId},${f.org.subsidiaryId},${value},${value})`)
        await db.execute(sql`update document_lines set equipment_unit_id=${value} where org_id=${f.org.orgId} and id=${charge.line}`)
      } else {
        const book = randomUUID()
        await db.execute(sql`insert into item_rate_books(id,org_id,code,name,currency) values(${book},${f.org.orgId},${book},${book},'CAD')`)
        await db.execute(sql`insert into item_rate_versions(id,org_id,rate_book_id,effective_from) values(${value},${f.org.orgId},${book},'2026-01-01')`)
        await db.execute(sql`update document_lines set rate_version_id=${value} where org_id=${f.org.orgId} and id=${charge.line}`)
      }
      await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${charge.doc}`)
      expected.push({ source_id: charge.line, value })
    }
    const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
    const rows = (await db.execute<{ id: string; source_id: string; department_id: string | null; unit: string | null; equipment_unit_id: string | null; rate_version_id: string | null }>(sql`
      select i.id,s.id as source_id,i.department_id,i.unit,i.equipment_unit_id,i.rate_version_id from document_lines i
      join document_lines s on s.org_id=i.org_id and s.billed_by_line_id=i.id
      where i.org_id=${f.org.orgId} and i.document_id=${invoice.id} order by s.id`)).rows
    const column = dimension === 'department' ? 'department_id' : dimension === 'equipment' ? 'equipment_unit_id' : dimension === 'rate_version' ? 'rate_version_id' : 'unit'
    assert.deepEqual(rows.map(r => ({ source_id: r.source_id, value: r[column] })), expected.sort((a,b) => a.source_id.localeCompare(b.source_id)))
    assert.equal(new Set(rows.map(r => r.id)).size, 2)
  }))
}


test('per-item presentation prices each department under its own negotiated surcharge', enabled, async () => fixture(async f => {
  await configure(f, { lineGrouping: 'per_item' })
  const first = await source(f, f.org.accounts.revenue, '100', null, undefined, false)
  const second = await source(f, f.org.accounts.revenue, '100', null, first.item, false)
  const surchargeItem = randomUUID()
  await db.execute(sql`insert into items(id,org_id,kind,name,income_account_id,is_active)
    values(${surchargeItem},${f.org.orgId},'service','Department surcharge',${f.org.accounts.recognized},true)`)
  for (const [index, charge] of [first, second].entries()) {
    const department = randomUUID(), book = randomUUID(), version = randomUUID(), adjustment = randomUUID()
    await db.execute(sql`insert into departments(id,org_id,name) values(${department},${f.org.orgId},${department})`)
    await db.execute(sql`update document_lines set department_id=${department} where org_id=${f.org.orgId} and id=${charge.line}`)
    await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${charge.doc}`)
    await db.execute(sql`insert into item_rate_books(id,org_id,code,name,currency) values(${book},${f.org.orgId},${book},${book},'CAD')`)
    await db.execute(sql`insert into item_rate_versions(id,org_id,rate_book_id,effective_from,status) values(${version},${f.org.orgId},${book},'2026-01-01','draft')`)
    await db.execute(sql`insert into item_rate_book_assignments(org_id,rate_book_id,project_id,department_id,effective_from)
      values(${f.org.orgId},${book},${f.project},${department},'2026-01-01')`)
    await db.execute(sql`insert into labor_rate_adjustments(id,org_id,version_id,code,name,category,calculation,value,presentation,item_id)
      values(${adjustment},${f.org.orgId},${version},'DEPT','Department surcharge','surcharge','percent',${index === 0 ? '10' : '20'},'separate',${surchargeItem})`)
    await db.execute(sql`insert into labor_rate_adjustment_targets(org_id,adjustment_id,target_type,target_value_id)
      values(${f.org.orgId},${adjustment},'department',${department})`)
    await db.execute(sql`update item_rate_versions set status='active' where org_id=${f.org.orgId} and id=${version}`)
  }
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  assert.deepEqual(await totals(f, invoice.id), { subtotal: '230.0000', tax_total: '0.0000', total: '230.0000' })
  const surcharges = (await db.execute(sql`select amount::text from document_lines where org_id=${f.org.orgId}
    and document_id=${invoice.id} and item_id=${surchargeItem} order by amount`)).rows
  assert.deepEqual(surcharges, [{ amount: '10.0000' }, { amount: '20.0000' }])
}))


test('project-charge component billing preserves large exact decimals through JSON aggregation', enabled, async () => fixture(async f => {
  const amount = '123456789012345.1250'
  const charge = await source(f, f.org.accounts.revenue, amount, null, undefined, false)
  await db.execute(sql`update documents set kind='project_charge' where org_id=${f.org.orgId} and id=${charge.doc}`)
  await db.execute(sql`update document_lines set rate_presentation='rate_components',bill_amount=${amount},bill_rate=${amount}
    where org_id=${f.org.orgId} and id=${charge.line}`)
  await db.execute(sql`insert into charge_rate_components(org_id,document_line_id,role,unit_code,unit_name,quantity,rate,amount,sequence)
    values(${f.org.orgId},${charge.line},'bill','each','Each',1,${amount},${amount},1)`)
  await db.execute(sql`update documents set status='approved' where org_id=${f.org.orgId} and id=${charge.doc}`)
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, (await request(f)).id)
  assert.deepEqual(await totals(f, invoice.id), { subtotal: '123456789012345.1300', tax_total: '0.0000', total: '123456789012345.1300' })
  const rows = (await db.execute(sql`select quantity::text,amount::text from document_lines where org_id=${f.org.orgId} and document_id=${invoice.id}`)).rows
  assert.deepEqual(rows, [{ quantity: '1.00000000', amount: '123456789012345.1300' }])
}))
