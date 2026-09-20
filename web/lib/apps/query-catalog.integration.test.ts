import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { sql } from 'drizzle-orm'
registerHooks({ resolve(s,c,n) { if(s==='server-only') return {url:'data:text/javascript,export{}',shortCircuit:true}; return n(s,c) } })
const { db, pool, withOrgTransaction } = await import('@openbooks/engine/src/platform/db.ts')
const { createAppPlatformAdapter } = await import('./platform')
const { reportEntityCatalog, validateCatalogReportQuery } = await import('../custom-record-report-catalog')

/** Real service calls, but fixture tables exist only in this one PostgreSQL session. */
test('custom source publication, audience, app grants and schema drift are enforced at execution', {skip:!process.env.OPENBOOKS_DB_URL}, async()=>{
  const orgId=randomUUID(),userId=randomUUID(),typeId=randomUUID(),otherOrg=randomUUID()
  const user={id:userId,email:'query-fixture@example.test',name:'Query fixture',orgId,roles:[],isSuperAdmin:false,homeUserId:userId,homeOrgId:orgId,productionOrgId:orgId,envKind:'production' as const}
  const authz={user,permissions:new Set(['records.read']),allowedSubsidiaryIds:null}
  try { await withOrgTransaction(orgId,async()=>{
    await db.execute(sql`create temp table custom_record_types (like public.custom_record_types including defaults) on commit drop`)
    await db.execute(sql`create temp table custom_records (like public.custom_records including defaults) on commit drop`)
    await db.execute(sql`set local search_path=pg_temp,public`)
    const fields=[{id:'header',title:'Details',fields:[{id:'hours',type:'number',label:'Hours'},{id:'related',type:'text',label:'Related'}]}]
    await db.execute(sql`insert into custom_record_types(id,org_id,key,name,plural_name,fields,status) values(${typeId},${orgId},'query-fixture','Query fixture','Query fixtures',${JSON.stringify(fields)}::jsonb,'published')`)
    for(const [org,n] of [[orgId,'10.25'],[otherOrg,'999']] as const) await db.execute(sql`insert into custom_records(id,org_id,type_id,type_key,record_number,status,data) values(${randomUUID()},${org},${typeId},'query-fixture','QA-1','active',${JSON.stringify({hours:n,related:'QA-1'})}::jsonb)`)
    await db.execute(sql`insert into custom_records(id,org_id,type_id,type_key,record_number,status,data) values(${randomUUID()},${orgId},${typeId},'query-fixture','QA-2','active','{"hours":"2","related":"QA-2"}'::jsonb)`)
    const context={orgId,user,grantedPermissions:['records.read'],userCan:(p:string)=>p==='records.read',allowedSubsidiaryIds:null}
    const platform=createAppPlatformAdapter(context)
    const plan={from:{type:'query-fixture',as:'a'},joins:[{type:'query-fixture',as:'b',kind:'inner',on:{left:{source:'a',field:'related'},right:{source:'b',field:'record_number'}}}],select:[{source:'a',field:'hours'},{source:'b',field:'hours'}],sorts:[{column:'a.hours',direction:'asc'}]}
    const result=await platform.query!(plan) as {records:Record<string,unknown>[]}
    assert.deepEqual(result.records,[{'a.hours':'2','b.hours':'2'},{'a.hours':'10.25','b.hours':'10.25'}])
    const list=await platform.list('query-fixture',{sort:{field:'hours',direction:'asc'}}) as {records:{data:{hours:string}}[]}
    assert.deepEqual(list.records.map(r=>r.data.hours),['2','10.25'])
    await assert.rejects(()=>createAppPlatformAdapter({...context,grantedPermissions:[]}).query!(plan),/unavailable/)
    const catalog=await reportEntityCatalog(authz)
    assert.ok(catalog['custom:query-fixture'])
    assert.throws(()=>validateCatalogReportQuery({entity:'custom:query-fixture',mode:'summarize',columns:[],measures:[{fn:'sum',column:'field_removed'}]},catalog),/field changed/)
    await db.execute(sql`update custom_record_types set allowed_roles='["private-role"]'::jsonb where id=${typeId}`)
    assert.equal((await reportEntityCatalog(authz))['custom:query-fixture'],undefined)
    await assert.rejects(()=>platform.query!(plan),/unavailable/)
    await db.execute(sql`update custom_record_types set allowed_roles=null,status='archived' where id=${typeId}`)
    assert.equal((await reportEntityCatalog(authz))['custom:query-fixture'],undefined)
    await assert.rejects(()=>platform.query!(plan),/unavailable/)
  }) } finally { await pool.end() }
})
