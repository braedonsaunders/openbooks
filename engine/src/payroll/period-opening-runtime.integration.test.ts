import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { dropScratchOrgReporting } from '../testing/fixtures.ts';
import { calculatedRun, seedAdoption, type AdoptionFixture } from './filing-test-fixtures.ts';
import { CA_PERIOD_OPENING_TREATMENT } from './canada/period-openings.ts';
import { saveOpeningBalances } from './opening-balances.ts';
import { savePayrollPeriodOpening } from './period-opening-store.ts';
import { calculatePayRun } from './run-calculation.ts';
import { mutatePayRunAdjustment } from './run-adjustments.ts';
import { commitPayRun } from './run-commit.ts';
import { payRunStaleness } from './readiness.ts';
import { cmp } from '../money/money.ts';
import { postDocument } from '../ledger/posting-document.ts';

const DB = !!process.env.OPENBOOKS_DB_URL;
async function opening(f: AdoptionFixture) {
  await db.execute(sql`update parties set subsidiary_id=${f.subsidiaryId} where org_id=${f.orgId} and id=${f.employeeId}`);
  await saveOpeningBalances({ orgId: f.orgId, actorId: f.actorId, taxYear: 2026, allowedSubsidiaryIds: null,
    rows: [{ employeePartyId: f.employeeId, amounts: { pensionableYtd: '262.77', insurableYtd: '262.77', taxableYtd: '262.77', cppYtd: '7.63', eiYtd: '4.28' } }] });
  const annual = (await db.execute<{ updated_at: string }>(sql`select updated_at::text as updated_at from payroll_opening_balances
    where org_id=${f.orgId} and employee_party_id=${f.employeeId} and tax_year=2026`)).rows[0]!;
  const amounts = Object.fromEntries(CA_PERIOD_OPENING_TREATMENT.fields.map((field) => [field.key, '0']));
  Object.assign(amounts, { pensionable: '262.77', insurable: '262.77', periodicIncome: '262.77', cpp: '7.63', ei: '4.28', enhancedCppPeriodic: '1.28' });
  return { orgId: f.orgId, actorId: f.actorId, employeePartyId: f.employeeId, taxYear: 2026,
    subsidiaryId: f.subsidiaryId, payScheduleId: f.scheduleId, country: 'CA', currency: 'CAD',
    periodStart: '2026-07-05', periodEnd: '2026-07-18', paidThrough: '2026-07-20', amounts,
    sourceReference: 'Verified paid-period contribution statement', reason: 'Attribute the annual carry-in to the first adopted period',
    expectedRevision: null, expectedAnnualUpdatedAt: annual.updated_at, dryRun: false, allowedSubsidiaryIds: null };
}
async function contributions(f: AdoptionFixture, documentId: string) {
  return (await db.execute<{ cpp: string; ei: string; pensionable: string }>(sql`
    select factors->>'C' as cpp,factors->>'EI' as ei,pensionable_earnings::text as pensionable from pay_stubs
     where org_id=${f.orgId} and pay_run_document_id=${documentId} and employee_party_id=${f.employeeId}`)).rows[0]!;
}

test('admitted period payments consume one period CPP exemption while EI remains the current payment share', { skip: !DB }, async () => {
  const f = await seedAdoption();
  try {
    const source = await opening(f);
    const { input } = await calculatedRun(f);
    assert.deepEqual(await contributions(f, input.documentId), { cpp: '6.2700', ei: '3.9100', pensionable: '240.0000' });
    const saved = await savePayrollPeriodOpening(source);
    assert.ok(saved.record); assert.notEqual(saved.annualUpdatedAt, source.expectedAnnualUpdatedAt);
    assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, ['openingBalances']);
    await assert.rejects(commitPayRun(input), /openingBalances/);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    assert.deepEqual(await contributions(f, input.documentId), { cpp: '14.2800', ei: '3.9100', pensionable: '240.0000' });
    assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, []);
    const cleared = await savePayrollPeriodOpening({ ...source, expectedRevision: saved.record.revision, expectedAnnualUpdatedAt: saved.annualUpdatedAt,
      amounts: Object.fromEntries(CA_PERIOD_OPENING_TREATMENT.fields.map(field => [field.key, '0'])), reason: 'Correct an unused attribution while retaining its source history' });
    assert.ok(cleared.record);
    assert.deepEqual((await payRunStaleness(f.orgId, input.documentId)).reasons, ['openingBalances']);
    await assert.rejects(commitPayRun(input), /openingBalances/);
    assert.deepEqual((await calculatePayRun(input)).errors, []);
    assert.deepEqual(await contributions(f, input.documentId), { cpp: '6.2700', ei: '3.9100', pensionable: '240.0000' });
    const restored = await savePayrollPeriodOpening({ ...source, expectedRevision: cleared.record.revision, expectedAnnualUpdatedAt: cleared.annualUpdatedAt });
    assert.ok(restored.record);
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual((await calculatePayRun(input)).errors, []);
      assert.deepEqual(await contributions(f, input.documentId), { cpp: '14.2800', ei: '3.9100', pensionable: '240.0000' });
    }
    await commitPayRun(input);
    const accounts = (await db.execute<{ id: string; type: string }>(sql`select id,type from accounts where org_id=${f.orgId}`)).rows;
    const account = (type: string) => { const row = accounts.find(candidate => candidate.type === type); assert.ok(row); return row.id; };
    await db.execute(sql`update documents set status='approved' where org_id=${f.orgId} and id=${input.documentId}`);
    await postDocument(input.documentId, { control: { ar: account('asset_receivable'), ap: account('liability_payable'), bank: account('asset_bank') } });
    const ledger = (await db.execute<{ amount: string; count: number }>(sql`select coalesce(sum(amount),0)::text as amount,count(*)::int as count
      from journal_lines where org_id=${f.orgId}`)).rows[0]!;
    assert.ok(ledger.count > 0); assert.equal(cmp(ledger.amount, '0'), 0);
    await assert.rejects(savePayrollPeriodOpening({ ...source, expectedRevision: restored.record.revision, expectedAnnualUpdatedAt: restored.annualUpdatedAt,
      reason: 'Attempt to change a consumed opening' }), /already used.*opening balances.*controlled void action/);
    assert.deepEqual(await contributions(f, input.documentId), { cpp: '14.2800', ei: '3.9100', pensionable: '240.0000' });
  } finally { await dropScratchOrgReporting(f.orgId); }
});

test('a run paid before the declared provider cutover refuses by employee without admitting duplicate pay', { skip: !DB }, async () => {
  const f = await seedAdoption();
  try {
    const source = await opening(f);
    await savePayrollPeriodOpening({ ...source, paidThrough: '2026-07-21' });
    await assert.rejects(calculatedRun(f), /Terry Worker.*paid on or before.*paid-through date 2026-07-21/);
    const financial = (await db.execute<{ stubs: number; ledger: number }>(sql`select
      (select count(*)::int from pay_stubs where org_id=${f.orgId}) as stubs,
      (select count(*)::int from journal_lines where org_id=${f.orgId}) as ledger`)).rows[0]!;
    assert.deepEqual(financial, { stubs: 0, ledger: 0 });
  } finally { await dropScratchOrgReporting(f.orgId); }
});

test('excluded employees contribute no provider priors and reinclusion restores the cutover refusal', { skip: !DB }, async () => {
  const f = await seedAdoption();
  try {
    const source = await opening(f); const { input } = await calculatedRun(f);
    await savePayrollPeriodOpening({ ...source, paidThrough: '2026-07-21' });
    await mutatePayRunAdjustment({ ...input, mutation: { action: 'exclude', employeePartyId: f.employeeId } });
    const excluded = await calculatePayRun(input); assert.equal(excluded.employees, 0); assert.deepEqual(excluded.errors, []);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from pay_stubs where org_id=${f.orgId}`)).rows[0]!.count, 0);
    await mutatePayRunAdjustment({ ...input, mutation: { action: 'include', employeePartyId: f.employeeId } });
    await assert.rejects(calculatePayRun(input), /Terry Worker.*paid on or before.*paid-through date 2026-07-21/);
    assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from journal_lines where org_id=${f.orgId}`)).rows[0]!.count, 0);
  } finally { await dropScratchOrgReporting(f.orgId); }
});
