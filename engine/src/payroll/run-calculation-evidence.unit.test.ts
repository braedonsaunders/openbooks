import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  parsePayRunCalculationSource,
  payRunCalculationSourceDigest,
  payRunCalculationSourceChanges,
  type PayRunCalculationSourceSnapshot,
} from "./run-calculation-evidence.ts";

const snapshot = (): PayRunCalculationSourceSnapshot => ({
  version: 1, timeEntries: [], timeTypes: [], payRates: [], itemAccounts: [], claimEntryIds: [],
});

test("stored calculation evidence accepts the supported version and preserves routing evidence", () => {
  const value = snapshot();
  value.itemAccounts.push({ id: "service-item", payrollExpenseAccountId: "expense-account", updatedAt: "2026-09-20" });
  assert.deepEqual(parsePayRunCalculationSource(value), value);
});

test("missing, scalar, array, and unsupported-version calculation evidence fails closed", () => {
  for (const value of [null, undefined, false, 1, "{}", [], {}, { ...snapshot(), version: 0 }, { ...snapshot(), version: 2 }]) {
    assert.equal(parsePayRunCalculationSource(value), null, JSON.stringify(value));
  }
});

test("each required evidence collection must be an array", () => {
  for (const key of ["timeEntries", "timeTypes", "payRates", "claimEntryIds"] as const) {
    for (const bad of [undefined, null, {}, "[]"]) {
      assert.equal(parsePayRunCalculationSource({ ...snapshot(), [key]: bad }), null, key);
    }
  }
});

test("legacy evidence without item routing reads as empty and detects later routing changes", () => {
  const legacy: Partial<PayRunCalculationSourceSnapshot> = snapshot();
  delete legacy.itemAccounts;
  const parsed = parsePayRunCalculationSource(legacy);
  assert.ok(parsed);
  assert.deepEqual(parsed.itemAccounts, []);
  const current = snapshot();
  current.itemAccounts.push({ id: "item", payrollExpenseAccountId: "expense", updatedAt: "2026-09-20" });
  assert.deepEqual(payRunCalculationSourceChanges(parsed, current), { time: false, timeTypes: false, wages: false, items: true, compensationPackages: false });
});

test("canonical evidence ignores object key order but preserves array order and values", () => {
  assert.equal(canonicalJson({ b: [null, 2], a: { z: false, y: "x" } }), canonicalJson({ a: { y: "x", z: false }, b: [null, 2] }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  const first = snapshot();
  const reordered = { claimEntryIds: [], itemAccounts: [], payRates: [], timeTypes: [], timeEntries: [], version: 1 as const };
  assert.equal(payRunCalculationSourceDigest(first), payRunCalculationSourceDigest(reordered));
  assert.notEqual(payRunCalculationSourceDigest(first), payRunCalculationSourceDigest({ ...first, claimEntryIds: ["new-claim"] }));
});

test('legacy payroll evidence treats absent package terms as empty and detects newly approved financial sources', () => {
  const legacy = snapshot();
  const empty = { ...snapshot(), compensationPackages: [] };
  assert.equal(payRunCalculationSourceChanges(legacy, empty).compensationPackages, false);
  const source: NonNullable<PayRunCalculationSourceSnapshot['compensationPackages']>[number] = {
    assignmentId: 'assignment', packageId: 'package', packageCode: 'FIELD', employmentId: 'employment', employeePartyId: 'employee',
    subsidiaryId: 'employer', country: 'CA', currency: 'CAD', currencyMinorUnits: 2, effectiveFrom: '2026-01-01', effectiveTo: null, inputs: { allowance: '310' },
    versionId: 'approved-version', versionEffectiveFrom: '2026-01-01', versionEffectiveTo: null, definitionHash: 'approved-hash',
    definition: { orgId: 'organization', country: 'CA', currency: 'CAD', partialPeriod: 'allow', inputs: [], rules: [] }, components: [],
  };
  const current = { ...snapshot(), compensationPackages: [source] };
  assert.equal(payRunCalculationSourceChanges(legacy, current).compensationPackages, true);
  assert.notEqual(payRunCalculationSourceDigest(current), payRunCalculationSourceDigest(empty));
  const changed = { ...snapshot(), compensationPackages: [{ ...source, inputs: { allowance: '320' } }] };
  assert.equal(payRunCalculationSourceChanges(current, changed).compensationPackages, true);
});

test('a malformed optional package source is refused rather than treated as an empty legacy population', () => {
  for (const compensationPackages of [null, false, '[]', {}]) {
    assert.equal(parsePayRunCalculationSource({ ...snapshot(), compensationPackages }), null);
  }
});
