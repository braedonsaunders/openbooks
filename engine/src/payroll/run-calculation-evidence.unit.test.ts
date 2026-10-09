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

test('adding, removing or changing regular-only assignment windows invalidates calculated component evidence', () => {
  const legacy = snapshot();
  assert.equal(payRunCalculationSourceChanges(legacy, { ...legacy, assignmentRunPolicies: [] }).components, false);
  const policy = { id: 'assignment', employeePartyId: 'employee', employmentId: null,
    componentId: 'allowance', policy: 'regular_only', from: '2026-01-01', to: null };
  const calculated = { ...snapshot(), assignmentRunPolicies: [policy] };
  assert.equal(payRunCalculationSourceChanges(legacy, calculated).components, true);
  assert.equal(payRunCalculationSourceChanges(calculated, legacy).components, true);
  for (const changes of [{ from: '2026-01-02' }, { to: '2026-01-09' }, { employmentId: 'new-employment' }, { componentId: 'premium' }]) {
    assert.equal(payRunCalculationSourceChanges(calculated,
      { ...snapshot(), assignmentRunPolicies: [{ ...policy, ...changes }] }).components, true);
  }
  assert.equal(parsePayRunCalculationSource({ ...legacy, assignmentRunPolicies: null }), null);
});

test("approved holiday ownership, source, wage and foreign payment claims invalidate a calculated run", () => {
  const legacy = snapshot();
  assert.equal(payRunCalculationSourceChanges(legacy, { ...legacy, holidayObligations: [] }).holidayObligations, false);
  const obligation: NonNullable<PayRunCalculationSourceSnapshot["holidayObligations"]>[number] = {
    id: "10000000-0000-4000-8000-000000000001", employeePartyId: "10000000-0000-4000-8000-000000000002",
    employmentId: "10000000-0000-4000-8000-000000000003", subsidiaryId: "10000000-0000-4000-8000-000000000004",
    paymentDate: "2026-01-16", foreignClaim: null, component: { id: "native-stat", taxable: true }, profile: { country: "CA", province: "ON" },
    evidence: { instruction: {
      employeePartyId: "10000000-0000-4000-8000-000000000002", holidayDates: ["2025-12-25", "2025-12-26", "2026-01-01"],
      hours: "24.00", assessedOn: "2026-01-10", wageBasisDate: "2026-01-10", paymentDate: "2026-01-16",
      instructionKey: "owed-holidays", sourceReference: "Approved payroll instruction", sourceDigest: "a".repeat(64),
    }, source: { fileId: "10000000-0000-4000-8000-000000000005", versionId: "10000000-0000-4000-8000-000000000006", versionNumber: 1, contentHash: "a".repeat(64) } },
    wage: { resolved: { rate: "45", annualHours: "2080", basis: "hour", currency: "CAD", payrollRateScale: 2, payrollAmountRounding: "dimension_group" }, source: { id: "dated-wage" }, fx: null },
  };
  const calculated = { ...snapshot(), holidayObligations: [obligation] };
  assert.equal(payRunCalculationSourceChanges(legacy, calculated).holidayObligations, true);
  for (const replacement of [
    { ...obligation, foreignClaim: { id: "other-claim", documentId: "other-payroll", status: "committed" } },
    { ...obligation, wage: { ...obligation.wage!, resolved: { ...obligation.wage!.resolved, rate: "46" } } },
    { ...obligation, evidence: { ...obligation.evidence, source: { ...obligation.evidence.source, versionNumber: 2 } } },
    { ...obligation, component: { ...obligation.component, taxable: false } },
  ]) {
    const changed = { ...snapshot(), holidayObligations: [replacement] };
    assert.equal(payRunCalculationSourceChanges(calculated, changed).holidayObligations, true);
    assert.notEqual(payRunCalculationSourceDigest(calculated), payRunCalculationSourceDigest(changed));
  }
  assert.equal(payRunCalculationSourceChanges(calculated, legacy).holidayObligations, true);
  for (const malformed of [null, false, "[]", {}]) assert.equal(parsePayRunCalculationSource({ ...snapshot(), holidayObligations: malformed }), null);
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
  assert.deepEqual(payRunCalculationSourceChanges(parsed, current), { time: false, timeTypes: false, wages: false, items: true, components: false, compensationPackages: false, holidayObligations: false, roster: false });
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


test('dated employer assignment evidence detects added, removed and changed historical sources while legacy evidence remains unchanged', () => {
  const legacy = snapshot();
  const legacyDigest = payRunCalculationSourceDigest(legacy);
  assert.equal(payRunCalculationSourceChanges(legacy, { ...legacy, employerAssignments: [] }).roster, false);
  assert.equal(payRunCalculationSourceDigest(parsePayRunCalculationSource(legacy)!), legacyDigest);
  const source = { id: 'assignment', employeePartyId: 'employee', subsidiaryId: 'employer', kind: 'filing_account' as const,
    effectiveFrom: '2026-01-09', effectiveTo: '2026-01-09', filingAccountId: 'reduced-account',
    workerCompGroupId: null, createdAt: '2026-10-06', sourceReference: 'Original dated provider card' };
  const current = { ...snapshot(), employerAssignments: [source] };
  assert.equal(payRunCalculationSourceChanges(legacy, current).roster, true);
  assert.equal(payRunCalculationSourceChanges(current, legacy).roster, true);
  for (const change of [{ filingAccountId: 'standard-account' }, { subsidiaryId: 'other-employer' },
    { effectiveTo: '2026-01-10' }, { sourceReference: 'Another source' }]) {
    assert.equal(payRunCalculationSourceChanges(current, { ...current, employerAssignments: [{ ...source, ...change }] }).roster, true);
  }
  for (const employerAssignments of [null, false, '[]', {}]) {
    assert.equal(parsePayRunCalculationSource({ ...legacy, employerAssignments }), null);
  }
});

test("historical roster admissions and changed windows stale a calculation while legacy empty evidence stays equal", () => {
  const legacy = snapshot();
  assert.equal(payRunCalculationSourceChanges(legacy, { ...legacy, historicalEmploymentRoster: [] }).roster, false);
  const admission = { employeePartyId: "employee", employmentId: "employment", versionNo: 2,
    status: "active", effectiveFrom: "2026-01-23", effectiveTo: "2026-01-24", recordedAt: "2026-10-09T12:00:00.000000Z" };
  const calculated = { ...snapshot(), historicalEmploymentRoster: [admission] };
  assert.equal(payRunCalculationSourceChanges(legacy, calculated).roster, true);
  assert.equal(payRunCalculationSourceChanges(calculated, legacy).roster, true);
  for (const replacement of [
    { ...admission, status: "on_leave" }, { ...admission, versionNo: 3 },
    { ...admission, effectiveFrom: "2026-01-22" }, { ...admission, employmentId: "other-employment" },
  ]) assert.equal(payRunCalculationSourceChanges(calculated, { ...snapshot(), historicalEmploymentRoster: [replacement] }).roster, true);
  for (const malformed of [null, {}, false, "[]"]) {
    assert.equal(parsePayRunCalculationSource({ ...snapshot(), historicalEmploymentRoster: malformed }), null);
  }
});
