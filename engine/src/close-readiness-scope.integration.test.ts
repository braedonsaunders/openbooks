import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { finalizeCloseFlowApproval, refreshCloseRun, startCloseRun } from "./close.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

const enabled = !!process.env.OPENBOOKS_DB_URL;

async function setup() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  const other = randomUUID();
  await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
    values (${other}, ${org.orgId}, ${org.subsidiaryId}, 'Other entity', 'USD', 'US')`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings, '{features}',
    coalesce(settings->'features','{}') || '{"multiCurrency":true,"multiSubsidiary":true,"fixedAssets":true,"advancedClose":true,"flows":true}'::jsonb)
    where id=${org.orgId}`);
  return { org, actor, other };
}

async function journal(org: ScratchOrg, actor: string, subsidiaryId: string,
  amount: string, currency = 'CAD', posted = true) {
  const id = randomUUID();
  await db.transaction(async tx => {
    await tx.execute(sql`insert into journal_entries
      (id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values (${id},${org.orgId},${org.bookId},${subsidiaryId},${id},${org.date},${org.periodId},'draft','manual')`);
    await tx.execute(sql`insert into journal_lines
      (org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate)
      values (${org.orgId},${id},1,${org.accounts.cogs},${subsidiaryId},${amount},${currency},${amount},1),
        (${org.orgId},${id},2,${org.accounts.revenue},${subsidiaryId},-${amount}::numeric,${currency},-${amount}::numeric,1)`);
    if (posted) await tx.execute(sql`update journal_entries set status='posted',posted_at=now(),posted_by=${actor} where id=${id}`);
  });
  return id;
}

async function counts(orgId: string, runId: string) {
  await refreshCloseRun(orgId, runId);
  return Object.fromEntries((await db.execute<{ code: string; n: number }>(sql`
    select code,(details->>'count')::int as n from close_exceptions
    where org_id=${orgId} and run_id=${runId} and status='open'`)).rows.map(r => [r.code,r.n]));
}

async function run(org: ScratchOrg, actor: string, subsidiaryIds?: string[]) {
  return startCloseRun({orgId:org.orgId, periodId:org.periodId, bookId:org.bookId, actorId:actor, subsidiaryIds});
}

test('scoped close ignores another entity drafts and assets but retains its own blockers', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const foreignDraft = await journal(org,actor,other,'10','USD',false);
    await db.execute(sql`update journal_entries set subsidiary_id=${org.subsidiaryId} where id=${foreignDraft}`);
    const doc = randomUUID();
    await db.execute(sql`insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total)
      values (${doc},${org.orgId},${other},'vendor_bill','draft',${doc},${org.date},'USD',10,0,10)`);
    const category=randomUUID(), asset=randomUUID(), schedule=randomUUID();
    await db.execute(sql`insert into asset_categories (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
      values (${category},${org.orgId},'Readiness asset',${org.accounts.bank},${org.accounts.clearing},${org.accounts.cogs})`);
    await db.execute(sql`insert into fixed_assets (id,org_id,subsidiary_id,category_id,asset_number,name,acquisition_cost)
      values (${asset},${org.orgId},${other},${category},${asset},'Foreign asset',100)`);
    await db.execute(sql`insert into depreciation_schedules (id,org_id,asset_id,book_id,method)
      values (${schedule},${org.orgId},${asset},${org.bookId},'straight_line')`);
    await db.execute(sql`insert into depreciation_schedule_lines (org_id,schedule_id,period_id,sequence,planned_amount)
      values (${org.orgId},${schedule},${org.periodId},1,10)`);
    const runId=await run(org,actor,[org.subsidiaryId]);
    let got=await counts(org.orgId,runId);
    assert.equal(got['drafts-open']??0,0);
    assert.equal(got['posting-period-missing']??0,0);
    assert.equal(got['depreciation-unposted']??0,0);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[other]})}::jsonb where id=${runId}`);
    got=await counts(org.orgId,runId);
    assert.equal(got['drafts-open'],1);
    assert.equal(got['posting-period-missing'],1);
    assert.equal(got['depreciation-unposted'],1);
  } finally {await dropScratchOrg(org.orgId);}
});

test('close FX checks use entity functional currency and accept inverse spot quotes', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    await journal(org,actor,other,'10','USD');
    await journal(org,actor,org.subsidiaryId,'10','USD');
    await db.execute(sql`insert into fx_rates (org_id,from_currency,to_currency,rate_type,as_of,rate)
      values (${org.orgId},'CAD','USD','spot',${org.date},1)`);
    const runId=await run(org,actor);
    assert.equal((await counts(org.orgId,runId))['fx-missing']??0,0);
    await db.execute(sql`delete from fx_rates where org_id=${org.orgId}`);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[other]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['fx-missing']??0,0,'USD entity needs no USD/CAD quote');
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[org.subsidiaryId]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['fx-missing'],1,'CAD entity foreign activity still requires a quote');
  } finally {await dropScratchOrg(org.orgId);}
});

test('material variances cannot cancel between entities with unlike functional currencies', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    await journal(org,actor,org.subsidiaryId,'12000');
    await journal(org,actor,other,'-12000','USD');
    const runId=await run(org,actor);
    assert.equal((await counts(org.orgId,runId))['material-variances'],4);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[org.subsidiaryId]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['material-variances'],2);
  } finally {await dropScratchOrg(org.orgId);}
});

test('scoped bank readiness respects bank ownership and conservatively includes shared statements', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const bank=randomUUID(), statement=randomUUID();
    await db.execute(sql`insert into accounts (id,org_id,name,type,reconcilable,currency_restriction,subsidiary_id,subsidiary_include_children)
      values (${bank},${org.orgId},'Foreign bank','asset_bank',true,'USD',${other},false)`);
    await db.execute(sql`insert into bank_statements (id,org_id,account_id,source,statement_date,raw_file_ref)
      values (${statement},${org.orgId},${bank},'manual',${org.date},'test-evidence')`);
    await db.execute(sql`insert into bank_statement_lines (org_id,statement_id,account_id,line_number,posted_on,amount,currency)
      values (${org.orgId},${statement},${bank},1,${org.date},10,'USD')`);
    const runId=await run(org,actor,[org.subsidiaryId]);
    assert.equal((await counts(org.orgId,runId))['bank-unreconciled']??0,0);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[other]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['bank-unreconciled'],1);
    await db.execute(sql`update accounts set subsidiary_id=null where id=${bank}`);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[org.subsidiaryId]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['bank-unreconciled'],1,'shared statement must not disappear through guessed ownership');
  } finally {await dropScratchOrg(org.orgId);}
});

test('standard entity close does not certify group consolidation and old tasks are explicitly waived once', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    await db.execute(sql`update accounts set eliminate=true where id=${org.accounts.cogs}`);
    await journal(org,actor,org.subsidiaryId,'10');
    const runId=await run(org,actor);
    assert.equal((await counts(org.orgId,runId))['intercompany-residual'],1);
    await db.execute(sql`update close_runs set scope=${JSON.stringify({subsidiaryIds:[other]})}::jsonb where id=${runId}`);
    assert.equal((await counts(org.orgId,runId))['intercompany-residual']??0,0);
    const tasks=(await db.execute<{status:string;reason:string}>(sql`select status,result->>'reason' as reason from close_run_tasks
      where run_id=${runId} and key in ('intercompany-balanced','consolidation')`)).rows;
    assert.equal(tasks.length,2);
    for (const task of tasks) assert.deepEqual(task,{status:'waived',reason:'group-consolidation-not-applicable-to-entity-close'});
    await counts(org.orgId,runId);
    const events=(await db.execute<{payload:{before:Record<string,unknown>[]}}>(sql`select payload from close_events
      where run_id=${runId} and event_type='tasks.scope_not_applicable'`)).rows;
    assert.equal(events.length,1);
    assert.equal(events[0]!.payload.before.length,2);
    assert.ok('completed_at' in events[0]!.payload.before[0]!);
  } finally {await dropScratchOrg(org.orgId);}
});

test('new standard scoped run omits group tasks while custom configured group checks retain full population', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    await db.execute(sql`update accounts set eliminate=true where id=${org.accounts.cogs}`);
    await journal(org,actor,org.subsidiaryId,'10');
    const runId=await run(org,actor,[other]);
    assert.equal((await db.execute(sql`select id from close_run_tasks where run_id=${runId}
      and key in ('intercompany-balanced','consolidation')`)).rows.length,0);
    // A tenant-customized blueprint can deliberately retain a group assertion.
    await db.execute(sql`update close_blueprints set name='Explicit group contract' where id=(select blueprint_id from close_runs where id=${runId})`);
    await db.execute(sql`insert into close_run_tasks
      (org_id,run_id,key,title,workstream,task_type,completion_mode,gate_type,status)
      values (${org.orgId},${runId},'intercompany-balanced','Group control','intercompany','check','computed','hard','ready')`);
    assert.equal((await counts(org.orgId,runId))['intercompany-residual'],1);
    assert.notEqual((await db.execute<{status:string}>(sql`select status from close_run_tasks where run_id=${runId} and key='intercompany-balanced'`)).rows[0]!.status,'waived');
  } finally {await dropScratchOrg(org.orgId);}
});

test('variance comparison uses the current period fiscal calendar', {skip:!enabled}, async () => {
  const {org,actor}=await setup();
  try {
    const calendar=(await db.execute<{id:string}>(sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`)).rows[0]!.id;
    const prior=randomUUID(), otherCalendar=randomUUID();
    await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${prior},${org.orgId},${calendar},2026,6,'Prior fiscal period','2026-06-01','2026-06-28')`);
    await db.execute(sql`insert into fiscal_calendars (id,org_id,name) values (${otherCalendar},${org.orgId},'Other calendar')`);
    await db.execute(sql`insert into accounting_periods (org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${org.orgId},${otherCalendar},2026,6,'Other calendar prior','2026-06-29','2026-06-30')`);
    await journal({...org,periodId:prior,date:'2026-06-15'},actor,org.subsidiaryId,'12000');
    await journal(org,actor,org.subsidiaryId,'12000');
    const runId=await run(org,actor);
    assert.equal((await counts(org.orgId,runId))['material-variances']??0,0);
  } finally {await dropScratchOrg(org.orgId);}
});

test('scoped close evidence ignores unrelated entity posting and invalidates when its own entity changes', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const runId=await run(org,actor,[org.subsidiaryId]);
    const first=await refreshCloseRun(org.orgId,runId,actor);
    await db.execute(sql`update close_run_tasks set status='complete',data_fingerprint=${first.fingerprint},completed_at=now(),completed_by=${actor}
      where run_id=${runId} and key='variance-review'`);
    await db.execute(sql`update close_runs set status='approved',approved_at=now(),approved_by=${actor} where id=${runId}`);
    await journal(org,actor,other,'15','USD');
    const unrelated=await refreshCloseRun(org.orgId,runId,actor);
    assert.equal(unrelated.fingerprint,first.fingerprint);
    assert.equal(unrelated.invalidated,0);
    assert.equal((await db.execute<{status:string}>(sql`select status from close_runs where id=${runId}`)).rows[0]!.status,'approved');
    await journal(org,actor,org.subsidiaryId,'15');
    const changed=await refreshCloseRun(org.orgId,runId,actor);
    assert.notEqual(changed.fingerprint,first.fingerprint);
    assert.ok(changed.invalidated>0);
    assert.deepEqual((await db.execute(sql`select status,approved_at,approved_by from close_runs where id=${runId}`)).rows[0],
      {status:'in_progress',approved_at:null,approved_by:null});
  } finally {await dropScratchOrg(org.orgId);}
});

test('close resumption preserves captured scope and blueprint and rejects explicit conflicting requests', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const runId=await run(org,actor,[org.subsidiaryId]);
    await db.execute(sql`update close_runs set status='approved',approved_at=now(),approved_by=${actor} where id=${runId}`);
    const before=(await db.execute(sql`select scope,blueprint_id,status,approved_at,approved_by from close_runs where id=${runId}`)).rows[0];
    const tasks=(await db.execute(sql`select id,owner_id,reviewer_id from close_run_tasks where run_id=${runId} order by id`)).rows;
    assert.equal(await run(org,actor),runId,'omitted scope resumes the captured scope');
    for (const subsidiaryIds of [[other],[],null]) {
      await assert.rejects(startCloseRun({orgId:org.orgId,periodId:org.periodId,bookId:org.bookId,actorId:actor,subsidiaryIds}),/different subsidiary scope/);
    }
    const custom=randomUUID();
    await db.execute(sql`insert into close_blueprints (id,org_id,name,is_active) values (${custom},${org.orgId},'Different template',true)`);
    await assert.rejects(startCloseRun({orgId:org.orgId,periodId:org.periodId,bookId:org.bookId,actorId:actor,blueprintId:custom}),/different blueprint/);
    assert.deepEqual((await db.execute(sql`select scope,blueprint_id,status,approved_at,approved_by from close_runs where id=${runId}`)).rows[0],before);
    assert.deepEqual((await db.execute(sql`select id,owner_id,reviewer_id from close_run_tasks where run_id=${runId} order by id`)).rows,tasks);
  } finally {await dropScratchOrg(org.orgId);}
});

test('final approval verifies the same entity-scoped evidence as refresh', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const runId=await run(org,actor,[org.subsidiaryId]);
    const approver=(await db.execute<{id:string}>(sql`select id from users where org_id=${org.orgId} and id<>${actor} limit 1`)).rows[0]!.id;
    await db.execute(sql`update close_run_tasks set status='waived' where run_id=${runId}`);
    await db.execute(sql`update close_runs set status='review' where id=${runId}`);
    await journal(org,actor,other,'15','USD');
    await withOrg(org.orgId,()=>finalizeCloseFlowApproval({orgId:org.orgId,runId,actorId:approver,outcome:'approved'}));
    assert.equal((await db.execute<{status:string}>(sql`select status from close_runs where id=${runId}`)).rows[0]!.status,'approved');
    await db.execute(sql`update close_runs set status='review' where id=${runId}`);
    await journal(org,actor,org.subsidiaryId,'15');
    await assert.rejects(withOrg(org.orgId,()=>finalizeCloseFlowApproval({orgId:org.orgId,runId,actorId:approver,outcome:'approved'})),/ledger changed during approval/);
  } finally {await dropScratchOrg(org.orgId);}
});

test('a scoped approval fingerprints prior-period carrying activity without unrelated entities', {skip:!enabled}, async () => {
  const {org,actor,other}=await setup();
  try {
    const calendar=(await db.execute<{id:string}>(sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`)).rows[0]!.id;
    const prior=randomUUID();
    await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
      values (${prior},${org.orgId},${calendar},2026,6,'Prior period','2026-06-01','2026-06-30')`);
    const runId=await run(org,actor,[org.subsidiaryId]);
    const first=await refreshCloseRun(org.orgId,runId,actor);
    await db.execute(sql`update close_runs set status='approved',approved_at=now(),approved_by=${actor} where id=${runId}`);
    await journal({...org,periodId:prior,date:'2026-06-15'},actor,other,'10','USD');
    assert.equal((await refreshCloseRun(org.orgId,runId,actor)).fingerprint,first.fingerprint);
    await journal({...org,periodId:prior,date:'2026-06-15'},actor,org.subsidiaryId,'10');
    assert.notEqual((await refreshCloseRun(org.orgId,runId,actor)).fingerprint,first.fingerprint);
    assert.equal((await db.execute<{status:string}>(sql`select status from close_runs where id=${runId}`)).rows[0]!.status,'in_progress');
  } finally {await dropScratchOrg(org.orgId);}
});

test('fingerprint uses assigned regular and adjustment period ordering for same-end entries', {skip:!enabled}, async () => {
  const {org,actor}=await setup();
  try {
    const calendar=(await db.execute<{id:string}>(sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`)).rows[0]!.id;
    const adjustment=randomUUID(), later=randomUUID();
    await db.execute(sql`insert into accounting_periods (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment)
      values (${adjustment},${org.orgId},${calendar},2026,13,'First adjustment','2026-07-31','2026-07-31',true),
        (${later},${org.orgId},${calendar},2026,14,'Later adjustment','2026-07-31','2026-07-31',true)`);
    const regularRun=await run(org,actor,[org.subsidiaryId]);
    const regularFingerprint=(await refreshCloseRun(org.orgId,regularRun,actor)).fingerprint;
    await journal({...org,periodId:adjustment,date:'2026-07-31'},actor,org.subsidiaryId,'10');
    assert.equal((await refreshCloseRun(org.orgId,regularRun,actor)).fingerprint,regularFingerprint,'regular period excludes same-end adjustment');
    const adjustmentRun=await run({...org,periodId:adjustment},actor,[org.subsidiaryId]);
    const before=(await refreshCloseRun(org.orgId,adjustmentRun,actor)).fingerprint;
    await journal({...org,periodId:later,date:'2026-07-31'},actor,org.subsidiaryId,'10');
    assert.equal((await refreshCloseRun(org.orgId,adjustmentRun,actor)).fingerprint,before,'earlier adjustment excludes later adjustment');
    await journal(org,actor,org.subsidiaryId,'10');
    assert.notEqual((await refreshCloseRun(org.orgId,adjustmentRun,actor)).fingerprint,before,'adjustment includes its preceding regular period');
  } finally {await dropScratchOrg(org.orgId);}
});
