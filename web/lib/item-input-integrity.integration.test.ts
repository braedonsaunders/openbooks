import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { SessionUser } from './auth';
const root = pathToFileURL(process.cwd() + "/").href;
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __itemInputSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' };
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: "data:text/javascript,export async function getTranslations(){return key=>key};export async function getLocale(){return 'en'}" };
  if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function currentUser(){return globalThis.__itemInputSession.user}' };
  if (specifier.startsWith('@/')) return next(root+'web/'+specifier.slice(2)+'.ts',context);
  return next(specifier,context);
}});
const { sql } = await import('drizzle-orm');
const { db, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PATCH } = await import('../app/api/items/[id]/route');
const cases: Array<[string, Record<string, unknown>]> = [
  ['safe integer rate',{defaultRate:75}],
  ['fractional rate',{defaultRate:0.1}],
  ['boolean cost',{defaultCost:false}],
  ['array price',{standaloneSellingPrice:[]}],
  ['object account',{incomeAccountId:{}}],
  ['null name',{name:null}],
  ['string activation',{isActive:'false'}],
  ['numeric tracking flag',{showOnTimesheet:1}],
  ['object description',{description:{}}],
  ['array custom',{custom:[]}],
  ['explicit clear',{defaultRate:null,defaultCost:'',incomeAccountId:null}],
  ['valid edit',{defaultRate:'75.1250',defaultCost:'12.5000',name:'Reviewed item'}],
  ['omitted finance',{description:'New description'}],
];
for (const [label,body] of cases) {
  test(`item input integrity: ${label}`, {skip:!process.env.OPENBOOKS_DB_URL},async()=>{
    const org=await createScratchOrg();
    try {
      const actor=await createScratchUser(org.orgId,'Item controller','reviewer');
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`);
      session.user={id:actor,orgId:org.orgId,name:'Item controller',email:'item@scratch.test',roles:[],isSuperAdmin:false,envKind:'production',productionOrgId:org.orgId,homeOrgId:org.orgId,homeUserId:actor};
      const id=org.items.service;
      await db.execute(sql`update items set default_rate='100',default_cost='40',income_account_id=${org.accounts.revenue} where id=${id}`);
      const before=(await db.execute(sql`select * from items where id=${id}`)).rows[0];
      const accepted=['safe integer rate','explicit clear','valid edit','omitted finance'].includes(label);
      const response=await withOrgContext(org.orgId,()=>PATCH(new Request('http://audit.local/api/items/'+id,{method:'PATCH',body:JSON.stringify(body)}),{params:Promise.resolve({id})}));
      assert.equal(response.status,accepted?200:422,JSON.stringify(await response.json()));
      const after=(await db.execute(sql`select * from items where id=${id}`)).rows[0];
      if(!accepted) assert.deepEqual(after,before,'refused malformed input cannot change the item');
      else if(label==='safe integer rate') {assert.equal(after?.default_rate,'75.0000');assert.equal(after?.default_cost,'40.0000');}
      else if(label==='explicit clear') {assert.equal(after?.default_rate,null);assert.equal(after?.default_cost,null);assert.equal(after?.income_account_id,null);}
      else if(label==='valid edit') {assert.equal(after?.default_rate,'75.1250');assert.equal(after?.default_cost,'12.5000');}
      else {assert.equal(after?.default_rate,'100.0000');assert.equal(after?.default_cost,'40.0000');}
      const audits=(await db.execute<{n:number}>(sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and table_name='items' and row_id=${id}`)).rows[0]!.n;
      assert.equal(audits,accepted?1:0);
    } finally {session.user=null;await dropScratchOrg(org.orgId);}
  });
}
