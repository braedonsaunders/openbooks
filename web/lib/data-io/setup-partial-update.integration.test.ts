import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '@openbooks/engine/platform/database';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts';
import { setupResource } from './setup-resources';
import { SETUP_ENTITY_BY_KEY } from '../setup/registry';

test('partial component imports preserve existing financial configuration through preview and audited commit', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
 const org = await createScratchOrg();
 try {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const account = (await db.execute<{id:string}>(sql`select id from accounts where org_id=${org.orgId} and is_active limit 1`)).rows[0]!;
  await db.execute(sql`insert into pay_components (org_id,code,name,kind,country,basis,value,expense_account_id,liability_account_id,taxable,pensionable,insurable,vacationable,created_by,updated_by)
   values (${org.orgId},'QUANTITY','Travel allowance','earning','CA','fixed_amount','19.1234',${account.id},${account.id},false,true,false,true,${actorId},${actorId})`);
  const read = async () => (await db.execute(sql`select country,value,expense_account_id,liability_account_id,taxable,pensionable,insurable,vacationable,unit_of_measure
   from pay_components where org_id=${org.orgId} and code='QUANTITY'`)).rows[0]!;
  const before = await read();
  const resource = setupResource(SETUP_ENTITY_BY_KEY.get('pay-components')!,org.orgId);
  const rows = [{code:'QUANTITY',name:'Travel allowance',kind:'earning',basis:'fixed_amount',unitOfMeasure:'quantity'}];
  const preview = await resource.write(rows,'upsert',{orgId:org.orgId,actorId,dryRun:true});
  assert.equal(preview.updated,1,JSON.stringify(preview));
  assert.equal(preview.failed,0);
  assert.deepEqual(await read(),before,'Preview leaves all stored configuration unchanged');
  const committed = await resource.write(rows,'upsert',{orgId:org.orgId,actorId,dryRun:false});
  assert.equal(committed.updated,1,JSON.stringify(committed));
  assert.equal(committed.failed,0);
  assert.deepEqual(await read(),{...before,unit_of_measure:'quantity'});
  const evidence = (await db.execute<{actor_id:string;changes:{before:Record<string,unknown>;after:Record<string,unknown>}}>(sql`select actor_id,changes from audit_log
   where org_id=${org.orgId} and table_name='pay_components' and changes->'after'->>'code'='QUANTITY'`)).rows;
  assert.equal(evidence.length,1);
  assert.equal(evidence[0]!.actor_id,actorId);
  for(const [key,value] of Object.entries(before)) {
   assert.deepEqual(evidence[0]!.changes.before[key],value);
   assert.deepEqual(evidence[0]!.changes.after[key],key==='unit_of_measure'?'quantity':value);
  }
 } finally { await dropScratchOrg(org.orgId); }
});

