import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { payrollSupportScope } from '@openbooks/engine/payroll/setup';
import { formatPayrollSupportReport, PayrollSupportReportRefusal } from './payroll-support-report-contract';

const labels = JSON.parse(readFileSync(new URL('../messages/en/payroll.json', import.meta.url), 'utf8')).supportReport as Record<string, string>;
const t = (key: string, values?: Record<string, string | number>) => {
  assert.ok(labels[key], `Missing native report label ${key}`);
  return Object.entries(values ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), labels[key]!);
};
const period = { from: '2026-01-01', to: '2026-01-31', label: 'January 2026' };

test('every registered country is represented and artifact builders do not imply agency delivery', () => {
  const scope = payrollSupportScope(period.to);
  const data = formatPayrollSupportReport(scope, period, new URLSearchParams(), t);
  assert.equal(data.groups.length, scope.length * 3);
  for (const [index, pack] of scope.entries()) {
    const country = data.groups[index * 3]!;
    const filings = data.groups[index * 3 + 2]!;
    assert.equal(country.title, `${pack.country} · ${pack.currency}`);
    assert.equal(filings.rows.length, pack.filings.length);
    for (const [filingIndex, filing] of pack.filings.entries()) {
      const row = filings.rows[filingIndex]!;
      assert.equal(row[4], t(filing.submission ? 'implemented' : 'notImplemented'));
      assert.equal(row[5], t(filing.acceptance ? 'implemented' : 'notImplemented'));
      assert.ok(String(row[6]).includes(t('filingYearNote')), 'every artifact retains the exact-year and acceptance caveat');
    }
  }
});

test('country and search filters use one projection and unknown countries refuse with the native picker remedy', () => {
  const scope = payrollSupportScope(period.to);
  const params = new URLSearchParams({ country: 'CA', q: 'T4' });
  const screen = formatPayrollSupportReport(scope, period, params, t);
  const exportData = formatPayrollSupportReport(scope, period, new URLSearchParams(params), t);
  assert.deepEqual(screen, exportData);
  assert.equal(screen.groups.length, 3);
  assert.equal(screen.groups[0]!.title, 'CA · CAD');
  assert.throws(() => formatPayrollSupportReport(scope, period, new URLSearchParams({ country: 'XX' }), t),
    (error: unknown) => error instanceof PayrollSupportReportRefusal && /Choose a registered country from the country filter/.test(error.message));
});

test('a future calculation year cannot inherit a published current edition or claim agency certification', () => {
  const future = { from: '2099-01-01', to: '2099-01-31', label: 'January 2099' };
  const scope = payrollSupportScope(future.to);
  const data = formatPayrollSupportReport(scope, future, new URLSearchParams({ country: 'CA' }), t);
  assert.equal(data.groups[0]!.rows[0]![1], `2099: ${t('unavailable')}`);
  assert.equal(data.groups[0]!.rows[0]![2], t('missingYear'));
});
