import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,context,next){if(specifier==='server-only')return{shortCircuit:true,url:'data:text/javascript,export {}'};return next(specifier,context)}});
const {sql}=await import('drizzle-orm');
const {pathToFileURL}=await import('node:url');
const {db}=await import('@openbooks/engine/src/db.ts');
const {createScratchOrg,dropScratchOrg,seedFlowActors}=await import('@openbooks/engine/src/test-fixtures.ts');
const {setupResource}=await import('./setup-resources.ts');
const {SETUP_ENTITY_BY_KEY}=await import('../setup/registry.ts');

const auth={gate:null as null|{user:{orgId:string,id:string}}};Object.assign(globalThis,{__bookPolicyProbe:auth});
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('/lib/authz')&&context.parentURL?.includes('/api/admin/setup/'))return{shortCircuit:true,url:'data:text/javascript,export async function guardPermission(){return globalThis.__bookPolicyProbe.gate}'};
 if(specifier.startsWith('@/'))return next(pathToFileURL(process.cwd()+'/web/'+specifier.slice(2)+'.ts').href,context);
 return next(specifier,context);
}});
const {POST,PATCH}=await import('../../app/api/admin/setup/[entity]/route.ts');

for(const operation of ['create','update'] as const){
for(const channel of ['interactive','import'] as const){
 test(`${channel} setup ${operation} preserves declared earning defaults`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;auth.gate={user:{orgId:org.orgId,id:actorId}};
   const body:Record<string,unknown>={code:'DEFAULT-FLAGS',name:'Default taxable earning',kind:'earning',value:'10',isActive:true};
   if(operation==='update'){
    const created=(await db.execute(sql`insert into pay_components(org_id,code,name,kind,value,is_active,created_by,updated_by) values(${org.orgId},'DEFAULT-FLAGS','Original earning','earning','10',true,${actorId},${actorId}) returning id`)).rows[0]!;
    body.id=created.id;
   }
   if(channel==='interactive'){
    const response=await (operation==='create'?POST:PATCH)(new Request('http://audit.local/api/admin/setup/pay-components',{method:operation==='create'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({entity:'pay-components'})});
    assert.equal(response.status,200,JSON.stringify(await response.json()));
   }else{
    const outcome=await setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId).write([body],operation==='create'?'insert':'upsert',{orgId:org.orgId,actorId,dryRun:false});
    assert.equal(operation==='create'?outcome.created:outcome.updated,1,JSON.stringify(outcome));
   }
   const stored=(await db.execute(sql`select taxable,pensionable,insurable,vacationable,include_in_disposable_earnings from pay_components where org_id=${org.orgId} and code='DEFAULT-FLAGS'`)).rows[0];
   assert.deepEqual(stored,{taxable:true,pensionable:true,insurable:true,vacationable:true,include_in_disposable_earnings:true});
   const evidence=(await db.execute<{actor_id:string;changes:{after:Record<string,unknown>}}>(sql`select actor_id,changes from audit_log where org_id=${org.orgId} and table_name='pay_components' and changes->'after'->>'code'='DEFAULT-FLAGS'`)).rows;
   assert.equal(evidence.length,1);assert.equal(evidence[0]!.actor_id,actorId);
   for(const [key,value] of Object.entries(stored!))assert.equal(evidence[0]!.changes.after[key],value);
  }finally{auth.gate=null;await dropScratchOrg(org.orgId);}
 });
}

}

for(const channel of ['interactive','import'] as const){
 test(`${channel} setup refuses malformed earning boolean controls`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await createScratchOrg();
  try{
   const actorId=(await seedFlowActors(org.orgId)).adminId;auth.gate={user:{orgId:org.orgId,id:actorId}};
   const body={code:'INVALID-FLAG',name:'Malformed earning',kind:'earning',value:'10',isActive:true,taxable:'false-ish',pensionable:true,insurable:true,vacationable:true,includeInDisposableEarnings:true};
   if(channel==='interactive'){
    const response=await POST(new Request('http://audit.local/api/admin/setup/pay-components',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({entity:'pay-components'})});
    assert.equal(response.status,400,JSON.stringify(await response.json()));
   }else{
    const outcome=await setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId).write([body],'insert',{orgId:org.orgId,actorId,dryRun:false});
    assert.equal(outcome.created,0,JSON.stringify(outcome));assert.equal(outcome.failed,1);
   }
  }finally{auth.gate=null;await dropScratchOrg(org.orgId);}
 });
}

for(const operation of ['create','update'] as const){
 for(const channel of ['interactive','import'] as const){
  test(`${channel} ${operation} preserves explicit earning exemptions`,{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
   const org=await createScratchOrg();
   try{
    const actorId=(await seedFlowActors(org.orgId)).adminId;auth.gate={user:{orgId:org.orgId,id:actorId}};
    const body:Record<string,unknown>={code:'EXPLICIT-FLAGS',name:'Explicit configuration',kind:'earning',value:'10',isActive:true,taxable:false,pensionable:false,insurable:false,vacationable:false,includeInDisposableEarnings:false};
    if(operation==='update')body.id=(await db.execute(sql`insert into pay_components(org_id,code,name,kind,value,created_by,updated_by) values(${org.orgId},'EXPLICIT-FLAGS','Original','earning','10',${actorId},${actorId}) returning id`)).rows[0]!.id;
    if(channel==='interactive'){
     const response=await (operation==='create'?POST:PATCH)(new Request('http://audit.local/api/admin/setup/pay-components',{method:operation==='create'?'POST':'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({entity:'pay-components'})});
     assert.equal(response.status,200,JSON.stringify(await response.json()));
    }else{
     const outcome=await setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId).write([body],operation==='create'?'insert':'upsert',{orgId:org.orgId,actorId,dryRun:false});
     assert.equal(operation==='create'?outcome.created:outcome.updated,1,JSON.stringify(outcome));
    }
    const stored=(await db.execute(sql`select taxable,pensionable,insurable,vacationable,include_in_disposable_earnings from pay_components where org_id=${org.orgId} and code='EXPLICIT-FLAGS'`)).rows[0];
    assert.deepEqual(stored,{taxable:false,pensionable:false,insurable:false,vacationable:false,include_in_disposable_earnings:false});
   }finally{auth.gate=null;await dropScratchOrg(org.orgId);}
  });
 }
}
