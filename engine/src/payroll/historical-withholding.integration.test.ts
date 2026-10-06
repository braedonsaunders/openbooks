import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext } from '../platform/db.ts';
import { withSimClock } from '../platform/clock.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { seedAdoption } from './filing-test-fixtures.ts';
import { createPayRun } from './run-lifecycle.ts';
import { calculatePayRun } from './run-calculation.ts';
import { commitPayRun } from './run-commit.ts';
import { mutatePayRunAdjustment } from './run-adjustments.ts';
import { historicalWithholdingProfile, recordHistoricalWithholding } from './historical-withholding.ts';
import { storedTaxCertificates } from './run-calculation-support.ts';
import { add } from '../money/money.ts';

const skip = !process.env.OPENBOOKS_DB_URL;
test('dated withholding inputs restore the actual request, stale drafts and preserve current and posted settings', { skip }, async () => {
  const f = await withBypassContext(() => seedAdoption());
  try {
    await withBypassContext(() => db.execute(sql`update employee_payroll_profiles set additional_tax_per_period=75
      where org_id=${f.orgId} and employee_party_id=${f.employeeId}`));
    await withSimClock('2026-07-21', () => withOrgContext(f.orgId, async () => {
      const run = await createPayRun({ orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: '2026-07-01', periodEnd: '2026-07-07', payDate: '2026-07-08' });
      const command = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
      const base = (await db.execute<{ id: string }>(sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`)).rows[0]!;
      await mutatePayRunAdjustment({ ...command, mutation: { action: 'add', employeePartyId: f.employeeId, componentId: base.id, amount: '1000' } });
      const money = async () => (await db.execute<{ net_pay: string; factors: Record<string, string> }>(sql`
        select net_pay::text, factors from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
      assert.deepEqual((await calculatePayRun(command)).errors, []);
      const before = await money();
      const input = { orgId: f.orgId, actorId: f.actorId, employeePartyId: f.employeeId, country: 'CA',
        certificateKey: 'ca_td1', answers: { additional_tax_per_period: '50' }, expectedCurrent: { additional_tax_per_period: '75' },
        effectiveFrom: '2026-07-08', effectiveTo: '2026-07-08', reason: 'Dated provider request: original paid card',
        allowedSubsidiaryIds: null, dryRun: true };
      assert.equal((await recordHistoricalWithholding(input)).changed, true);
      assert.equal((await storedTaxCertificates(db, f.orgId, f.employeeId, 'CA')).length, 0);
      const saved = await recordHistoricalWithholding({ ...input, dryRun: false });
      assert.ok(saved.id);
      await assert.rejects(commitPayRun(command), /recalculate/i);
      assert.deepEqual((await calculatePayRun(command)).errors, []);
      const after = await money();
      assert.equal(after.factors.L, '50.0000');
      assert.equal(after.net_pay, add(before.net_pay, '25'));
      const profile = (await db.execute<Record<string, string | null>>(sql`select * from employee_payroll_profiles
        where org_id=${f.orgId} and employee_party_id=${f.employeeId}`)).rows[0]!;
      assert.equal(profile.additional_tax_per_period, '75.0000');
      const stored = await storedTaxCertificates(db, f.orgId, f.employeeId, 'CA');
      for (const date of ['2026-07-07', '2026-07-09']) assert.equal(historicalWithholdingProfile({
        country: 'CA', profile, stored, payDate: date }).additional_tax_per_period, '75.0000');
      assert.equal((await recordHistoricalWithholding({ ...input, dryRun: false })).changed, false);
      await assert.rejects(recordHistoricalWithholding({ ...input, answers: { additional_tax_per_period: '49' } }), /already covers/);
      await assert.rejects(recordHistoricalWithholding({ ...input, expectedCurrent: { additional_tax_per_period: '74' } }), /current.*differs/);
      await assert.rejects(recordHistoricalWithholding({ ...input, effectiveTo: '2026-07-21' }), /end before today/);
      await assert.rejects(recordHistoricalWithholding({ ...input, answers: { additional_tax_per_period: '50,25' } }), /decimal/i);
      await assert.rejects(recordHistoricalWithholding({ ...input, actorId: f.actorId, allowedSubsidiaryIds: new Set() }));
      await commitPayRun(command);
      const next = await createPayRun({ orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: '2026-07-08', periodEnd: '2026-07-14', payDate: '2026-07-15' });
      const nextCommand = { ...command, documentId: next.documentId };
      await mutatePayRunAdjustment({ ...nextCommand, mutation: { action: 'add', employeePartyId: f.employeeId, componentId: base.id, amount: '1000' } });
      assert.deepEqual((await calculatePayRun(nextCommand)).errors, []);
      const nextFactors = (await db.execute<{ factors: Record<string, string> }>(sql`select factors from pay_stubs
        where org_id=${f.orgId} and pay_run_document_id=${next.documentId}`)).rows[0]!.factors;
      assert.equal(nextFactors.L, '75.0000');
      await commitPayRun(nextCommand);
      await assert.rejects(recordHistoricalWithholding({ ...input,
        effectiveFrom: '2026-07-15', effectiveTo: '2026-07-15' }), /committed.*controlled correction/);
      const audit = (await db.execute<{ actor_id: string; changes: Record<string, unknown> }>(sql`select actor_id,changes from audit_log
        where org_id=${f.orgId} and table_name='employee_tax_certificates' and row_id=${saved.id}`)).rows;
      assert.equal(audit.length, 1); assert.equal(audit[0]!.actor_id, f.actorId);
      assert.equal(audit[0]!.changes.reason, input.reason);
      assert.equal(audit[0]!.changes.kind, 'historical_withholding_input');
    }));
  } finally { await withBypassContext(() => dropScratchOrgReporting(f.orgId)); }
});
