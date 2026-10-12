import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../../platform/db.ts';
import { dropScratchOrgReporting } from '../../testing/fixtures.ts';
import { seedAdoption } from '../filing-test-fixtures.ts';
import { createPayRun } from '../run-lifecycle.ts';
import { calculatePayRun } from '../run-calculation.ts';
import { commitPayRun } from '../run-commit.ts';
import { mutatePayRunAdjustment } from '../run-adjustments.ts';

test('separate Option 1 bonus references committed regular income without paying or withholding regular pay twice', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    await withBypassContext(async () => {
      await db.execute(sql`update pay_schedules set frequency='monthly',periods_per_year=12,anchor_period_end='2026-01-31',pay_date_offset_days=0 where org_id=${fx.orgId} and id=${fx.scheduleId}`);
      await db.execute(sql`update employee_payroll_profiles set cpp_exempt=true,ei_exempt=true where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`);
    });
    await withOrgContext(fx.orgId, async () => {
      const components = (await db.execute<{ id: string; system_key: string }>(sql`select id,system_key from pay_components where org_id=${fx.orgId} and system_key in ('base_pay','bonus')`)).rows;
      const create = async (start: string, end: string, amount: string, type: 'regular' | 'bonus') => {
        const run = await createPayRun({ orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId, periodStart: start, periodEnd: end, payDate: end, runType: type });
        const command = { orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId };
        await mutatePayRunAdjustment({ ...command, mutation: { action: 'add', employeePartyId: fx.employeeId, componentId: components.find(c => c.system_key === (type === 'bonus' ? 'bonus' : 'base_pay'))!.id, amount, replaceComponent: true, idempotencyKey: randomUUID() } });
        return command;
      };
      const bonus = await create('2026-02-01', '2026-02-28', '10000', 'bonus');
      const missing = await calculatePayRun(bonus);
      assert.equal(missing.errors.length, 1);
      assert.match(missing.errors[0]!.message, /no committed regular income.*calculate and commit its regular pay/);
      await assert.rejects(commitPayRun(bonus), /refused at calculation/);
      const regular = await create('2026-01-01', '2026-01-31', '5000', 'regular');
      assert.deepEqual((await calculatePayRun(regular)).errors, []);
      await commitPayRun(regular);
      const prior = (await db.execute<{ id: string; factors: Record<string, string>; gross: string; net_pay: string }>(sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${regular.documentId}`)).rows[0]!;
      // A newer calculated regular run must not supply unpaid remuneration.
      const draft = await create('2026-02-01', '2026-02-28', '9000', 'regular');
      assert.deepEqual((await calculatePayRun(draft)).errors, []);
      assert.deepEqual((await calculatePayRun(bonus)).errors, []);
      const stub = (await db.execute<{ id: string; factors: Record<string, string>; gross: string; net_pay: string }>(sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${bonus.documentId}`)).rows[0]!;
      assert.equal(stub.gross, '10000.0000');
      assert.equal(stub.factors.I, '0.0000');
      assert.equal(stub.factors.B, '10000.0000');
      assert.equal(stub.factors.CA_BONUS_I_REFERENCE, '5000.0000');
      assert.equal(stub.factors.CA_BONUS_REFERENCE_STUB, prior.id);
      assert.equal(stub.factors.CA_BONUS_REFERENCE_RUN, regular.documentId);
      assert.equal(stub.factors.A, '70000.0000');
      assert.equal(stub.factors.A_step2, '60000.0000');
      // 2026 Ontario: federal 20.5% + provincial 9.15% over this interval;
      // personal credits and the $600 health premium cancel between legs.
      assert.equal(stub.factors.TB, '2965.0000');
      assert.equal(stub.net_pay, '7035.0000');
      assert.equal(stub.factors.C, '0.0000');
      assert.equal(stub.factors.EI, '0.0000');
      await commitPayRun(bonus);
      const retained = (await db.execute(sql`select id,factors,gross::text,net_pay::text from pay_stubs where org_id=${fx.orgId} and id=${prior.id}`)).rows[0];
      assert.deepEqual(retained, prior);
      assert.equal((await db.execute(sql`select count(*)::integer n from pay_stub_lines where org_id=${fx.orgId} and stub_id=${stub.id} and kind='earning' and amount>0`)).rows[0]?.n, 1);
    });
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(fx.orgId));
  }
});
