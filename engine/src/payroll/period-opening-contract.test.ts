import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPeriodOpeningAnnualBounds, assertPeriodOpeningDates,
  mergePeriodOpeningPriors, normalizePeriodOpeningAmounts,
  periodOpeningAppliesToRun, periodOpeningPriors,
  type PayrollPeriodOpeningField,
} from './period-opening-contract.ts';

const fields: readonly PayrollPeriodOpeningField[] = [
  { key: 'pensionable', label: 'Pensionable earnings', annualOpeningKey: 'pensionableYtd', basis: 'pensionable', payable: false },
  { key: 'insurable', label: 'Insurable earnings', annualOpeningKey: 'insurableYtd', basis: 'insurable', payable: false },
  { key: 'cpp', label: 'CPP already withheld', annualOpeningKey: 'cppYtd', factorKey: 'C', withheldSystemKey: 'cpp', payable: true },
  { key: 'ei', label: 'EI already withheld', annualOpeningKey: 'eiYtd', factorKey: 'EI', withheldSystemKey: 'ei', payable: true },
];
const source = { pensionable: '262.77', insurable: '262.77', cpp: '11.63', ei: '4.28' };
const normalize = (amounts: unknown = source, currencyMinorUnits = 2) => normalizePeriodOpeningAmounts({ country: 'CA', fields, amounts, currencyMinorUnits });
const opening = { taxYear: 2026, periodStart: '2025-12-28', periodEnd: '2026-01-03', paidThrough: '2026-01-08', payScheduleId: 'weekly', country: 'CA', currency: 'CAD', subsidiaryId: 'employer' };
const run = { ...opening, label: 'PAY-00002', payDate: '2026-01-09' };

test('paid amounts retain exact decimal text and feed the native period-prior contract', () => {
  const amounts = normalize();
  assert.deepEqual(amounts, { pensionable: '262.7700', insurable: '262.7700', cpp: '11.6300', ei: '4.2800' });
  assertPeriodOpeningAnnualBounds({ fields, amounts, annualAmounts: { pensionableYtd: '262.77', insurableYtd: '262.77', cppYtd: '11.63', eiYtd: '4.28' } });
  assert.deepEqual(periodOpeningPriors(fields, amounts), { pensionable: '262.7700', insurable: '262.7700', factors: { C: '11.6300', EI: '4.2800' }, withheldBySystemKey: { cpp: '11.6300', ei: '4.2800' } });
});

test('missing values require explicit zero and foreign pack fields are refused', () => {
  for (const cpp of [undefined, null, '']) assert.throws(() => normalize({ ...source, cpp }), /CPP already withheld is missing.*explicit 0/);
  assert.equal(normalize({ ...source, cpp: '0' }).cpp, '0.0000');
  assert.throws(() => normalize({ ...source, fica: '10' }), /"fica".*not declared by CA/);
  assert.throws(() => normalizePeriodOpeningAmounts({ country: 'ZZ', fields: [], amounts: {}, currencyMinorUnits: 2 }), /ZZ does not declare/);
});

test('a pack cannot offer an inert field or an unsafe factor target', () => {
  for (const field of [
    { key: 'unused', label: 'Unused', payable: true },
    { key: 'unsafe', label: 'Unsafe', factorKey: '__proto__', payable: true },
  ]) {
    assert.throws(() => normalizePeriodOpeningAmounts({ country: 'CA', fields: [field], amounts: { [field.key]: '0' }, currencyMinorUnits: 2 }), /invalid period-opening field declaration/);
  }
});

test('locale ambiguity retains the shared precise decimal remedy without coercing money', () => {
  assert.throws(() => normalize({ ...source, cpp: '12,34' }), /write "12,34" as "12.34"/);
  assert.throws(() => normalize({ ...source, cpp: '1.234,56' }), /write "1.234,56" as "1234.56"/);
  assert.throws(() => normalize({ ...source, cpp: '1,234' }), /ambiguous.*1234.*1.234/);
  assert.throws(() => normalize({ ...source, cpp: 11.63 }), /decimal string.*JSON number/);
  assert.throws(() => normalize({ ...source, cpp: '-1' }), /non-negative/);
  assert.throws(() => normalize({ ...source, cpp: '1000000000000000' }), /payroll money limit/);
});

test('withheld amounts obey registered currency units while exact earnings bases retain their precision', () => {
  assert.throws(() => normalize({ ...source, cpp: '11.635' }), /2 decimal places.*actually paid/);
  assert.equal(normalize({ ...source, pensionable: '262.7777' }).pensionable, '262.7777');
  assert.equal(normalize({ ...source, cpp: '11.635', ei: '4.281' }, 3).cpp, '11.6350');
  assert.equal(normalize({ ...source, cpp: '11', ei: '4' }, 0).cpp, '11.0000');
  assert.equal(normalize({ ...source, cpp: '11.6351', ei: '4.2812' }, 4).cpp, '11.6351');
  for (const precision of [NaN, -1, 5, 2.5, undefined, null]) {
    assert.throws(() => normalizePeriodOpeningAmounts({ country: 'CA', fields, amounts: source, currencyMinorUnits: precision as number }), /currency precision/);
  }
});

test('the annual opening must already contain every admitted period share', () => {
  for (const cppYtd of [undefined, '0', '11.62', '-1', '11,63']) {
    assert.throws(() => assertPeriodOpeningAnnualBounds({ fields, amounts: normalize(), annualAmounts: { pensionableYtd: '262.77', insurableYtd: '262.77', cppYtd: cppYtd as string, eiYtd: '4.28' } }), /CPP already withheld.*cppYtd.*Payroll opening balances/);
  }
  const incomeFields: readonly PayrollPeriodOpeningField[] = [
    { key: 'periodic', label: 'Periodic income', annualOpeningKey: 'taxableYtd', factorKey: 'I', payable: false },
    { key: 'bonus', label: 'Bonus income', annualOpeningKey: 'taxableYtd', factorKey: 'B', payable: false },
  ];
  assert.throws(() => assertPeriodOpeningAnnualBounds({ fields: incomeFields, amounts: { periodic: '100', bonus: '20' }, annualAmounts: { taxableYtd: '100' } }), /Periodic income \+ Bonus income.*120.0000.*taxableYtd/);
  assertPeriodOpeningAnnualBounds({ fields: incomeFields, amounts: { periodic: '100', bonus: '20' }, annualAmounts: { taxableYtd: '120' } });
});

test('opening and native prior shares add once without mutating either input', () => {
  const external = periodOpeningPriors(fields, normalize());
  const native = { pensionable: '100.01', insurable: '100.01', factors: { C: '1.95', I: '100.01' }, withheldBySystemKey: { cpp: '1.95', income_tax: '5.01' } };
  const before = structuredClone({ external, native });
  assert.deepEqual(mergePeriodOpeningPriors(native, external), { pensionable: '362.7800', insurable: '362.7800', factors: { C: '13.5800', I: '100.01', EI: '4.2800' }, withheldBySystemKey: { cpp: '13.5800', income_tax: '5.01', ei: '4.2800' } });
  assert.deepEqual({ external, native }, before);
});

test('cross-year pay periods follow the paid-through tax year and reject impossible dates', () => {
  assertPeriodOpeningDates(opening);
  // The native pack resolves fiscal tax years; generic dates cannot impose a calendar year.
  assertPeriodOpeningDates({ ...opening, taxYear: 2025 });
  for (const changed of [{ periodEnd: '2026-02-30' }, { periodStart: '2026-01-04' }, { paidThrough: '2026-01-02' }, { taxYear: 2026.5 }]) {
    assert.throws(() => assertPeriodOpeningDates({ ...opening, ...changed }));
  }
});

test('source-paid cheques cannot be paid again across a cutover, schedule, currency or employer boundary', () => {
  assert.equal(periodOpeningAppliesToRun(opening, run), true);
  assert.equal(periodOpeningAppliesToRun(opening, { ...run, periodStart: '2026-01-04', periodEnd: '2026-01-10', payDate: '2026-01-16' }), false);
  for (const payDate of ['2026-01-08', '2026-01-07']) assert.throws(() => periodOpeningAppliesToRun(opening, { ...run, payDate }), /PAY-00002.*paid-through date 2026-01-08/);
  for (const changed of [{ payScheduleId: 'monthly' }, { periodStart: '2025-12-29' }]) assert.throws(() => periodOpeningAppliesToRun(opening, { ...run, ...changed }), /different schedule or date range/);
  for (const changed of [{ currency: 'USD' }, { country: 'US' }, { subsidiaryId: 'other-employer' }]) assert.throws(() => periodOpeningAppliesToRun(opening, { ...run, ...changed }), /country, currency or legal employer/);
  assert.throws(() => periodOpeningAppliesToRun(opening, { ...run, taxYear: 2027 }), /same pay-date tax year/);
});
