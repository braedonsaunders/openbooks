import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { seedAdoption } from './filing-test-fixtures.ts';
import { createPayRun } from './run-lifecycle.ts';
import { calculatePayRun } from './run-calculation.ts';
import { mutatePayRunAdjustment } from './run-adjustments.ts';

test('missing vacation terms refuse eligible earnings but do not invent accruals on excluded earnings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const f = await withBypassContext(() => seedAdoption());
  try {
    await withBypassContext(() => db.execute(sql`delete from payroll_vacation_terms where org_id=${f.orgId} and employment_id=${f.employmentId}`));
    await withOrgContext(f.orgId, async () => {
      const run = await createPayRun({ orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: '2026-07-01', periodEnd: '2026-07-07', payDate: '2026-07-08' });
      const input = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
      const components = (await db.execute<{ id: string; system_key: string }>(sql`select id,system_key from pay_components
        where org_id=${f.orgId} and system_key in ('base_pay','allowance')`)).rows;
      const base = components.find(row => row.system_key === 'base_pay')!.id;
      await mutatePayRunAdjustment({ ...input, mutation: { action: 'add', employeePartyId: f.employeeId, componentId: base, amount: '1000' } });
      assert.match((await calculatePayRun(input)).errors[0]!.message, /effective vacation terms.*Benefits/);
      await db.execute(sql`update pay_components set vacationable=false where org_id=${f.orgId} and id=${base}`);
      assert.deepEqual((await calculatePayRun(input)).errors, []);
      const stub = (await db.execute<{ vacation_accrued: string }>(sql`select vacation_accrued::text from pay_stubs
        where org_id=${f.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
      assert.equal(stub.vacation_accrued, '0.0000');
      assert.equal((await db.execute(sql`select id from entitlement_ledger where org_id=${f.orgId}
        and pay_run_document_id=${run.documentId} and kind='accrual'`)).rows.length, 0);
      const allowance = components.find(row => row.system_key === 'allowance')!.id;
      await db.execute(sql`update pay_components set vacationable=true where org_id=${f.orgId} and id=${allowance}`);
      await mutatePayRunAdjustment({ ...input, mutation: { action: 'add', employeePartyId: f.employeeId, componentId: allowance, amount: '10' } });
      assert.match((await calculatePayRun(input)).errors[0]!.message, /effective vacation terms.*Benefits/);
    });
  } finally { await withBypassContext(() => dropScratchOrgReporting(f.orgId)); }
});
