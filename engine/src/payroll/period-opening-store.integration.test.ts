import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Client } from 'pg';
import { waitForLockWaiter } from '../testing/lock-wait.ts';
import { takeEmployeeTaxYearFences, employeeTaxYearFenceKey } from './fences.ts';
import { db, withOrgTransaction } from '../platform/db.ts';
import { DB, withHarness, setFeatures } from '../testing/hrm-harness.ts';
import { saveOpeningBalances } from './opening-balances.ts';
import { savePayrollPeriodOpening } from './period-opening-store.ts';
import { payrollPeriodOpeningForEmployee } from './period-opening-reader.ts';
import { CA_PERIOD_OPENING_TREATMENT } from './canada/period-openings.ts';

import { setupPeriodOpeningFixture as setup, periodOpeningInput as input } from '../testing/payroll-period-openings-fixture.ts';
async function counts(orgId: string) {
  return (await db.execute<{ openings: number; audits: number; stubs: number; ledger: number }>(sql`select
    (select count(*)::int from payroll_period_openings where org_id=${orgId}) as openings,
    (select count(*)::int from audit_log where org_id=${orgId} and table_name='payroll_period_openings') as audits,
    (select count(*)::int from pay_stubs where org_id=${orgId}) as stubs,
    (select count(*)::int from journal_lines where org_id=${orgId}) as ledger`)).rows[0]!;
}

test('preview performs identical checks without a period row, audit, payment or ledger write', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await counts(f.org.orgId);
    assert.equal((await savePayrollPeriodOpening({ ...input(f), dryRun: true })).changed, true);
    assert.deepEqual(await counts(f.org.orgId), before);
    await assert.rejects(savePayrollPeriodOpening({ ...input(f), dryRun: true, amounts: { ...f.amounts, cpp: '11.64' } }), /CPP\/QPP contributions.*already be included.*cppYtd/);
    assert.deepEqual(await counts(f.org.orgId), before);
  });
});

test('apply retains exact source amounts and one complete audit while replay creates no second effect', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await counts(f.org.orgId);
    const saved = await savePayrollPeriodOpening(input(f));
    assert.equal(saved.changed, true); assert.ok(saved.record);
    assert.equal(saved.record.amounts.cpp, '11.6300'); assert.equal(saved.record.revision, 1);
    const view = await payrollPeriodOpeningForEmployee({ orgId: f.org.orgId, actorId: f.readerId,
      employeePartyId: f.workerPartyId, taxYear: 2026, allowedSubsidiaryIds: null });
    assert.deepEqual(view.record, saved.record);
    assert.equal(view.annualUpdatedAt, saved.annualUpdatedAt);
    assert.deepEqual(view.fields, CA_PERIOD_OPENING_TREATMENT.fields);
    assert.ok(view.schedules.some(schedule => schedule.id === f.scheduleId));
    assert.ok(view.currencies.some(currency => currency.value === 'CAD'));
    await assert.rejects(payrollPeriodOpeningForEmployee({ orgId: f.org.orgId, actorId: f.readerId,
      employeePartyId: f.workerPartyId, taxYear: 2026, allowedSubsidiaryIds: new Set() }), /unavailable in your payroll scope/);
    const after = await counts(f.org.orgId);
    assert.equal(after.openings, before.openings + 1); assert.equal(after.audits, before.audits + 1);
    assert.equal(after.stubs, before.stubs); assert.equal(after.ledger, before.ledger);
    const audit = (await db.execute<{ actor_id: string; changes: { before: unknown; after: { amounts: Record<string, string> }; sourceReference: string; reason: string } }>(sql`
      select actor_id,changes from audit_log where org_id=${f.org.orgId} and table_name='payroll_period_openings' and row_id=${saved.record.id}`)).rows[0]!;
    assert.equal(audit.actor_id, f.authorId); assert.equal(audit.changes.before, null);
    assert.equal(audit.changes.after.amounts.cpp, '11.6300');
    assert.equal(audit.changes.sourceReference, input(f).sourceReference); assert.equal(audit.changes.reason, input(f).reason);
    const replay = await savePayrollPeriodOpening({ ...input(f), expectedRevision: saved.record.revision, expectedAnnualUpdatedAt: saved.annualUpdatedAt });
    assert.equal(replay.changed, false); assert.deepEqual(await counts(f.org.orgId), after);
  });
});

test('annual amounts cannot subsequently be reduced beneath their admitted period share', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const saved = await savePayrollPeriodOpening(input(f)); assert.ok(saved.record);
    await assert.rejects(saveOpeningBalances({ orgId: f.org.orgId, actorId: f.authorId, taxYear: 2026,
      rows: [{ employeePartyId: f.workerPartyId, amounts: { pensionableYtd: '262.77', insurableYtd: '262.77', taxableYtd: '262.77', cppYtd: '11.62', eiYtd: '4.28' } }], allowedSubsidiaryIds: null }), /annual|Annual|period payments/);
    const amount = (await db.execute<{ cpp: string }>(sql`select cpp_ytd::text as cpp from payroll_opening_balances where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId} and tax_year=2026`)).rows[0]!;
    assert.equal(amount.cpp, '11.6300');
    assert.equal((await counts(f.org.orgId)).audits, 1);
  });
});

test('wrong authority, country, employer, scope and schedule boundaries refuse before writes', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await counts(f.org.orgId);
    for (const [change, refusal] of [
      [{ actorId: f.readerId }, /Payroll manage permission/],
      [{ country: 'US' }, /opening country must match/],
      [{ subsidiaryId: randomUUID() }, /employee is not available/],
      [{ allowedSubsidiaryIds: new Set<string>() }, /employee is not available/],
      [{ periodStart: '2025-12-29' }, /does not match.*schedule boundaries/],
      [{ payScheduleId: randomUUID() }, /active payroll schedule/],
    ] as const) await assert.rejects(savePayrollPeriodOpening({ ...input(f), ...change }), refusal);
    assert.deepEqual(await counts(f.org.orgId), before);
    await setFeatures(f.org.orgId, { payroll: false, hrm: true });
    await assert.rejects(savePayrollPeriodOpening(input(f)), /Payroll feature is disabled/);
    assert.deepEqual(await counts(f.org.orgId), before);
  });
});

test('stale annual or period revisions and unrepresentable amounts refuse without changing evidence', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    await assert.rejects(savePayrollPeriodOpening({ ...input(f), expectedAnnualUpdatedAt: 'outdated' }), /annual opening balance changed/);
    await assert.rejects(savePayrollPeriodOpening({ ...input(f), expectedRevision: 1 }), /period opening changed/);
    await assert.rejects(savePayrollPeriodOpening({ ...input(f), amounts: { ...f.amounts, ei: '4.281' } }), /2 decimal places/);
    await assert.rejects(savePayrollPeriodOpening({ ...input(f), amounts: { ...f.amounts, enhancedCppPeriodic: '11.64' } }), /Enhanced CPP deductions cannot exceed/);
    assert.deepEqual(await counts(f.org.orgId), { openings: 0, audits: 0, stubs: 0, ledger: 0 });
  });
});

test('an outer command rollback removes its period save and audit together', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const before = await counts(f.org.orgId);
    await assert.rejects(withOrgTransaction(f.org.orgId, async () => {
      await savePayrollPeriodOpening(input(f), db);
      throw new Error('Later command validation refused');
    }), /Later command validation refused/);
    assert.deepEqual(await counts(f.org.orgId), before);
  });
});

for (const first of ['annual', 'period'] as const) test(`concurrent ${first} save fences annual edits against period admission`, { skip: !DB, timeout: 15000 }, async () => {
  await withHarness(setup, async f => {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const annual = () => saveOpeningBalances({ orgId: f.org.orgId, actorId: f.authorId, taxYear: 2026,
      rows: [{ employeePartyId: f.workerPartyId, amounts: { pensionableYtd: '262.77', insurableYtd: '262.77', taxableYtd: '262.77', cppYtd: '11.62', eiYtd: '4.28' } }], allowedSubsidiaryIds: null });
    const period = () => savePayrollPeriodOpening(input(f));
    const holder = withOrgTransaction(f.org.orgId, async () => {
      await takeEmployeeTaxYearFences(db, [employeeTaxYearFenceKey(f.org.orgId, f.workerPartyId, 2026)]);
      await (first === 'annual' ? annual() : period()); ready();
      // The adapter queries the same pinned backend that owns the native fence.
      await waitForLockWaiter({ query: (text: string) => db.execute(sql.raw(text)) } as Pick<Client, 'query'>, { label: 'the competing opening save' });
    }).finally(ready);
    await started;
    const competing = (first === 'annual' ? period() : annual()).then(() => null, error => error);
    const settled = await Promise.allSettled([holder, competing]);
    if (settled[0].status === 'rejected') throw settled[0].reason;
    assert.equal(settled[1].status, 'fulfilled');
    const refusal = settled[1].status === 'fulfilled' ? settled[1].value : null; assert.ok(refusal instanceof Error);
    assert.match(refusal.message, first === 'annual' ? /annual opening balance changed/ : /below.*same-period payments/);
    const rows = (await db.execute<{ cpp: string; periods: number }>(sql`select cpp_ytd::text as cpp,
      (select count(*)::int from payroll_period_openings where org_id=${f.org.orgId}) as periods
      from payroll_opening_balances where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId}`)).rows;
    assert.deepEqual(rows, [{ cpp: first === 'annual' ? '11.6200' : '11.6300', periods: first === 'annual' ? 0 : 1 }]);
  });
});

test('explicit zero period amounts retain a readable annual parent and complete revision history', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const saved = await savePayrollPeriodOpening(input(f)); assert.ok(saved.record);
    const zero = Object.fromEntries(CA_PERIOD_OPENING_TREATMENT.fields.map(field => [field.key, '0']));
    const cleared = await savePayrollPeriodOpening({ ...input(f), amounts: zero, expectedRevision: saved.record.revision,
      expectedAnnualUpdatedAt: saved.annualUpdatedAt, reason: 'Correct unused period attribution to explicit zero' });
    assert.ok(cleared.record); assert.equal(cleared.record.revision, 2);
    assert.notEqual(cleared.annualUpdatedAt, saved.annualUpdatedAt);
    const audit = (await db.execute<{ changes: { before: { amounts: Record<string, string> }; after: { amounts: Record<string, string> } } }>(sql`
      select changes from audit_log where org_id=${f.org.orgId} and table_name='payroll_period_openings' and action='update'`)).rows[0]!;
    assert.equal(audit.changes.before.amounts.cpp, '11.6300'); assert.equal(audit.changes.after.amounts.cpp, '0.0000');
    await saveOpeningBalances({ orgId: f.org.orgId, actorId: f.authorId, taxYear: 2026,
      rows: [{ employeePartyId: f.workerPartyId, amounts: {} }], allowedSubsidiaryIds: null });
    const parent = (await db.execute<{ id: string; cpp: string }>(sql`select id,cpp_ytd::text as cpp from payroll_opening_balances
      where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId} and tax_year=2026`)).rows;
    assert.deepEqual(parent, [{ id: cleared.record.annualOpeningBalanceId, cpp: '0.0000' }]);
    assert.deepEqual(await counts(f.org.orgId), { openings: 1, audits: 2, stubs: 0, ledger: 0 });
  });
});

test('program replacement retains admitted balances and direct reassignment cannot erase the old program share', { skip: !DB }, async () => {
  await withHarness(setup, async f => {
    const annual = () => saveOpeningBalances({ orgId: f.org.orgId, actorId: f.authorId, taxYear: 2026,
      rows: [{ employeePartyId: f.workerPartyId, amounts: {}, programs: { qpip: '262.77' } }], allowedSubsidiaryIds: null });
    await annual();
    const version = (await db.execute<{ version: string }>(sql`select updated_at::text as version from payroll_opening_balances
      where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId} and tax_year=2026`)).rows[0]!.version;
    await savePayrollPeriodOpening({ ...input(f), expectedAnnualUpdatedAt: version,
      amounts: { ...Object.fromEntries(CA_PERIOD_OPENING_TREATMENT.fields.map(field => [field.key, '0'])), qpipPeriodicEarnings: '262.77' } });
    await annual();
    await assert.rejects(saveOpeningBalances({ orgId: f.org.orgId, actorId: f.authorId, taxYear: 2026,
      rows: [{ employeePartyId: f.workerPartyId, amounts: {}, programs: { qpip: '262.76' } }], allowedSubsidiaryIds: null }), /program:qpip.*below.*same-period payments/);
    await assert.rejects(db.execute(sql`update payroll_opening_program_bases set program_key='changed'
      where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId} and tax_year=2026 and program_key='qpip'`), error => {
        assert.match((error as { cause: Error }).cause.message, /Annual contribution-program balances.*admitted period payments/); return true;
      });
    const programs = (await db.execute<{ program: string; amount: string }>(sql`select program_key as program,insurable_ytd::text as amount
      from payroll_opening_program_bases where org_id=${f.org.orgId} and employee_party_id=${f.workerPartyId} and tax_year=2026`)).rows;
    assert.deepEqual(programs, [{ program: 'qpip', amount: '262.7700' }]);
  });
});

test('foreign employee, actor and schedule references refuse and tenant reads cannot observe another organization opening', { skip: !DB }, async () => {
  await withHarness(setup, async f => withHarness(setup, async other => {
    const saved = await savePayrollPeriodOpening(input(f)); assert.ok(saved.record);
    for (const [change, refusal] of [
      [{ employeePartyId: other.workerPartyId }, /employee is not available/],
      [{ actorId: other.authorId }, /Payroll manage permission/],
      [{ payScheduleId: other.scheduleId }, /active payroll schedule/],
    ] as const) await assert.rejects(savePayrollPeriodOpening({ ...input(f), ...change }), refusal);
    const hidden = await withOrgTransaction(other.org.orgId, () => db.execute(sql`select id from payroll_period_openings where id=${saved.record!.id}`));
    assert.deepEqual(hidden.rows, []);
    assert.deepEqual(await counts(f.org.orgId), { openings: 1, audits: 1, stubs: 0, ledger: 0 });
    assert.deepEqual(await counts(other.org.orgId), { openings: 0, audits: 0, stubs: 0, ledger: 0 });
  }));
});
