import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { assertDedicatedFixtureDatabase, createScratchOrg, dropScratchOrgReporting,
  seedFlowActors, seedPostingAccount } from '../testing/fixtures.ts';
import { seedPayrollComponents } from './run-setup.ts';
import { packSlotState } from './packs.ts';

const DB = !!process.env.OPENBOOKS_DB_URL;
const migration = readFileSync(new URL('../../../schema/migrations/generated/0768_payroll_statutory_account_configuration.sql', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../../../schema/migrations/preflight/0768_payroll_statutory_account_configuration.sql', import.meta.url), 'utf8');

async function snapshot(orgId: string) {
  return (await db.execute(sql`select jsonb_build_object('payroll',settings->'payroll',
    'components',(select jsonb_agg(to_jsonb(p) order by id) from pay_components p where p.org_id=o.id),
    'audit',(select jsonb_agg(to_jsonb(a) order by id) from audit_log a where a.org_id=o.id)) as state
    from orgs o where id=${orgId}`)).rows;
}

test('statutory configuration migration preserves explicit mappings and audits the retired source', { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await seedPayrollComponents(org.orgId, actor, 'CA');
    const explicit = await seedPostingAccount(org.orgId, '2380', 'Native statutory liability', 'liability_current_other');
    const retained = await seedPostingAccount(org.orgId, '2381', 'Configured CPP liability', 'liability_current_other');
    await db.execute(sql`update pay_components set liability_account_id=${explicit} where org_id=${org.orgId} and country='CA'`);
    await db.execute(sql`update pay_components set liability_account_id=null
      where org_id=${org.orgId} and country='CA' and system_key='cpp' and kind='deduction'`);
    const original = { cppPayableAccountId: retained, taxPayableAccountId: 'unusable-unused-configuration',
      eiPayableAccountId: explicit, vacationPayableAccountId: explicit, supplementalTaxMethod: 'per_run' };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll}',${JSON.stringify(original)}::jsonb) where id=${org.orgId}`);
    assert.equal((await packSlotState(org.orgId,['CA'])).find(pack=>pack.country==='CA')?.slots.find(slot=>slot.key==='cpp')?.accountId,null,
      'retained organization keys cannot satisfy a missing native component mapping');
    assert.deepEqual((await db.execute(sql.raw(preflight))).rows,[]);
    await db.transaction(async tx=>{ await tx.execute(sql.raw(migration)); });
    const payroll=(await db.execute<{payroll:unknown}>(sql`select settings->'payroll' as payroll from orgs where id=${org.orgId}`)).rows[0]!.payroll;
    assert.deepEqual(payroll,{supplementalTaxMethod:'per_run'});
    const components=(await db.execute<{kind:string;system_key:string;account:string}>(sql`select kind,system_key,liability_account_id::text as account
      from pay_components where org_id=${org.orgId} and country='CA'`)).rows;
    assert.equal(components.find(row=>row.system_key==='cpp'&&row.kind==='deduction')?.account,retained);
    assert.ok(components.filter(row=>row.system_key!=='cpp'||row.kind!=='deduction').every(row=>row.account===explicit),
      'an explicit native account always survives normalization');
    const evidence=(await db.execute<{changes:{before:{payroll:unknown};after:{payroll:unknown}}}>(sql`select changes from audit_log
      where org_id=${org.orgId} and table_name='orgs' and changes->>'reason'='Use native country-pack component accounts for statutory liabilities'`)).rows;
    assert.equal(evidence.length,1);
    assert.deepEqual(evidence[0]!.changes.before.payroll,original);
    assert.deepEqual(evidence[0]!.changes.after.payroll,payroll);
    const beforeReplay=await snapshot(org.orgId);
    await db.transaction(async tx=>{ await tx.execute(sql.raw(migration)); });
    assert.deepEqual(await snapshot(org.orgId),beforeReplay,'a repeated normalization changes no configuration or audit');
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test('an unresolved statutory account refuses normalization atomically', { skip: !DB }, async () => {
  await assertDedicatedFixtureDatabase();
  const org=await createScratchOrg();
  try {
    const actor=(await seedFlowActors(org.orgId)).adminId;
    await seedPayrollComponents(org.orgId,actor,'CA');
    await db.execute(sql`update pay_components set liability_account_id=null
      where org_id=${org.orgId} and country='CA' and system_key='cpp' and kind='deduction'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{payroll}','{"cppPayableAccountId":"unknown"}'::jsonb) where id=${org.orgId}`);
    const issues=(await db.execute<{code:string;severity:string}>(sql.raw(preflight))).rows;
    assert.ok(issues.some(issue=>issue.code==='0768.unresolved_statutory_component_account'&&issue.severity==='refuse'));
    const before=await snapshot(org.orgId);
    await assert.rejects(db.transaction(async tx=>{ await tx.execute(sql.raw(migration)); }),error=>{
      for(let cause:unknown=error;cause&&typeof cause==='object';cause=(cause as {cause?:unknown}).cause) {
        const detail=cause as {code?:string;message?:string};
        if(detail.code==='P0001'&&detail.message?.includes('map the statutory slot'))return true;
      }
      return false;
    });
    assert.deepEqual(await snapshot(org.orgId),before,'a refused normalization preserves source configuration and audit');
  } finally { await dropScratchOrgReporting(org.orgId); }
});
