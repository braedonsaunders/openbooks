import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgContext, withOrgTransaction } from '../platform/db.ts';
import { withSimClock } from '../platform/clock.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { seedAdoption, seedHiredEmployee } from './filing-test-fixtures.ts';
import { exportedPayrollEvidence } from '../testing/dsar-fixture.ts';
import { upsertPayrollEmployerFact } from './employer-fact-store.ts';
import { recordHistoricalEmployerAssignment, employeeEmployerAssignmentHistory, lockEmployerAssignmentProfiles } from './employer-assignment-history.ts';
import { createPayRun } from './run-lifecycle.ts';
import { calculatePayRun } from './run-calculation.ts';
import { commitPayRun } from './run-commit.ts';
import { mutatePayRunAdjustment } from './run-adjustments.ts';
import { setPackSlotAccount } from './packs.ts';
import { cmp, mul, roundMoney } from '../money/money.ts';

const skip = !process.env.OPENBOOKS_DB_URL;
test('dated employer assignments change only their recorded pay dates, stale drafts and retain current and posted evidence', { skip }, async () => {
  const f = await withBypassContext(() => seedAdoption());
  try {
    const standard = randomUUID(), reduced = randomUUID(), group = randomUUID();
    await withBypassContext(async () => {
      for (const [id, number] of [[standard, '111111111RP0002'], [reduced, '111111111RP0001']]) {
        await db.execute(sql`insert into payroll_filing_accounts(id,org_id,country,program_type,account_number,name,created_by,updated_by)
          values(${id},${f.orgId},'CA','ca_rp',${number},${number},${f.actorId},${f.actorId})`);
      }
      await db.execute(sql`update employee_payroll_profiles set filing_account_id=${standard} where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
      await db.execute(sql`insert into worker_comp_groups(id,org_id,code,name,rate_percent,max_assessable,created_by,updated_by)
        values(${group},${f.orgId},'CLASS','Dated classification','1.32','121700',${f.actorId},${f.actorId})`);
    });
    await withSimClock('2026-07-21', () => withOrgContext(f.orgId, async () => {
      for (const [id, value] of [[standard, '1.4'], [reduced, '1.167']]) await upsertPayrollEmployerFact({
        orgId: f.orgId, actorId: f.actorId, country: 'CA', filingAccountId: id!, factKey: 'ei_employer_multiplier',
        effectiveFrom: '2026-01-01', value: value!, changeReason: 'Dated employer account approval',
      });
      const liability = (await db.execute<{ id: string }>(sql`select (settings->'payroll'->>'eiPayableAccountId') as id from orgs where id=${f.orgId}`)).rows[0]!.id;
      await setPackSlotAccount(f.orgId, f.actorId, 'CA', 'wcb', liability);
      const run = await createPayRun({ orgId: f.orgId, actorId: f.actorId, payScheduleId: f.scheduleId,
        periodStart: '2026-07-01', periodEnd: '2026-07-07', payDate: '2026-07-08' });
      const command = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
      const component = (await db.execute<{ id: string }>(sql`select id from pay_components where org_id=${f.orgId} and system_key='base_pay'`)).rows[0]!.id;
      await mutatePayRunAdjustment({ ...command, mutation: { action: 'add', employeePartyId: f.employeeId, componentId: component, amount: '1000' } });
      const stub = async () => (await db.execute<{ filing_account_id: string; factors: Record<string, string> }>(sql`
        select filing_account_id,factors from pay_stubs where org_id=${f.orgId} and pay_run_document_id=${run.documentId}`)).rows[0]!;
      assert.deepEqual((await calculatePayRun(command)).errors, []);
      const before = await stub();
      const input = { orgId: f.orgId, actorId: f.actorId, employeePartyId: f.employeeId, kind: 'filing_account' as const,
        assignmentId: reduced, expectedCurrentId: standard, effectiveFrom: '2026-07-08', effectiveTo: '2026-07-08',
        sourceReference: 'Original July payroll account report', reason: 'Restore the account used on the original pay date',
        allowedSubsidiaryIds: null, dryRun: true };
      assert.equal((await recordHistoricalEmployerAssignment(input)).changed, true);
      assert.deepEqual(await employeeEmployerAssignmentHistory(db, { orgId: f.orgId, payDate: input.effectiveFrom, employeePartyIds: [f.employeeId] }), []);
      const saved = await recordHistoricalEmployerAssignment({ ...input, dryRun: false });
      assert.ok(saved.id);
      await assert.rejects(commitPayRun(command), /recalculate/i);
      const worker = { ...input, kind: 'worker_comp' as const, assignmentId: group, expectedCurrentId: null };
      assert.equal((await recordHistoricalEmployerAssignment({ ...worker, dryRun: false })).changed, true);
      assert.deepEqual((await calculatePayRun(command)).errors, []);
      const after = await stub();
      assert.equal(before.filing_account_id, standard); assert.equal(after.filing_account_id, reduced);
      assert.equal(after.factors.EI, before.factors.EI);
      assert.equal(after.factors.EI_ER, roundMoney(mul(after.factors.EI!, '1.167'), 2));
      assert.equal(before.factors.EI_ER, roundMoney(mul(before.factors.EI!, '1.4'), 2));
      const wcb = (await db.execute<{ amount: string }>(sql`select l.amount::text from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
        join pay_components c on c.org_id=l.org_id and c.id=l.component_id where s.org_id=${f.orgId} and s.pay_run_document_id=${run.documentId} and c.system_key='wcb'`)).rows[0];
      assert.ok(wcb && cmp(wcb.amount, '0') > 0);
      const current = (await db.execute<{ filing_account_id: string; worker_comp_group_id: string | null }>(sql`
        select p.filing_account_id,r.worker_comp_group_id from employee_payroll_profiles p join employee_roles r on r.org_id=p.org_id and r.party_id=p.employee_party_id
        where p.org_id=${f.orgId} and p.employee_party_id=${f.employeeId}`)).rows[0]!;
      assert.equal(current.filing_account_id, standard); assert.equal(current.worker_comp_group_id, null);
      assert.equal((await recordHistoricalEmployerAssignment({ ...input, dryRun: false })).changed, false);
      await assert.rejects(recordHistoricalEmployerAssignment({ ...input, assignmentId: standard }), /overlap|covers/i);
      await assert.rejects(recordHistoricalEmployerAssignment({ ...input, effectiveTo: '2026-07-21' }), /end before today/);
      await assert.rejects(recordHistoricalEmployerAssignment({ ...input, effectiveFrom: '2026-07-09', effectiveTo: '2026-07-09', expectedCurrentId: reduced }), /current.*differs/i);
      await assert.rejects(recordHistoricalEmployerAssignment({ ...input, allowedSubsidiaryIds: new Set() }));
      await assert.rejects(db.transaction(tx => tx.execute(sql`update payroll_employee_employer_assignments set reason='Replacement' where org_id=${f.orgId} and id=${saved.id}`)), /immutable/i);
      for (const date of ['2026-07-07', '2026-07-09']) assert.deepEqual(await employeeEmployerAssignmentHistory(db, { orgId: f.orgId, payDate: date, employeePartyIds: [f.employeeId] }), []);
      await commitPayRun(command);
      const posted = await stub();
      assert.deepEqual(posted, after);
      await assert.rejects(recordHistoricalEmployerAssignment({ ...worker, effectiveFrom: '2026-07-07', effectiveTo: '2026-07-09' }), /overlap|covers/i);
      const later = { ...input, effectiveFrom: '2026-07-09', effectiveTo: '2026-07-09', dryRun: false };
      let ready!: () => void, resume!: () => void;
      const observed = new Promise<void>(resolve => { ready = resolve; });
      const inserted = new Promise<void>(resolve => { resume = resolve; });
      const staleReader = withOrgTransaction(f.orgId, async () => {
        await db.execute(sql`select id from employee_payroll_profiles where org_id=${f.orgId} and employee_party_id=${f.employeeId}`);
        ready(); await inserted;
        await lockEmployerAssignmentProfiles(db, f.orgId, [f.employeeId]);
      }, { isolationLevel: 'REPEATABLE READ' });
      const staleResult = assert.rejects(staleReader, error => {
        let cause: unknown = error;
        while (cause && typeof cause === 'object') {
          if ('code' in cause && cause.code === '40001') return true;
          cause = 'cause' in cause ? cause.cause : null;
        }
        return false;
      });
      await observed;
      try { assert.equal((await recordHistoricalEmployerAssignment(later)).changed, true); }
      finally { resume(); }
      await staleResult;
      const audit = (await db.execute<{ actor_id: string; changes: Record<string, unknown> }>(sql`select actor_id,changes from audit_log
        where org_id=${f.orgId} and table_name='payroll_employee_employer_assignments' and row_id=${saved.id}`)).rows;
      assert.equal(audit.length, 1); assert.equal(audit[0]!.actor_id, f.actorId);
      assert.equal(audit[0]!.changes.sourceReference, input.sourceReference);
      const other = await seedHiredEmployee(f.orgId, f.actorId, { name: 'Other subject', subsidiaryId: f.subsidiaryId,
        partySubsidiaryId: f.subsidiaryId, scheduleId: f.scheduleId, country: 'CA', province: 'ON',
        payBasis: 'hourly', currency: 'CAD', rate: '30', rateBasis: 'hour' });
      await recordHistoricalEmployerAssignment({ ...worker, employeePartyId: other.employeeId,
        sourceReference: 'Other subject private assignment', dryRun: false });
      const exported = await exportedPayrollEvidence({ orgId: f.orgId, actorId: f.actorId, partyId: f.employeeId });
      assert.deepEqual(exported.employerAssignments.map(row => [row.assignment_kind, row.effective_from, row.source_reference]), [
        ['filing_account', '2026-07-08', input.sourceReference], ['worker_comp', '2026-07-08', input.sourceReference],
        ['filing_account', '2026-07-09', input.sourceReference],
      ]);
      assert.doesNotMatch(JSON.stringify(exported.employerAssignments), /Other subject private assignment/);
      for (const row of exported.employerAssignments) for (const key of ['org_id', 'employee_party_id', 'created_by', 'updated_by']) {
        assert.equal(Object.hasOwn(row, key), false, `assignment export excludes ${key}`);
      }

    }));
  } finally { await withBypassContext(() => dropScratchOrgReporting(f.orgId)); }
});
