import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { sql } from 'drizzle-orm';
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts';
import { db } from '@openbooks/engine/src/db.ts';
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
const state: { gate: { user:{orgId:string;id:string};allowedSubsidiaryIds:null } | null; builds:number }={gate:null,builds:0};
Object.assign(globalThis,{__assetLifeBounds:state});
registerHooks({resolve(specifier,context,next){
 if(specifier==='server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'};
 if(context.parentURL?.includes('/api/assets/') && specifier.endsWith('/lib/feature-gates'))return {shortCircuit:true,url:'data:text/javascript,export async function guardFeaturePermission(){return globalThis.__assetLifeBounds.gate}'};
 // Do not execute the dangerous workload if a boundary regression reappears.
 // Database writes, authorization context and response loading remain real.
 if(decodeURIComponent(context.parentURL ?? '').endsWith('/api/assets/[id]/route.ts') && specifier.endsWith('/depreciation.ts'))return {shortCircuit:true,url:'data:text/javascript,export async function buildAllSchedulesWithRunner(){globalThis.__assetLifeBounds.builds++}'};
 if(specifier.startsWith('@/'))return next(root+'web/'+specifier.slice(2)+'.ts',context);
 return next(specifier,context);
}});
const {PATCH}=await import('../app/api/assets/[id]/route');
for(const value of [0,-1,1.5,1_000_000_000,true,[12],{},'Infinity','1e9',1,'12',12000,null]){
 test(`asset useful-life boundary ${JSON.stringify(value)}`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const {actorId,assetId}=await seedAsset(org);
   await db.execute(sql`update fixed_assets set status='draft' where id=${assetId}`);
   state.gate={user:{orgId:org.orgId,id:actorId},allowedSubsidiaryIds:null};state.builds=0;
   const snapshot=async()=>(await db.execute(sql`select (select to_jsonb(a) from fixed_assets a where id=${assetId}) as asset,(select jsonb_agg(to_jsonb(l)) from audit_log l where row_id=${assetId}) as audit`)).rows;
   const before=await snapshot();
   const response=await PATCH(new Request(`http://audit.local/api/assets/${assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({lifeMonths:value,expectedUpdatedAt:await revision(assetId)})}),{params:Promise.resolve({id:assetId})});
   const valid=value===1||value==='12'||value===12000||value===null;
   assert.equal(response.status,valid?200:422,JSON.stringify(await response.json()));
   assert.equal(state.builds,valid?1:0,'invalid input never starts schedule calculation');
   if(!valid)assert.deepEqual(await snapshot(),before,'refusal leaves configuration and audit unchanged');
   else assert.equal((await db.execute(sql`select useful_life_months from fixed_assets where id=${assetId}`)).rows[0]!.useful_life_months,value===null?null:Number(value));
  }finally{state.gate=null;await dropScratchOrg(org.orgId)}
 });
}

async function revision(assetId:string):Promise<string>{return (await db.execute<{revision:string}>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision from fixed_assets where id=${assetId}`)).rows[0]!.revision;}
