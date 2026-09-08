import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {sql} from 'drizzle-orm';
import {db,withOrgTransaction} from './db.ts';
import {seedAdoption,calculatedRun} from './payroll-filing-test-fixtures.ts';
import {createScratchOrg,dropScratchOrgReporting} from './test-fixtures.ts';
import {commitPayRun} from './payroll-run.ts';
import {payrollRemittanceSummary} from './payroll-remittance.ts';
import {reconcilePayrollLiabilityAccounts} from './payroll-liability-reconciliation.ts';

async function fixture(action:(fx:Awaited<ReturnType<typeof seedAdoption>>,rows:{lineId:string;accountId:string;amount:string}[])=>Promise<void>){
 const fx=await seedAdoption();
 try{
  const {input}=await calculatedRun(fx);await commitPayRun(input);
  const rows=(await db.execute<{lineId:string;accountId:string;amount:string}>(sql`select id as "lineId",liability_account_id as "accountId",amount::text from pay_stub_lines where org_id=${fx.orgId} and kind='deduction' and amount<>0 order by id limit 2`)).rows;
  assert.equal(rows.length,2);
  await db.transaction(async tx=>{
   await tx.execute(sql`alter table pay_stub_lines disable trigger pay_stub_line_liability_guard`);
   for(const row of rows)await tx.execute(sql`update pay_stub_lines set liability_account_id=null,liability_account_source='unknown',liability_account_evidence=null where org_id=${fx.orgId} and id=${row.lineId}`);
   await tx.execute(sql`alter table pay_stub_lines enable trigger pay_stub_line_liability_guard`);
  });
  await action(fx,rows);
 }finally{await dropScratchOrgReporting(fx.orgId);}
}
const evidence={reason:'Reviewed original payroll posting',reference:'Controlled archive / payroll register July 2026'};
const range={from:'2026-07-01',to:'2026-07-31'};

test('reviewed liability reconciliation restores remittance evidence once without changing amounts',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(fx,rows)=>{
 const input={orgId:fx.orgId,actorId:fx.actorId,rows:rows.map(r=>({...r,...evidence}))};
 await assert.rejects(payrollRemittanceSummary(fx.orgId,range),/unknown historical liability/i);
 await assert.rejects(withOrgTransaction(fx.orgId,async()=>{assert.equal(await reconcilePayrollLiabilityAccounts(input),2);throw new Error('preview rollback');}),/preview rollback/);
 assert.equal((await db.execute(sql`select id from audit_log where org_id=${fx.orgId} and changes->>'operation'='reconcile_liability_account'`)).rows.length,0);
 assert.equal(await reconcilePayrollLiabilityAccounts(input),2);
 for(const row of rows){
  const result=(await db.execute<{amount:string;liability_account_id:string;liability_account_source:string;liability_account_evidence:typeof evidence}>(sql`select amount::text,liability_account_id,liability_account_source,liability_account_evidence from pay_stub_lines where org_id=${fx.orgId} and id=${row.lineId}`)).rows[0]!;
  assert.equal(result.amount,row.amount);assert.equal(result.liability_account_id,row.accountId);
  assert.equal(result.liability_account_source,'reconciled');assert.deepEqual(result.liability_account_evidence,evidence);
 }
 const audit=(await db.execute<{actor_id:string}>(sql`select actor_id from audit_log where org_id=${fx.orgId} and changes->>'operation'='reconcile_liability_account'`)).rows;
 assert.equal(audit.length,2);assert.ok(audit.every(r=>r.actor_id===fx.actorId));
 assert.ok((await payrollRemittanceSummary(fx.orgId,range)).length);
 await assert.rejects(reconcilePayrollLiabilityAccounts(input),/not unresolved/);
 await assert.rejects(db.execute(sql`update pay_stub_lines set liability_account_evidence='{"reason":"changed","reference":"changed"}'::jsonb where org_id=${fx.orgId} and id=${rows[0]!.lineId}`),/Failed query/);
}));

test('liability reconciliation refuses bad evidence, missing accounts, scope escapes and partially valid batches',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(fx,rows)=>{
 const input={orgId:fx.orgId,actorId:fx.actorId,rows:rows.map(r=>({...r,...evidence}))};
 await assert.rejects(reconcilePayrollLiabilityAccounts({...input,rows:[{...input.rows[0]!,reference:''}]}),/evidence reference/);
 await assert.rejects(reconcilePayrollLiabilityAccounts({...input,rows:[input.rows[0]!,input.rows[0]!]}),/Duplicate/);
 // The second row fails after the first update, inside an ambient transaction
 // whose caller catches the error. Its explicit savepoint must restore both.
 await withOrgTransaction(fx.orgId,async()=>{
  await assert.rejects(reconcilePayrollLiabilityAccounts({...input,rows:[input.rows[0]!,{...input.rows[1]!,accountId:randomUUID()}]}));
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${fx.orgId} and changes->>'operation'='reconcile_liability_account'`)).rows.length,0);
 });
 const foreign=await createScratchOrg();
 try {
  await assert.rejects(reconcilePayrollLiabilityAccounts({...input,rows:[{...input.rows[0]!,accountId:foreign.accounts.ap}]}));
 } finally {await dropScratchOrgReporting(foreign.orgId);}
 await assert.rejects(db.execute(sql`update pay_stub_lines set liability_account_id=${rows[0]!.accountId},liability_account_source='commit' where org_id=${fx.orgId} and id=${rows[0]!.lineId}`),'a historical line cannot masquerade as a new commit');
 await assert.rejects(db.execute(sql`update pay_stub_lines set liability_account_id=${rows[0]!.accountId},liability_account_source='reconciled',liability_account_evidence=${JSON.stringify(evidence)}::jsonb,updated_by=${fx.actorId},amount=amount+1 where org_id=${fx.orgId} and id=${rows[0]!.lineId}`),'reconciliation cannot change payroll money');
 await db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${fx.orgId} and id in(select role_id from role_assignments where org_id=${fx.orgId} and user_id=${fx.actorId})`);
 await assert.rejects(reconcilePayrollLiabilityAccounts(input),/legal-entity scope/);
 await db.execute(sql`update users set is_active=false where org_id=${fx.orgId} and id=${fx.actorId}`);
 await assert.rejects(reconcilePayrollLiabilityAccounts(input),/permission/);
 const remaining=(await db.execute(sql`select id from pay_stub_lines where org_id=${fx.orgId} and liability_account_source='unknown' and kind='deduction' and amount<>0`)).rows;
 assert.equal(remaining.length,2);
}));

test('racing liability reconciliations produce one transition and one audit record',{skip:!process.env.OPENBOOKS_DB_URL},async()=>fixture(async(fx,rows)=>{
 const input={orgId:fx.orgId,actorId:fx.actorId,rows:[{...rows[0]!,...evidence}]};
 const results=await Promise.allSettled([reconcilePayrollLiabilityAccounts(input),reconcilePayrollLiabilityAccounts(input)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal((await db.execute(sql`select id from audit_log where org_id=${fx.orgId} and changes->>'operation'='reconcile_liability_account'`)).rows.length,1);
}));
