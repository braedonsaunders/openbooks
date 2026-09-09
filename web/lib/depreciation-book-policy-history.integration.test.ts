import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/src/db.ts';
import { buildSchedule, runDepreciation } from '@openbooks/engine/src/depreciation.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from '@openbooks/engine/src/test-fixtures.ts';

const state: { gate: { user: { orgId: string; id: string } } | null } = { gate: null };
Object.assign(globalThis, { __depreciationBookHistory: state });
const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier.endsWith('/lib/authz') && context.parentURL?.includes('/api/admin/setup/')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function guardPermission(){return globalThis.__depreciationBookHistory.gate}' };
  }
  if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context);
  return next(specifier, context);
} });
const { POST, PATCH, DELETE } = await import('../app/api/admin/setup/[entity]/route');

async function seed(org: ScratchOrg) {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID(), assetId = randomUUID();
  const body = { id: categoryId, name: 'Category policy', assetAccountId: org.accounts.invAsset,
    accumulatedDepreciationAccountId: org.accounts.clearing, depreciationExpenseAccountId: org.accounts.adjustment,
    gainLossAccountId: org.accounts.adjustment, defaultMethod: 'straight_line', defaultLifeMonths: 10,
    defaultConvention: 'full_month', isActive: true };
  await db.execute(sql`insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention)
    values(${categoryId},${org.orgId},${body.name},${body.assetAccountId},${body.accumulatedDepreciationAccountId},${body.depreciationExpenseAccountId},${body.gainLossAccountId},'straight_line',10,'full_month')`);
  await db.execute(sql`insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,depreciation_method,useful_life_months,depreciation_convention)
    values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},'CATEGORY-POLICY','Category asset','in_service',${org.date},${org.date},1000,0,'straight_line',10,'full_month')`);
  state.gate = { user: { orgId: org.orgId, id: actorId } };
  return { actorId, categoryId, assetId, body };
}

for (const method of ['POST','PATCH','DELETE'] as const) {
  test(`setup ${method} returns a clear conflict for historical depreciation book policy`, {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
    const org=await createScratchOrg();
    try {
      const f=await seed(org);
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"fixedAssets":true}'::jsonb) where id=${org.orgId}`);
      const policyId=randomUUID();
      if(method!=='POST') await db.execute(sql`insert into depreciation_book_policies(id,org_id,book_id,category_id,method,life_months,convention)
        values(${policyId},${org.orgId},${org.bookId},${f.categoryId},'straight_line',10,'full_month')`);
      await buildSchedule(f.assetId,org.orgId,f.actorId,org.bookId);
      assert.equal((await runDepreciation(org.orgId,'2026-07-31',f.actorId,f.assetId)).posted,1);
      const snapshot=async()=>({
        policies:(await db.execute(sql`select * from depreciation_book_policies where org_id=${org.orgId} order by id`)).rows,
        audit:(await db.execute(sql`select * from audit_log where org_id=${org.orgId} order by id`)).rows,
        schedule:(await db.execute(sql`select * from depreciation_schedule_lines where org_id=${org.orgId} order by id`)).rows,
      });
      const before=await snapshot();
      const body={...(method==='PATCH'?{id:policyId}:{}),bookId:org.bookId,categoryId:f.categoryId,method:'straight_line',lifeMonths:20,convention:'full_month'};
      const response=await ({POST,PATCH,DELETE}[method])(new Request(`http://audit.local/api/admin/setup/depreciation-book-policies?id=${policyId}`,{
        method,headers:{'Content-Type':'application/json'},...(method==='DELETE'?{}:{body:JSON.stringify(body)}),
      }),{params:Promise.resolve({entity:'depreciation-book-policies'})});
      const result=await response.json();
      assert.equal(response.status,409,JSON.stringify(result));
      assert.equal(result.error,'Depreciation book accounting policy is fixed after financial history exists. Create a new category or use a controlled adjustment.');
      assert.deepEqual(await snapshot(),before,'refusal preserves policy, posted history and audit evidence');
    } finally {state.gate=null;await dropScratchOrg(org.orgId);}
  });
}
