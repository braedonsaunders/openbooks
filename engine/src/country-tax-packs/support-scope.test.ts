import assert from 'node:assert/strict';
import test from 'node:test';
import { COUNTRY_TAX_PACKS } from './index.ts';
import { indirectTaxSupportScope } from './support-scope.ts';
test('all tax packs retain their declared limitations, versions, sources and submission channels', () => {
  const scope = indirectTaxSupportScope();
  assert.deepEqual(scope.map(p => p.country), [...COUNTRY_TAX_PACKS].map(p => p.country).sort());
  for (const row of scope) {
    const pack = COUNTRY_TAX_PACKS.find(p => p.code === row.code)!;
    assert.deepEqual(row.completeness, pack.completeness);
    assert.deepEqual(row.sources, pack.sources);
    assert.equal(row.version, pack.version);
    assert.equal(row.jurisdictions.length, pack.jurisdictions.length);
    assert.deepEqual(row.returns.map(r => r.code), pack.returnPacks.map(r => r.code));
    for (const form of row.returns) {
      const declared = pack.returnPacks.find(r => r.code === form.code)!;
      assert.equal(form.submissionChannel, declared.submissionChannel);
      assert.equal(form.governmentFormat, declared.governmentFormat);
      assert.match(form.assurance, /validate the actual export and agency acceptance/);
    }
  }
});
