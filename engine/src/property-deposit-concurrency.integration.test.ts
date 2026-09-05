import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withOrg } from './db.ts';
import { createScratchOrg, dropScratchOrg, seedFlowActors } from './test-fixtures.ts';
import { depositBalance, recordSecurityDeposit, reverseSecurityDepositTransaction } from './property-management.ts';

// Keep one completed refund uncommitted while a competing reversal attempts
// its balance read. The waiter must block on the same lease aggregate.
test('deposit reversal and refund cannot spend the same tenant balance', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  let release: () => void = () => {};
  let held: Promise<unknown> | undefined;
  let contender: Promise<unknown> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const propertyId = randomUUID(), leaseId = randomUUID();
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"propertyManagement":true}'::jsonb) where id=${org.orgId}`);
    await db.execute(sql`insert into managed_properties
      (id,org_id,subsidiary_id,location_id,code,name,property_type,status,currency,rent_income_account_id,deposit_liability_account_id,default_bank_account_id)
      values (${propertyId},${org.orgId},${org.subsidiaryId},${org.locationId},'DEPOSIT','Deposit concurrency','commercial','active','CAD',${org.accounts.revenue},${org.accounts.deferred},${org.accounts.bank})`);
    await db.execute(sql`insert into property_leases (id,org_id,property_id,tenant_id,lease_number,status,starts_on)
      values (${leaseId},${org.orgId},${propertyId},${org.customerId},'DEPOSIT','active',${org.date})`);
    const input = { orgId: org.orgId, actorId, leaseId, occurredOn: org.date };
    const first = await recordSecurityDeposit({ ...input, kind: 'received', amount: '100' });
    await recordSecurityDeposit({ ...input, kind: 'received', amount: '100' });
    let staged!: () => void;
    const ready = new Promise<void>(resolve => { staged = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    held = withOrg(org.orgId, async () => {
      await recordSecurityDeposit({ ...input, kind: 'refunded', amount: '150' });
      staged();
      await hold;
    });
    await Promise.race([ready, held]);
    let settled = false;
    let contenderPid = 0;
    contender = withOrg(org.orgId, async () => {
      contenderPid = (await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      return reverseSecurityDepositTransaction({ ...input, transactionId: first.id, reason: 'Reverse mistaken duplicate receipt' });
    });
    void contender.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 10_000;
    let locked = false;
    while (!settled && Date.now() < deadline) {
      locked = (await db.execute<{ blocked: boolean }>(sql`select exists(
        select 1 from pg_stat_activity where datname=current_database() and pid=${contenderPid}
          and wait_event_type='Lock'
      ) as blocked`)).rows[0]!.blocked;
      if (locked) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(settled || locked, 'competing reversal must finish or reach the lease lock');
    release();
    const results = await Promise.allSettled([held, contender]);
    assert.equal(results[0]!.status, 'fulfilled');
    assert.equal(results[1]!.status, 'rejected', 'reversal must observe the committed refund and refuse an overdraft');
    const rows = (await db.execute<{ kind: string; amount: string }>(sql`select kind,amount from security_deposit_transactions where org_id=${org.orgId} and lease_id=${leaseId}`)).rows;
    assert.equal(depositBalance(rows), '50.0000');
  } finally {
    release();
    await Promise.allSettled([held, contender]);
    await dropScratchOrg(org.orgId);
  }
});
