import assert from 'node:assert/strict';
import test from 'node:test';
import { payrollSupportScope } from './support-scope.ts';
import { PAYROLL_COUNTRY_PACKS } from './pack-registry.ts';
import { payrollPackFilings } from './filing-registry.ts';
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
