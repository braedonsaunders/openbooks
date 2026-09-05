import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildSchedule, runDepreciation } from '@openbooks/engine/src/depreciation.ts';
import { sql } from 'drizzle-orm';
import { db, env } from '@openbooks/engine/src/db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

async function seedAsset(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const assetId = randomUUID(), categoryId = randomUUID();
  await db.execute(sql`insert into asset_categories
    (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values (${categoryId},${org.orgId},'Reversal equipment',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets
    (id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values (${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'REVERSE-CHAIN','Reversal asset','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month')`);
  return { actorId, assetId };
}

const root = pathToFileURL(process.cwd() + '/').href;
const state: { gate: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { gate: null };
Object.assign(globalThis, { __assetEditControls: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/feature-gates') && context.parentURL?.includes('/api/assets/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardFeaturePermission(){return globalThis.__assetEditControls.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { PATCH } = await import('../app/api/assets/[id]/route');
const { disposeAsset, remeasureAsset } = await import('@openbooks/engine/src/asset-lifecycle.ts');

const changes = ['cost', 'category', 'subsidiary', 'asset account', 'accumulated account', 'service date', 'draft status', 'active status', 'name', 'unchanged accounts'] as const;
for (const history of ['none', 'depreciation', 'impairment', 'disposal', 'write-off'] as const) {
  for (const change of changes) {
    test(`asset edit controls: ${history}, ${change}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
      const org = await createScratchOrg();
      try {
        const { actorId, assetId } = await seedAsset(org);
        const categoryId = randomUUID(), subsidiaryId = randomUUID();
        await db.execute(sql`insert into asset_categories (id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
          select ${categoryId},org_id,'Other category',asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention from asset_categories where org_id=${org.orgId} limit 1`);
        await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country,is_active) values (${subsidiaryId},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA',true)`);
        state.gate = { user: { orgId:org.orgId,id:actorId }, allowedSubsidiaryIds:null };
        if (history==='depreciation') {
          await buildSchedule(assetId,org.orgId,actorId,org.bookId);
          assert.equal((await runDepreciation(org.orgId,'2026-07-31',actorId,assetId)).posted,1);
        } else if (history==='impairment') {
          await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
        } else if (history==='disposal' || history==='write-off') {
          await disposeAsset(org.orgId,assetId,{actorId,date:'2026-07-31',proceeds:'300',proceedsAccountId:org.accounts.bank,writeOff:history==='write-off'});
        }
        const snapshot = async () => (await db.execute(sql`
          select (select jsonb_agg(to_jsonb(a) order by id) from fixed_assets a where org_id=${org.orgId}) as assets,
                 (select jsonb_agg(to_jsonb(e) order by id) from asset_events e where org_id=${org.orgId}) as events,
                 (select jsonb_agg(to_jsonb(e) order by id) from journal_entries e where org_id=${org.orgId}) as entries,
                 (select jsonb_agg(to_jsonb(l) order by id) from depreciation_schedule_lines l where org_id=${org.orgId}) as schedule_lines
        `)).rows;
        const before = await snapshot();
        const bodies: Record<typeof changes[number], Record<string,unknown>> = {
          cost:{acquisitionCost:'2000'},category:{categoryId},subsidiary:{subsidiaryId},
          'asset account':{assetAccountId:org.accounts.taxInput},'accumulated account':{accumulatedDepreciationAccountId:org.accounts.taxOutput},
          'service date':{inServiceOn:'2026-07-16'},'draft status':{status:'draft'},'active status':{status:'in_service'},name:{name:'Reviewed name'},
          'unchanged accounts':{assetAccountId:org.accounts.invAsset,accumulatedDepreciationAccountId:org.accounts.clearing,depreciationExpenseAccountId:org.accounts.adjustment},
        };
        const response = await PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{
          method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(bodies[change]),
        }),{params:Promise.resolve({id:assetId})});
        const allowed = history==='none' || change==='name' || change==='unchanged accounts' || (change==='active status' && history!=='disposal' && history!=='write-off');
        assert.equal(response.status,allowed?200:409,JSON.stringify(await response.json()));
        if (!allowed) assert.deepEqual(await snapshot(),before,'refusal preserves all financial and configuration state');
      } finally {state.gate=null;await dropScratchOrg(org.orgId)}
    });
  }
}

test('asset edit refuses a target subsidiary outside the caller scope', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
 const org=await createScratchOrg();
 try {
  const {actorId,assetId}=await seedAsset(org);
  const target=randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,is_active) values (${target},${org.orgId},${org.subsidiaryId},'Outside','CAD','CA',true)`);
  state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:new Set([org.subsidiaryId])};
  const response=await PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({subsidiaryId:target})}),{params:Promise.resolve({id:assetId})});
  assert.equal(response.status,422);
  assert.equal((await db.execute<{subsidiary_id:string}>(sql`select subsidiary_id from fixed_assets where id=${assetId}`)).rows[0]!.subsidiary_id,org.subsidiaryId);
 } finally {state.gate=null;await dropScratchOrg(org.orgId)}
});

test('metadata save preserves the controlled impairment schedule', {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
 const org=await createScratchOrg();
 try {
  const {actorId,assetId}=await seedAsset(org);
  state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};
  await db.execute(sql`update fixed_assets set useful_life_months=2 where id=${assetId}`);
  await db.execute(sql`insert into accounting_periods(org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
    select org_id,2026,8,'2026-08','2026-08-01','2026-08-31',false,fiscal_calendar_id from accounting_periods where org_id=${org.orgId} limit 1`);
  await buildSchedule(assetId,org.orgId,actorId,org.bookId);
  await remeasureAsset(org.orgId,assetId,{actorId,date:'2026-07-31',newCarryingValue:'800'});
  const schedule=()=>db.execute(sql`select * from depreciation_schedule_lines where org_id=${org.orgId} order by sequence`);
  const before=(await schedule()).rows;
  assert.deepEqual(before.map(line=>line.planned_amount),['400.0000','400.0000']);
  const response=await PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Updated asset label'})}),{params:Promise.resolve({id:assetId})});
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.deepEqual((await schedule()).rows,before,'metadata edit cannot rebuild controlled valuation amounts');
 }finally{state.gate=null;await dropScratchOrg(org.orgId)}
});

  test('asset edit rechecks subsidiary scope after waiting', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    const writer = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    let connected = false;
    let pending: Promise<Response> | undefined;
    try {
      const { actorId, assetId } = await seedAsset(org);
      const outsideId = randomUUID();
      await db.execute(sql`insert into subsidiaries (id,org_id,parent_id,name,base_currency,country,is_active) values (${outsideId},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA',true)`);
      state.gate = { user: { orgId: org.orgId, id: actorId }, allowedSubsidiaryIds: new Set([org.subsidiaryId]) };
      await writer.connect(); connected = true;
      await writer.query('begin');
      await writer.query("select set_config('app.bypass_rls','on',true)");
      await writer.query('update fixed_assets set subsidiary_id=$1 where id=$2', [outsideId,assetId]);
      const pid = (await writer.query<{ pid:number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
      pending = PATCH(new Request(`http://audit.local/api/assets/${assetId}`, {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:'Outside scope edit'}),
      }), {params:Promise.resolve({id:assetId})});
      void pending.catch(() => {});
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const row = (await writer.query<{ blocked:boolean }>('select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) as blocked',[pid])).rows[0]!;
        if (row.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve,25));
      }
      assert.ok(blocked,'posting waits for the concurrent asset update');
      await writer.query('commit');
      const response = await pending;
      assert.equal(response.status,422);
      assert.match((await response.json()).error,/not found|scope|permitted/);
      assert.equal((await db.execute(sql`select id from journal_entries where org_id=${org.orgId}`)).rows.length,0);
      assert.equal((await db.execute(sql`select id from asset_events where org_id=${org.orgId}`)).rows.length,0);
      const asset = (await db.execute<{ subsidiary_id:string; status:string }>(sql`select subsidiary_id,status from fixed_assets where id=${assetId}`)).rows[0]!;
      assert.equal(asset.subsidiary_id,outsideId);
      assert.equal(asset.status,'in_service');
    } finally {
      if (connected) await writer.query('rollback').catch(() => {});
      if (pending) await pending.catch(() => {});
      if (connected) await writer.end();
      state.gate=null;
      await dropScratchOrg(org.orgId);
    }
  });
