import assert from 'node:assert/strict';
import test from 'node:test';
import { validateOpeningLevySourceFacts, type OpeningLevySourceFacts } from './opening-levy-source-facts.ts';
import { PAYROLL_COUNTRY_PACKS } from './pack-registry.ts';

const ca: OpeningLevySourceFacts = { originalCountry: 'CA', originalCurrency: 'CAD', coverageStart: '2026-01-01', coverageEnd: '2026-05-30', coverageComplete: true };

test('original facts require the declared statutory currency and complete original year-to-date period', () => {
  assert.doesNotThrow(() => validateOpeningLevySourceFacts(ca, 2026, PAYROLL_COUNTRY_PACKS.CA));
  for (const change of [
    { originalCountry: 'ZZ' }, { originalCurrency: 'USD' }, { coverageStart: '2026-02-01' },
    { coverageEnd: '2026-02-30' }, { coverageEnd: '2027-01-01' }, { coverageEnd: '2025-12-31' },
    { coverageComplete: false }, { coverageComplete: undefined }, { originalCountry: undefined },
    { originalCurrency: undefined }, { coverageStart: undefined }, { coverageEnd: undefined },
  ]) assert.throws(() => validateOpeningLevySourceFacts({ ...ca, ...change } as OpeningLevySourceFacts, 2026, PAYROLL_COUNTRY_PACKS.CA), /original|complete/);
});

test('fiscal original coverage follows the declared UK opening-year and Australian closing-year calendars', () => {
  const gb: OpeningLevySourceFacts = { ...ca, originalCountry: 'GB', originalCurrency: 'GBP', coverageStart: '2026-04-06', coverageEnd: '2027-04-05' };
  const au: OpeningLevySourceFacts = { ...ca, originalCountry: 'AU', originalCurrency: 'AUD', coverageStart: '2025-07-01', coverageEnd: '2026-06-30' };
  assert.doesNotThrow(() => validateOpeningLevySourceFacts(gb, 2026, PAYROLL_COUNTRY_PACKS.GB));
  assert.doesNotThrow(() => validateOpeningLevySourceFacts(au, 2026, PAYROLL_COUNTRY_PACKS.AU));
  assert.throws(() => validateOpeningLevySourceFacts({ ...gb, coverageEnd: '2027-04-06' }, 2026, PAYROLL_COUNTRY_PACKS.GB), /complete year-to-date/);
  assert.throws(() => validateOpeningLevySourceFacts({ ...au, coverageStart: '2026-07-01', coverageEnd: '2026-07-02' }, 2026, PAYROLL_COUNTRY_PACKS.AU), /complete year-to-date/);
  assert.throws(() => validateOpeningLevySourceFacts({ ...au, coverageStart: '2026-01-01' }, 2026, PAYROLL_COUNTRY_PACKS.AU), /complete year-to-date/);
});
