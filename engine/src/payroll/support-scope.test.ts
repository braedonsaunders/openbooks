import assert from 'node:assert/strict';
import test from 'node:test';
import { payrollSupportScope } from './support-scope.ts';
import { PAYROLL_COUNTRY_PACKS } from './pack-registry.ts';
import { payrollFilingDeliveryScope, payrollPackFilings } from './filing-registry.ts';
test('every registered pack exposes exact regional, obligation and filing scope', () => {
  const scope = payrollSupportScope();
  assert.deepEqual(scope.map(p => p.country), Object.keys(PAYROLL_COUNTRY_PACKS).sort());
  for (const country of scope) {
    const pack = PAYROLL_COUNTRY_PACKS[country.country]!;
    assert.deepEqual(country.obligations.map(o => o.key), pack.statutorySlots.flatMap(s => s.components.map(c => c.systemKey)));
    for (const region of country.regions) {
      assert.equal(region.incomeTaxImplemented, pack.regions.supported.includes(region.region));
      if (!region.incomeTaxImplemented) assert.ok(region.refusal, `${country.country}/${region.region} must name its refusal`);
    }
    const filings = payrollPackFilings(country.country).yearEnd;
    assert.deepEqual(country.filings.map(f => f.key), filings.map(f => f.key));
    for (const filing of country.filings) {
      const declared = filings.find(f => f.key === filing.key)!;
      assert.equal(filing.originalFile, Boolean(declared.download));
      assert.equal(filing.correction, declared.amendment.supported);
      assert.deepEqual({ submission: filing.submission, submissionRefusal: filing.submissionRefusal,
        acceptance: filing.acceptance, acceptanceRefusal: filing.acceptanceRefusal }, payrollFilingDeliveryScope(declared));
      if (!filing.submission) assert.ok(filing.submissionRefusal, `${country.country}/${filing.key} must explain its missing submission transport`);
      if (!filing.acceptance) assert.ok(filing.acceptanceRefusal, `${country.country}/${filing.key} must explain its missing agency receipt verification`);
    }
    assert.match(country.assurance, /agency acceptance.*require validation/);
  }
});
test('draft editions never become published calculation years', () => {
  for (const country of payrollSupportScope()) {
    for (const year of country.publishedTableYears) {
      assert.ok(country.editions.some(e => e.year === year && e.status === 'published' && !e.region));
    }
    for (const year of country.draftTableYears) assert.ok(!country.publishedTableYears.includes(year));
  }
});

test('an electronic original and correction never imply submission or agency acceptance', () => {
  const declaration = payrollPackFilings('CA').yearEnd.find(filing => filing.download && filing.amendment.supported);
  assert.ok(declaration, 'a realistic electronic filing is required to prove transport is independent');
  const scope = payrollFilingDeliveryScope({ ...declaration, delivery: undefined });
  assert.equal(scope.submission, false, `${declaration.label} artifact generation must not claim agency submission`);
  assert.equal(scope.acceptance, false, `${declaration.label} artifact generation must not claim agency acceptance`);
  assert.match(scope.submissionRefusal!, /generating an artifact does not submit it/);
  assert.match(scope.acceptanceRefusal!, /artifact generation never establishes acceptance/);
});

test('requested tax years follow each registered country calendar rather than the calendar-year label', () => {
  const early = payrollSupportScope('2026-04-05');
  const later = payrollSupportScope('2026-04-06');
  assert.equal(early.find(pack => pack.country === 'GB')!.selectedTaxYear, 2025);
  assert.equal(later.find(pack => pack.country === 'GB')!.selectedTaxYear, 2026);
  assert.equal(early.find(pack => pack.country === 'CA')!.selectedTaxYear, 2026);
});
