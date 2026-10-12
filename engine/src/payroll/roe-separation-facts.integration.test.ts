import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { seedAdoption } from './filing-test-fixtures.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { readRoeSeparationFacts, saveRoeSeparationFacts } from './roe-separation-facts.ts';
const DB=!!process.env.OPENBOOKS_DB_URL;
const declaration={ interruptionOn:'2026-05-09',lastInsurableEarningsOn:'2026-05-08',salaryContinuanceEndOn:null,
 sourceReference:'Original employer separation record, Block 11',reason:'Record the confirmed interruption facts',
 status:'draft' as const,expectedId:null,expectedUpdatedAt:null };

test('native separation facts preserve source and audit, confirm explicitly and refuse stale edits', {skip:!DB},async()=>{
 const f=await withBypassContext(seedAdoption);
 try{await withOrgContext(f.orgId,async()=>{
  const scope={orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,allowedSubsidiaryIds:null};
  assert.equal(await readRoeSeparationFacts(scope),null);
  const draft=await saveRoeSeparationFacts({...scope,...declaration});
  assert.equal(draft.status,'draft');assert.equal(draft.lastInsurableEarningsOn,'2026-05-08');
  assert.equal(draft.sourceReference,declaration.sourceReference);
  assert.deepEqual(await readRoeSeparationFacts(scope),draft);
  const confirmed=await saveRoeSeparationFacts({...scope,...declaration,status:'confirmed',expectedId:draft.id,expectedUpdatedAt:draft.updatedAt});
  assert.equal(confirmed.id,draft.id);assert.equal(confirmed.status,'confirmed');assert.notEqual(confirmed.updatedAt,draft.updatedAt);
  const audit=(await db.execute<{actor_id:string;changes:Record<string,unknown>}>(sql`select actor_id,changes from audit_log
   where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${draft.id} order by at,id`)).rows;
  assert.equal(audit.length,2);assert.ok(audit.every(a=>a.actor_id===f.actorId));
  assert.equal(audit[1]!.changes.sourceReference,declaration.sourceReference);
  const retried=await saveRoeSeparationFacts({...scope,...declaration,status:'confirmed',expectedId:confirmed.id,expectedUpdatedAt:confirmed.updatedAt});
  assert.deepEqual(retried,confirmed);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int n from audit_log where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${draft.id}`)).rows[0]!.n,2);
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,interruptionOn:'2026-05-10',expectedId:draft.id,expectedUpdatedAt:draft.updatedAt}),/Separation facts changed/);
  assert.deepEqual(await readRoeSeparationFacts(scope),confirmed);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});

test('native separation facts refuse impossible dates and out-of-scope identities without writing', {skip:!DB},async()=>{
 const f=await withBypassContext(seedAdoption),other=await withBypassContext(seedAdoption);
 try{await withOrgContext(f.orgId,async()=>{
  const scope={orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,allowedSubsidiaryIds:null};
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,lastInsurableEarningsOn:'2026-05-10'}),/precede or equal/);
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,salaryContinuanceEndOn:'2026-05-07'}),/precede or equal/);
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,employeePartyId:other.employeeId}),/Canadian employee/);
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,allowedSubsidiaryIds:new Set<string>()}),/Canadian employee/);
  assert.equal(await readRoeSeparationFacts(scope),null);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int n from payroll_roe_separation_events where org_id=${f.orgId}`)).rows[0]!.n,0);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));await withBypassContext(()=>dropScratchOrgReporting(other.orgId));}
});

test('issued separation facts remain immutable through the native authoring command', {skip:!DB},async()=>{
 const f=await withBypassContext(seedAdoption);
 try{await withOrgContext(f.orgId,async()=>{
  const scope={orgId:f.orgId,actorId:f.actorId,employeePartyId:f.employeeId,allowedSubsidiaryIds:null};
  const saved=await saveRoeSeparationFacts({...scope,...declaration,status:'confirmed'});
  // Retained issued data is an external filing boundary, not an editable draft.
  await db.execute(sql`update payroll_roe_separation_events set status='issued' where org_id=${f.orgId} and id=${saved.id}`);
  const issued=await readRoeSeparationFacts(scope);assert.equal(issued!.status,'issued');
  await assert.rejects(saveRoeSeparationFacts({...scope,...declaration,expectedId:issued!.id,expectedUpdatedAt:issued!.updatedAt}),/recorded as issued/);
  assert.deepEqual(await readRoeSeparationFacts(scope),issued);
  assert.equal((await db.execute<{n:number}>(sql`select count(*)::int n from audit_log where org_id=${f.orgId} and table_name='payroll_roe_separation_events' and row_id=${saved.id}`)).rows[0]!.n,1);
 });}finally{await withBypassContext(()=>dropScratchOrgReporting(f.orgId));}
});
