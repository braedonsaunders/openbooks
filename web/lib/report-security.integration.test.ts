import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
const repo=process.cwd();
const root=pathToFileURL(repo+'/').href;
const state: { user: import('./auth').SessionUser | null } = { user: null };
Object.assign(globalThis, { __reviewState: state });
registerHooks({
 resolve(s,c,next){
  if(s==='server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if(s==='next-intl/server')return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export async function getTranslations(){const t=(s)=>s;t.has=()=>false;return t;}')};
  if((s==='./auth'||s.endsWith('/lib/auth'))&&c.parentURL?.includes('/web/'))return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent('export async function currentUser(){return globalThis.__reviewState.user;}')};
  if(s.startsWith('@/'))return next(root+'web/'+s.slice(2)+'.ts',c);
  return next(s,c);
 }
});
const {db,withBypassContext,withOrgContext}=await import(root+'engine/src/db.ts');
const {sql}=await import(root+'node_modules/drizzle-orm/index.js');
const {createScratchOrg,createScratchUser,dropScratchOrg}=await import(root+'engine/src/test-fixtures.ts');
const {POST:run}=await import(root+'web/app/api/reports/run/route.ts');
const {GET:csv}=await import(root+'web/app/api/reports/runs/[id]/csv/route.ts');
const {POST:schedule}=await import(root+'web/app/api/reports/schedules/route.ts');
const {PATCH:patch}=await import(root+'web/app/api/reports/definitions/[id]/route.ts');
const {getAuthz}=await import(root+'web/lib/authz.ts');
const {statementDefinitionId}=await import(root+'web/lib/custom-reports.ts');
const { snapshotReportAuthorization, scheduledReportAuthz } = await import(root+'web/lib/report-execution-context.ts');
test('report execution, artifacts and schedules enforce original permissions and subsidiary scope', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
 const fixture=await withBypassContext(()=>createScratchOrg());
 const otherFixture=await withBypassContext(()=>createScratchOrg());
 const oid=fixture.orgId;
 try {
 const uid=await withBypassContext(()=>createScratchUser(oid,'Restricted report reader','review_reader'));
 await withBypassContext(async()=>{
  await createScratchUser(otherFixture.orgId,'Other organization administrator','review_other_role');
  await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${otherFixture.orgId} and key='review_other_role'`);
  await db.execute(sql`insert into role_assignments(user_id,org_id,role_id)
    select ${uid},${otherFixture.orgId},id from app_roles where org_id=${otherFixture.orgId} and key='review_other_role'`);
 });
 state.user={id:uid,orgId:oid,isSuperAdmin:false,name:'Restricted reader',email:'review@example.test', roles: [],
   envKind:'production',productionOrgId:oid,homeOrgId:oid,homeUserId:uid};
 await withBypassContext(async()=>{
  await db.execute(sql`update app_roles set permissions='["reports.read","reports.create","reports.schedule"]'::jsonb,
    subsidiary_restriction=${JSON.stringify({mode:'list',subsidiaryIds:[fixture.subsidiaryId]})}::jsonb
    where org_id=${oid} and key='review_reader'`);
  const other=randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${other},${oid},${fixture.subsidiaryId},'Other entity','CAD','CA')`);
  for (const [sub,number] of [[other,'SECRET-ENTITY-B'],[fixture.subsidiaryId,'VISIBLE-ENTITY-A']]) {
    await db.execute(sql`insert into documents (org_id,subsidiary_id,kind,status,document_number,document_date,currency,subtotal,tax_total,total,created_by)
      values (${oid},${sub},'customer_invoice','draft',${number},'2026-07-15','CAD',0,0,0,${uid})`);
  }
 });
 await withOrgContext(oid,async()=>{
  assert.ok(await statementDefinitionId(oid,'true-cost'), 'a new statement materializes before scheduling');
  const request=(body: unknown)=>new Request('http://test.local',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const res=await run(request({query:{entity:'documents',columns:['document_number']},preview:false}));
  assert.equal(res.status,200);
  const text=await res.text();
  assert.ok(text.includes('VISIBLE-ENTITY-A'));
  assert.ok(!text.includes('SECRET-ENTITY-B'));
  const def=randomUUID(),rid=randomUUID(),legacy=randomUUID();
  const definition={kind:'custom',report_type:'query' as const,slug:'review-payroll',name:'Payroll report',
    query:{entity:'pay_stubs',columns:['gross_pay']},statement:null};
  const authz=await getAuthz();
  assert.ok(authz);
  assert.deepEqual(authz.allowedSubsidiaryIds,new Set([fixture.subsidiaryId]), 'another organization cannot widen this scope');
  const snapshot=snapshotReportAuthorization(authz,definition);
  await db.execute(sql`insert into report_definitions (id,org_id,kind,report_type,slug,name,query,created_by)
    values(${def},${oid},'custom','query',${definition.slug},${definition.name},${JSON.stringify(definition.query)}::jsonb,${uid})`);
  for (const [id,evidence] of [[rid,snapshot],[legacy,null]] as const) {
    await db.execute(sql`insert into report_runs(id,org_id,definition_id,trigger,status,result_csv,created_by,authorization_snapshot)
      values(${id},${oid},${def},'manual','succeeded','CONFIDENTIAL_PAYROLL_CSV',${uid},${JSON.stringify(evidence)}::jsonb)`);
  }
  const download=(id:string)=>csv(new Request('http://test.local'),{params:Promise.resolve({id})});
  assert.equal((await download(rid)).status,403);
  const cadence={definitionId:def,cadence:'daily',hour:9,minute:0,timezone:'UTC',recipientEmails:['recipient@example.test'],active:false};
  assert.equal((await schedule(request(cadence))).status,403);
  const rev=await db.execute(sql`select to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from report_definitions where id=${def}`);
  assert.equal((await patch(request({query:{entity:'documents',columns:['document_number']},expectedUpdatedAt:rev.rows[0]!.revision}),{params:Promise.resolve({id:def})})).status,403);
  // An authorized editor can change the definition; this must not relabel old bytes.
  await db.execute(sql`update report_definitions set query='{"entity":"documents","columns":["document_number"]}'::jsonb where id=${def}`);
  assert.equal((await download(rid)).status,403);
  assert.equal((await download(legacy)).status,403);
  await db.execute(sql`update app_roles set permissions='["reports.read","reports.create","reports.schedule","payroll.read"]'::jsonb where org_id=${oid} and key='review_reader'`);
  assert.equal((await download(rid)).status,200);
  const createdSchedule=await schedule(request(cadence));
  assert.equal(createdSchedule.status,201,await createdSchedule.clone().text());
  const created=await createdSchedule.json();
  const audit=await db.execute(sql`select changes from audit_log where org_id=${oid} and table_name='report_schedules' and row_id=${created.schedule.id}`);
  assert.equal(audit.rows.length,1);
  await assert.rejects(db.execute(sql`update report_runs set authorization_snapshot=null where id=${rid} and org_id=${oid}`));
  const active=await scheduledReportAuthz(oid,snapshot);
  assert.deepEqual(active.allowedSubsidiaryIds,new Set([fixture.subsidiaryId]));
  await db.execute(sql`update app_roles set permissions='["reports.read"]'::jsonb where org_id=${oid} and key='review_reader'`);
  await assert.rejects(scheduledReportAuthz(oid,snapshot),/revoked/);
 });
 } finally {
  state.user=null;
  await withBypassContext(()=>dropScratchOrg(otherFixture.orgId));
  await withBypassContext(()=>dropScratchOrg(oid));
 }
});
