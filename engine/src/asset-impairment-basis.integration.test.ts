import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, pool, withOrgTransaction } from './db.ts';
import { remeasureAsset, reverseAssetLifecycleEvent } from './asset-lifecycle.ts';
import { buildSchedule, reconcileAssetDepreciationStatusWithRunner, recordDepreciationInput, runDepreciation, unimpairedAssetCarryingValue, type DepreciationMethod } from './depreciation.ts';
import { toUnits } from './money.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from './test-fixtures.ts';

async function seed(org: ScratchOrg, opts: { method?: DepreciationMethod; customFormula?: string; salvage?: string; julyDepreciation?: string; bookLifeMonths?: number; postJuly?: boolean } = {}) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID(), assetId = randomUUID();
  const calendarId = (await db.execute<{id:string}>(sql`select fiscal_calendar_id as id from accounting_periods where id=${org.periodId}`)).rows[0]!.id;
  for (let i = 1; i < 10; i++) {
    const start = new Date(Date.UTC(2026, 6+i, 1));
    const end = new Date(Date.UTC(2026, 7+i, 0));
    await db.execute(sql`insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()},${org.orgId},${start.getUTCFullYear()},${start.getUTCMonth()+1},${start.toISOString().slice(0,7)},${start.toISOString().slice(0,10)},${end.toISOString().slice(0,10)},false,${calendarId})`);
  }
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Audit equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'AUDIT-0909G','Audit asset','in_service',${org.date},${org.date},1000,${opts.salvage ?? '0'},${opts.method ?? 'straight_line'},10,'full_month')`);
  if (opts.customFormula) {
    const methodId = randomUUID();
    await db.execute(sql`insert into depreciation_methods (id,org_id,code,name,formula,end_of_life,is_active)
      values (${methodId},${org.orgId},'CUSTOM-AUDIT','Custom audit method',${opts.customFormula},'fully_depreciate',true)`);
    await db.execute(sql`update fixed_assets set depreciation_method_id=${methodId} where id=${assetId} and org_id=${org.orgId}`);
  }
  if (opts.bookLifeMonths) {
    await db.execute(sql`insert into depreciation_book_policies (org_id,book_id,category_id,method,life_months,convention)
      values (${org.orgId},${org.bookId},${categoryId},'straight_line',${opts.bookLifeMonths},'full_month')`);
  }
  if (opts.method === 'units_of_production') {
    await db.execute(sql`update fixed_assets set depreciation_units_total=1000 where id=${assetId} and org_id=${org.orgId}`);
  }
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  if (opts.postJuly !== false && opts.method !== 'manual' && opts.method !== 'units_of_production') {
    assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,opts.julyDepreciation ?? '100.0000');
  }
  return { actorId, assetId, categoryId };
}
function bookPolicyRefusal(error: unknown): boolean {
  const wrapped = error as { constraint?: string; cause?: { constraint?: string } };
  return (wrapped.cause?.constraint ?? wrapped.constraint) === 'depreciation_book_posted_policy';
}
async function accumulated(org: ScratchOrg) {
  return toUnits((await db.execute<{total:string}>(sql`select coalesce(sum(l.amount),0)::text as total from journal_lines l
    join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    where l.org_id=${org.orgId} and l.account_id=${org.accounts.clearing} and e.status in ('posted','reversed')`)).rows[0]!.total);
}
async function scheduleRows(org: ScratchOrg, assetId: string, bookId = org.bookId) {
  return (await db.execute<{id:string; sequence:number; planned:string; posted:string|null; journal_entry_id:string|null}>(sql`
    select l.id, l.sequence, l.planned_amount::text as planned, l.posted_amount::text as posted, l.journal_entry_id
      from depreciation_schedule_lines l join depreciation_schedules s on s.id=l.schedule_id and s.org_id=l.org_id
     where s.org_id=${org.orgId} and s.asset_id=${assetId} and s.book_id=${bookId} order by l.sequence`)).rows;
}

for (const rebuild of ['reverse latest impairment', 'explicit rebuild'] as const) {
test(`asset schedule ${rebuild} preserves retained impairment and other books`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org);
    const postedBefore = (await scheduleRows(org,assetId)).filter(line => line.posted !== null);
    const alternateBookId = randomUUID();
    await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
      values (${alternateBookId},${org.orgId},'ALT','Alternate reporting',false,true,false)`);
    await buildSchedule(assetId,org.orgId,actorId,alternateBookId);
    const alternateBefore = await scheduleRows(org,assetId,alternateBookId);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'750'});
    if (rebuild === 'reverse latest impairment') {
      const second = await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'600'});
      const eventId = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${second.entryId}`)).rows[0]!.id;
      await reverseAssetLifecycleEvent(org.orgId,eventId,{actorId,date:'2026-07-31',reason:'Correct duplicate impairment assessment'});
    } else {
      await buildSchedule(assetId,org.orgId,actorId,org.bookId);
    }
    assert.equal(await accumulated(org),-toUnits('250'),'100 depreciation plus unreversed 150 impairment');
    const rebuilt = await scheduleRows(org,assetId);
    assert.deepEqual(rebuilt.filter(line => line.posted !== null),postedBefore,'posted depreciation evidence is immutable');
    assert.deepEqual(rebuilt.filter(line => line.posted === null).map(line => line.planned),[
      ...Array<string>(8).fill('83.3333'),'83.3336',
    ],'750 remains allocated over nine periods with the final exact residual');
    assert.deepEqual(await scheduleRows(org,assetId,alternateBookId),alternateBefore,'primary remeasurement leaves the other book untouched');
    await buildSchedule(assetId,org.orgId,actorId,alternateBookId);
    assert.deepEqual((await scheduleRows(org,assetId,alternateBookId)).map(line => line.planned),Array<string>(10).fill('100.0000'),
      'rebuilding the alternate book must not consume primary-book impairment');
    const posted = await runDepreciation(org.orgId,'2027-04-30',actorId,assetId);
    assert.deepEqual(posted.problems,[]);
    assert.equal(posted.totalAmount,'750.0000');
    assert.equal(toUnits('1000')+await accumulated(org),0n,'remaining depreciation must consume 750, preserving zero salvage');
    assert.equal((await db.execute<{status:string}>(sql`select status from fixed_assets where org_id=${org.orgId} and id=${assetId}`)).rows[0]!.status,
      'fully_depreciated','asset lifecycle must agree with primary-book carrying value at salvage');
  } finally { await dropScratchOrg(org.orgId); }
});
}

for (const policy of [
  { name:'straight line', opts:{}, ceiling:'800', refused:'850', august:'50.0000' },
  { name:'unrelated fiscal calendar', opts:{}, ceiling:'800', refused:'850', august:'50.0000' },
  { name:'double declining', opts:{method:'double_declining' as const,julyDepreciation:'200.0000'}, ceiling:'640', refused:'690', august:'50.0000' },
  { name:'custom formula', opts:{customFormula:'((OC-RV)/AL)*2',julyDepreciation:'200.0000'}, ceiling:'600', refused:'650', august:'112.5000' },
  { name:'book policy', opts:{bookLifeMonths:5,julyDepreciation:'200.0000'}, ceiling:'600', refused:'650', august:'112.5000' },
  { name:'salvage floor', opts:{salvage:'100',julyDepreciation:'90.0000'}, ceiling:'820', refused:'850', august:'38.8888' },
]) {
test(`IFRS restoration after depreciation honors ${policy.name} carrying ceiling`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org,policy.opts);
    if (policy.name === 'unrelated fiscal calendar') {
      const calendarId = randomUUID();
      await db.execute(sql`insert into fiscal_calendars
        (id,org_id,name,cadence,year_start_month,week_starts_on,time_zone,adjustment_period_enabled,is_default,is_active,config)
        values (${calendarId},${org.orgId},'Unrelated reporting calendar','monthly',1,1,'UTC',false,false,true,'{}'::jsonb)`);
      await db.execute(sql`insert into accounting_periods
        (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
        values (${randomUUID()},${org.orgId},2026,1,'Reporting quarter','2026-06-01','2026-09-30',false,${calendarId})`);
    }
    await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
    assert.equal(await unimpairedAssetCarryingValue(db,assetId,org.orgId,org.bookId,'2026-08-15'),
      policy.opts.julyDepreciation === '200.0000' ? '800.0000' : policy.opts.salvage ? '910.0000' : '900.0000',
      'an unfinished accounting period does not consume a future charge');
    assert.equal((await runDepreciation(org.orgId,'2026-08-31',actorId,assetId)).totalAmount,policy.august);
    const before = await scheduleRows(org,assetId);
    const balanceBefore = await accumulated(org);
    const eventsBefore = (await db.execute(sql`select * from asset_events where org_id=${org.orgId} order by id`)).rows;
    await assert.rejects(remeasureAsset(org.orgId,assetId,{actorId,date:'2026-08-31',newCarryingValue:policy.refused}), /caps.*net of depreciation/i,
      'restoration cannot exceed carrying amount under the original depreciation policy');
    assert.deepEqual(await scheduleRows(org,assetId),before);
    assert.equal(await accumulated(org),balanceBefore);
    assert.deepEqual((await db.execute(sql`select * from asset_events where org_id=${org.orgId} order by id`)).rows,eventsBefore);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-08-31',newCarryingValue:policy.ceiling});
    assert.equal(toUnits('1000')+await accumulated(org),toUnits(policy.ceiling),'exact ceiling is permitted');
  } finally { await dropScratchOrg(org.orgId); }
});
}

for (const method of ['manual','units_of_production'] as const) {
  test(`restoration ceiling replays retained ${method} evidence instead of remeasured plan`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    const org = await createScratchOrg();
    try {
      const {actorId,assetId} = await seed(org,{method});
      const folderId = randomUUID();
      await db.execute(sql`insert into folders (id,org_id,name,record_table,record_id,created_by,updated_by)
        values (${folderId},${org.orgId},'Asset evidence','fixed_assets',${assetId},${actorId},${actorId})`);
      const evidenceFileId = (await db.execute<{id:string}>(sql`insert into files
        (org_id,folder_id,name,file_type,content_type,size_bytes,created_by,updated_by)
        values (${org.orgId},${folderId},'Asset evidence.pdf','pdf','application/pdf',1,${actorId},${actorId}) returning id`)).rows[0]!.id;
      await db.execute(sql`insert into file_attachments (org_id,file_id,target_table,target_id,created_by)
        values (${org.orgId},${evidenceFileId},'fixed_assets',${assetId},${actorId})`);
      const record = (date:string,value:string) => recordDepreciationInput({
        orgId:org.orgId,assetId,bookId:org.bookId,actorId,evidenceFileId,
        effectiveDate:date,kind:method === 'manual' ? 'manual' : 'production_usage',value,memo:'Approved asset depreciation evidence',
      });
      await record(org.date,'100');
      assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,'100.0000');
      await record('2026-08-15','150');
      await record('2026-08-15','200'); // Superseded unposted evidence is excluded.
      await record('2026-09-15','100'); // Future evidence does not affect August.
      await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
      assert.equal(await unimpairedAssetCarryingValue(db,assetId,org.orgId,org.bookId,'2026-07-31'),'900.0000');
      assert.equal(await unimpairedAssetCarryingValue(db,assetId,org.orgId,org.bookId,'2026-08-31'),'700.0000');
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test('restoration ceiling retains the posted book policy after a category policy edit', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org,{bookLifeMonths:10});
    await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
    assert.equal((await runDepreciation(org.orgId,'2026-08-31',actorId,assetId)).totalAmount,'50.0000');
    await assert.rejects(db.execute(sql`update depreciation_book_policies set life_months=20 where org_id=${org.orgId} and book_id=${org.bookId}`),bookPolicyRefusal);
    await assert.rejects(remeasureAsset(org.orgId,assetId,{actorId,date:'2026-08-31',newCarryingValue:'850'}),/caps.*net of depreciation/i);
    assert.equal(await unimpairedAssetCarryingValue(db,assetId,org.orgId,org.bookId,'2026-08-31'),'800.0000');
  } finally { await dropScratchOrg(org.orgId); }
});

for (const action of ['insert', 'delete', 'method', 'convention', 'move book', 'move category', 'move organization', 'move into history'] as const) {
  test(`posted depreciation book policy refuses ${action}`, {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
    const org = await createScratchOrg();
    const other = action === 'move organization' ? await createScratchOrg() : null;
    try {
      const {categoryId} = await seed(org,action === 'insert' || action === 'move into history' ? {} : {bookLifeMonths:10});
      const alternateBookId = randomUUID(), alternateCategoryId = randomUUID();
      await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
        values (${alternateBookId},${org.orgId},'ALT','Alternate',false,true,false)`);
      await db.execute(sql`insert into asset_categories (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,default_method,default_life_months)
        values (${alternateCategoryId},${org.orgId},'Unused category',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},'straight_line',10)`);
      const mutation = action === 'insert'
        ? sql`insert into depreciation_book_policies (org_id,book_id,category_id,method,life_months) values (${org.orgId},${org.bookId},${categoryId},'straight_line',20)`
        : action === 'delete'
          ? sql`delete from depreciation_book_policies where org_id=${org.orgId} and category_id=${categoryId}`
          : action === 'method'
            ? sql`update depreciation_book_policies set method='double_declining' where org_id=${org.orgId} and category_id=${categoryId}`
            : action === 'convention'
              ? sql`update depreciation_book_policies set convention='half_year' where org_id=${org.orgId} and category_id=${categoryId}`
              : action === 'move book'
                ? sql`update depreciation_book_policies set book_id=${alternateBookId} where org_id=${org.orgId} and category_id=${categoryId}`
                : action === 'move category'
                  ? sql`update depreciation_book_policies set category_id=${alternateCategoryId} where org_id=${org.orgId} and category_id=${categoryId}`
                  : action === 'move organization'
                    ? sql`update depreciation_book_policies set org_id=${other!.orgId} where org_id=${org.orgId} and category_id=${categoryId}`
                    : sql`update depreciation_book_policies set category_id=${categoryId} where org_id=${org.orgId} and category_id=${alternateCategoryId}`;
      if (action === 'move into history') {
        await db.execute(sql`insert into depreciation_book_policies (org_id,book_id,category_id,method,life_months)
          values (${org.orgId},${org.bookId},${alternateCategoryId},'straight_line',10)`);
      }
      await assert.rejects(db.execute(mutation),bookPolicyRefusal);
      // Another book has no financial history: its defaults remain editable,
      // including deletion/recreation, even though this category's primary does.
      await db.execute(sql`insert into depreciation_book_policies (org_id,book_id,category_id,method,life_months)
        values (${org.orgId},${alternateBookId},${categoryId},'straight_line',10)`);
      await db.execute(sql`update depreciation_book_policies set life_months=20 where org_id=${org.orgId} and book_id=${alternateBookId}`);
      await db.execute(sql`delete from depreciation_book_policies where org_id=${org.orgId} and book_id=${alternateBookId}`);
      await db.execute(sql`update depreciation_book_policies set updated_at=now() where org_id=${org.orgId}`);
    } finally {
      await dropScratchOrg(org.orgId);
      if (other) await dropScratchOrg(other.orgId);
    }
  });
}

test('lifecycle history alone fixes book policy, including a reversed impairment', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org,{bookLifeMonths:10,postJuly:false});
    const impaired = await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
    const eventId = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${impaired.entryId}`)).rows[0]!.id;
    await assert.rejects(db.execute(sql`delete from depreciation_book_policies where org_id=${org.orgId}`),bookPolicyRefusal);
    await reverseAssetLifecycleEvent(org.orgId,eventId,{actorId,date:'2026-07-31',reason:'Correct impairment assessment before depreciation'});
    await assert.rejects(db.execute(sql`update depreciation_book_policies set life_months=20 where org_id=${org.orgId}`),bookPolicyRefusal);
  } finally { await dropScratchOrg(org.orgId); }
});

test('retained schedule policy drift refuses restoration and rebuild without rewriting history', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org,{bookLifeMonths:10});
    await db.execute(sql`update orgs set settings=settings || '{"reportingFramework":"ifrs"}'::jsonb where id=${org.orgId}`);
    await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
    // A divergent retained header models evidence already out of sync before
    // the forward guard. Neither side may be silently declared historical truth.
    await db.execute(sql`update depreciation_schedules set life_months=20 where org_id=${org.orgId} and asset_id=${assetId}`);
    const before = await scheduleRows(org,assetId), balanceBefore = await accumulated(org);
    await assert.rejects(remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'850'}),/historical depreciation policy differs/);
    await assert.rejects(buildSchedule(assetId,org.orgId,actorId,org.bookId),/historical depreciation policy differs/);
    assert.deepEqual(await scheduleRows(org,assetId),before);
    assert.equal(await accumulated(org),balanceBefore);
  } finally { await dropScratchOrg(org.orgId); }
});

test('first depreciation serializes a waiting policy update without a tuple-lock deadlock', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let edit: Promise<unknown> | undefined;
  try {
    const {actorId,assetId,categoryId} = await seed(org,{bookLifeMonths:10,postJuly:false});
    await writer.query('begin');
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)");
    const writerPid = (await writer.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid;
    await withOrgTransaction(org.orgId,async () => {
      await db.execute(sql`select id from fixed_assets where org_id=${org.orgId} and id=${assetId} for update`);
      await db.execute(sql`select id from asset_categories where org_id=${org.orgId} and id=${categoryId} for update`);
      const holderPid = (await db.execute<{pid:number}>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      edit = writer.query('update depreciation_book_policies set life_months=20 where org_id=$1 and book_id=$2',[org.orgId,org.bookId]).then(() => null,error => error);
      let blocked = false;
      for (let attempt=0;attempt<200;attempt++) {
        blocked = (await pool.query<{blocked:boolean}>('select $1::int=any(pg_blocking_pids($2::int)) as blocked',[holderPid,writerPid])).rows[0]!.blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'policy writer holds its tuple and waits for category fence');
      await buildSchedule(assetId,org.orgId,actorId,org.bookId);
      assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).totalAmount,'100.0000');
    });
    assert.equal(bookPolicyRefusal(await edit),true,'writer observes newly committed financial history');
    assert.equal((await db.execute<{life:number}>(sql`select life_months as life from depreciation_book_policies where org_id=${org.orgId}`)).rows[0]!.life,10);
  } finally {
    if (edit) await edit;
    await writer.query('rollback');
    writer.release();
    await dropScratchOrg(org.orgId);
  }
});

test('asset status follows primary carrying value through full impairment, reversal, and revaluation', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org);
    const status = async () => (await db.execute<{status:string}>(sql`select status from fixed_assets where org_id=${org.orgId} and id=${assetId}`)).rows[0]!.status;
    const reverse = async (entryId:string,date:string) => {
      const eventId = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${entryId}`)).rows[0]!.id;
      return reverseAssetLifecycleEvent(org.orgId,eventId,{actorId,date,reason:'Correct the asset carrying value assessment'});
    };
    const alternateBookId = randomUUID();
    await db.execute(sql`insert into accounting_books (id,org_id,code,name,is_primary,is_active,posts_gl)
      values (${alternateBookId},${org.orgId},'ALT','Alternate posting book',false,true,true)`);
    await buildSchedule(assetId,org.orgId,actorId,alternateBookId);
    assert.equal((await runDepreciation(org.orgId,'2027-04-30',actorId,assetId,undefined,alternateBookId)).totalAmount,'1000.0000');
    assert.equal(await status(),'in_service','an exhausted alternate book does not determine asset lifecycle');
    const impaired = await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'0'});
    assert.equal(await status(),'fully_depreciated');
    await reverse(impaired.entryId,'2026-07-31');
    assert.equal(await status(),'in_service','reversing a full impairment restores the live asset');
    await runDepreciation(org.orgId,'2027-04-30',actorId,assetId,undefined,org.bookId);
    assert.equal(await status(),'fully_depreciated');
    const revaluation = await remeasureAsset(org.orgId,assetId,{actorId,date:'2027-04-30',newCarryingValue:'100'});
    assert.equal(await status(),'in_service','a new carrying value reactivates a fully depreciated asset');
    await reverse(revaluation.entryId,'2027-04-30');
    assert.equal(await status(),'fully_depreciated','reversal restores exhausted primary basis');
  } finally { await dropScratchOrg(org.orgId); }
});

test('reversing the sole impairment after depreciation consumes the restored remaining basis', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org);
    const impaired = await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'450'});
    assert.equal((await runDepreciation(org.orgId,'2026-08-31',actorId,assetId)).totalAmount,'50.0000');
    const sourceEventId = (await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${impaired.entryId}`)).rows[0]!.id;
    const postedBefore = (await scheduleRows(org,assetId)).filter(line => line.posted !== null);
    await reverseAssetLifecycleEvent(org.orgId,sourceEventId,{actorId,date:'2026-08-31',reason:'Correct impairment assessment after August depreciation'});
    assert.equal(toUnits('1000')+await accumulated(org),toUnits('850'));
    const remaining = await runDepreciation(org.orgId,'2027-04-30',actorId,assetId);
    assert.deepEqual(remaining.problems,[]);
    assert.equal(toUnits('1000')+await accumulated(org),0n,'reversal must not leave an undepreciated residual');
    assert.equal(remaining.totalAmount,'850.0000');
    assert.deepEqual((await scheduleRows(org,assetId)).filter(line => postedBefore.some(prior => prior.id === line.id)),postedBefore);
  } finally { await dropScratchOrg(org.orgId); }
});


test('derived asset status records both transitions exactly once with primary carrying evidence', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org = await createScratchOrg();
  try {
    const {actorId,assetId} = await seed(org);
    const evidence = async () => (await db.execute<{actor_id:string;at:Date;changes:{before:{status:string};after:{status:string};reason:string;bookId:string;carryingValue:string}}>(sql`
      select actor_id,at,changes from audit_log where org_id=${org.orgId} and row_id=${assetId}
      and changes->>'reason'='Reconcile asset lifecycle with primary-book carrying value' order by at,id`)).rows;
    assert.equal((await evidence()).length,0);
    const impaired = await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'0'});
    const first = (await evidence())[0]!;
    assert.equal(first.actor_id,actorId);
    assert.ok(first.at);
    assert.deepEqual(first.changes.before,{status:'in_service'});
    assert.deepEqual(first.changes.after,{status:'fully_depreciated'});
    assert.equal(first.changes.bookId,org.bookId);
    assert.equal(toUnits(first.changes.carryingValue),0n);
    await withOrgTransaction(org.orgId,() => reconcileAssetDepreciationStatusWithRunner(db,org.orgId,actorId,assetId));
    assert.equal((await evidence()).length,1,'a no-op adds no lifecycle audit');
    const eventId=(await db.execute<{id:string}>(sql`select id from asset_events where org_id=${org.orgId} and journal_entry_id=${impaired.entryId}`)).rows[0]!.id;
    await reverseAssetLifecycleEvent(org.orgId,eventId,{actorId,date:'2026-07-31',reason:'Correct zero carrying assessment'});
    const rows=await evidence();
    assert.equal(rows.length,2);
    assert.equal(rows[1]!.actor_id,actorId);
    assert.deepEqual(rows[1]!.changes.before,{status:'fully_depreciated'});
    assert.deepEqual(rows[1]!.changes.after,{status:'in_service'});
    assert.equal(toUnits(rows[1]!.changes.carryingValue),toUnits('900'));
  } finally {await dropScratchOrg(org.orgId);}
});

test('failure to audit derived asset status rolls back the financial transaction', {skip:!process.env.OPENBOOKS_DB_URL}, async () => {
  const org=await createScratchOrg();
  const trigger='asset_status_audit_'+randomUUID().replaceAll('-','');
  let installed=false;
  try {
    const {actorId,assetId}=await seed(org);
    const snapshot=async()=>({
      assets:(await db.execute(sql`select * from fixed_assets where org_id=${org.orgId}`)).rows,
      entries:(await db.execute(sql`select * from journal_entries where org_id=${org.orgId} order by id`)).rows,
      events:(await db.execute(sql`select * from asset_events where org_id=${org.orgId} order by id`)).rows,
      schedule:await scheduleRows(org,assetId),
      audit:(await db.execute(sql`select * from audit_log where org_id=${org.orgId} order by id`)).rows,
    });
    const before=await snapshot();
    await db.execute(sql.raw(`create function public."${trigger}"() returns trigger language plpgsql as $$ begin
      if new.org_id='${org.orgId}'::uuid and new.table_name='fixed_assets'
      and new.changes->>'reason'='Reconcile asset lifecycle with primary-book carrying value'
      then raise exception 'forced asset status audit failure'; end if; return new; end $$;
      create trigger "${trigger}" before insert on audit_log for each row execute function public."${trigger}"();`));
    installed=true;
    await assert.rejects(remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'0'}),
      (e:unknown)=> /forced asset status audit failure/.test(String((e as {cause?:{message?:string}}).cause?.message ?? e)));
    assert.deepEqual(await snapshot(),before);
  } finally {
    if(installed) await db.execute(sql.raw(`drop trigger "${trigger}" on audit_log; drop function public."${trigger}"();`));
    await dropScratchOrg(org.orgId);
  }
});
