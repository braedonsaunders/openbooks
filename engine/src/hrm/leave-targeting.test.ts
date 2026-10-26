import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accrualEarned,
  completedServiceYears,
  findSameSpecificityConflict,
  pinnedIds,
  selectPolicy,
  selectReigns,
  targetingSpecificity,
  tieredHoursForDate,
  type PolicyCandidate,
  type AccrualRule,
} from "./leave-math.ts";

/**
 * Leave targeting and service-tier math (pure — no database): specificity
 * weights (employment 8, classification 4, subsidiary 2, department 1),
 * pin matching (listed employment, held classification), per-event tier
 * resolution with the anniversary boundary, and the same-specificity
 * conflict decider every writer shares.
 */

function candidate(overrides: Partial<PolicyCandidate> & { id: string }): PolicyCandidate {
  return {
    employerSubsidiaryId: null,
    departmentId: null,
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

test("specificity resolution order: employment beats classification beats subsidiary beats department beats org-wide", () => {
  const scope = {
    employerSubsidiaryId: "s1",
    departmentId: "d1",
    employmentId: "e1",
    classificationIds: ["c1"],
  };
  const org = candidate({ id: "org" });
  const dept = candidate({ id: "dept", departmentId: "d1" });
  const sub = candidate({ id: "sub", employerSubsidiaryId: "s1" });
  const cls = candidate({ id: "cls", classificationIds: ["c1"] });
  const emp = candidate({ id: "emp", employmentIds: ["e1"] });
  const picked = selectPolicy([org, dept, sub, cls, emp], scope, "2026-06-01");
  assert.equal(picked?.id, "emp");
  assert.equal(selectPolicy([org, dept, sub, cls], scope, "2026-06-01")?.id, "cls");
  assert.equal(selectPolicy([org, dept, sub], scope, "2026-06-01")?.id, "sub");
  assert.equal(selectPolicy([org, dept], scope, "2026-06-01")?.id, "dept");
  assert.equal(selectPolicy([org], scope, "2026-06-01")?.id, "org");
});

test("weights stack across dimensions: employment plus department beats classification alone", () => {
  const scope = {
    employerSubsidiaryId: "s1",
    departmentId: "d1",
    employmentId: "e1",
    classificationIds: ["c1"],
  };
  const clsOnly = candidate({ id: "cls", classificationIds: ["c1"] });
  const empDept = candidate({ id: "emp-dept", employmentIds: ["e1"], departmentId: "d1" });
  assert.equal(selectPolicy([clsOnly, empDept], scope, "2026-06-01")?.id, "emp-dept");
});

test("a pinned employment not listed is not matched — targeting fails closed", () => {
  const scope = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentId: "e2",
    classificationIds: [],
  };
  const pinned = candidate({ id: "pinned", employmentIds: ["e1"] });
  assert.equal(selectPolicy([pinned], scope, "2026-06-01"), null);
  // And a scope that omits the dimension never matches a pinned policy.
  assert.equal(
    selectPolicy([pinned], { employerSubsidiaryId: null, departmentId: null }, "2026-06-01"),
    null,
  );
});

test("classification pins match only a held classification", () => {
  const pinned = candidate({ id: "pinned", classificationIds: ["c1", "c2"] });
  const holding = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentId: "e1",
    classificationIds: ["c2"],
  };
  const bare = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentId: "e1",
    classificationIds: [] as string[],
  };
  assert.equal(selectPolicy([pinned], holding, "2026-06-01")?.id, "pinned");
  assert.equal(selectPolicy([pinned], bare, "2026-06-01"), null);
});

test("completed service years counts whole anniversaries only", () => {
  assert.equal(completedServiceYears("2020-06-15", "2026-06-15"), 6);
  assert.equal(completedServiceYears("2020-06-15", "2026-06-14"), 5);
  assert.equal(completedServiceYears("2020-06-15", "2020-06-15"), 0);
  assert.equal(completedServiceYears("2026-06-15", "2020-06-15"), 0);
});

test("tiers: base below the first tier, tier in force on the anniversary date", () => {
  const rule: AccrualRule = {
    kind: "per_year",
    hours: "80",
    tiers: [{ after_years: 5, hours: "120" }],
  };
  assert.equal(tieredHoursForDate(rule, "80", "2021-06-15", "2026-06-14"), "80");
  assert.equal(tieredHoursForDate(rule, "80", "2021-06-15", "2026-06-15"), "120");
  assert.equal(tieredHoursForDate(rule, "80", null, "2026-06-15"), "80");
});

test("per_year grants price at the tier in force on asOf, never re-rated by a later balance day", () => {
  const rule: AccrualRule = {
    kind: "per_year",
    hours: "80",
    tiers: [{ after_years: 5, hours: "120" }],
  };
  // Anniversary 2026-06-15: an as-of before it prices base, after it prices the tier.
  assert.equal(
    accrualEarned(rule, "2026-01-01", "2026-06-14", { serviceStart: "2021-06-15" }),
    "80",
  );
  assert.equal(
    accrualEarned(rule, "2026-01-01", "2026-06-15", { serviceStart: "2021-06-15" }),
    "120",
  );
  // Reproducible for a past as-of: the same past date always prices the same.
  assert.equal(
    accrualEarned(rule, "2026-01-01", "2026-03-01", { serviceStart: "2021-06-15" }),
    "80",
  );
});

test("per_period slices accrue at the tier in force on each slice's vesting day", () => {
  const rule: AccrualRule = {
    kind: "per_period",
    hours: "10",
    periods_per_year: 12,
    tiers: [{ after_years: 5, hours: "20" }],
  };
  // Service start 2021-02-15: the January slice vests 2026-01-30, before
  // the fifth anniversary, and earns base; every later slice vests after
  // it and earns the tier — earlier slices are never re-rated.
  const full = accrualEarned(rule, "2026-01-01", "2026-12-31", { serviceStart: "2021-02-15" });
  assert.equal(full, "230");
  assert.equal(
    accrualEarned(rule, "2026-01-01", "2026-01-30", { serviceStart: "2021-02-15" }),
    "0",
  );
  assert.equal(
    accrualEarned(rule, "2026-01-01", "2026-01-31", { serviceStart: "2021-02-15" }),
    "10",
  );
});

test("malformed tiers fail closed instead of accruing zero", () => {
  const descending: AccrualRule = {
    kind: "per_year",
    hours: "80",
    tiers: [
      { after_years: 5, hours: "120" },
      { after_years: 3, hours: "100" },
    ],
  };
  assert.throws(
    () => accrualEarned(descending, "2026-01-01", "2026-06-01", { serviceStart: "2010-01-01" }),
    /ascends strictly/,
  );
  const empty: AccrualRule = {
    kind: "per_year",
    hours: "80",
    tiers: [] as { after_years: number; hours: string }[],
  };
  assert.throws(() => accrualEarned(empty, "2026-01-01", "2026-06-01"), /non-empty list/);
  const zero: AccrualRule = {
    kind: "per_year",
    hours: "80",
    tiers: [{ after_years: 0, hours: "120" }],
  };
  assert.throws(() => accrualEarned(zero, "2026-01-01", "2026-06-01"), /positive whole number/);
});

test("targetingSpecificity: binary weights make equal scores mean identical pin patterns", () => {
  const wild = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentIds: null,
    classificationIds: null,
  };
  assert.equal(targetingSpecificity(wild), 0);
  assert.equal(targetingSpecificity({ ...wild, employmentIds: ["e1"], departmentId: "d1" }), 9);
  assert.equal(
    targetingSpecificity({ ...wild, classificationIds: ["c1"], employerSubsidiaryId: "s1" }),
    6,
  );
});

test("same-specificity conflicts refuse intersecting sets and pass disjoint ones", () => {
  const window = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentIds: ["e1"] as readonly string[],
    classificationIds: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31" as string | null,
  };
  const clash = {
    id: "policy-a",
    ...window,
    employmentIds: ["e1", "e2"] as readonly string[],
  };
  assert.equal(findSameSpecificityConflict(window, [clash])?.id, "policy-a");
  const disjoint = { ...clash, id: "policy-b", employmentIds: ["e9"] as readonly string[] };
  assert.equal(findSameSpecificityConflict(window, [disjoint]), null);
  // A different class (wildcard where the candidate pins) resolves by
  // specificity instead of conflicting.
  const broader = { ...clash, id: "policy-c", employmentIds: null };
  assert.equal(findSameSpecificityConflict(window, [broader]), null);
  // A non-overlapping window never conflicts.
  const later = { ...clash, id: "policy-d", effectiveFrom: "2027-01-01", effectiveTo: null };
  assert.equal(findSameSpecificityConflict(window, [later]), null);
});

test("empty target lists read as wildcard in matching, scoring, and conflicts", () => {
  assert.equal(pinnedIds([]), null);
  assert.equal(pinnedIds(null), null);
  assert.deepEqual(pinnedIds(["e1"]), ["e1"]);
  const scope = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentId: "e1",
    classificationIds: [] as string[],
  };
  // An empty employment list matches like a wildcard (score 0)...
  const empty = candidate({ id: "empty", employmentIds: [] });
  assert.equal(selectPolicy([empty], scope, "2026-06-01")?.id, "empty");
  assert.equal(
    targetingSpecificity({
      employerSubsidiaryId: null,
      departmentId: null,
      employmentIds: [],
      classificationIds: null,
    }),
    0,
  );
  // ...so it conflicts with the general policy, never with a pinned one.
  const window = {
    employerSubsidiaryId: null,
    departmentId: null,
    employmentIds: [] as readonly string[],
    classificationIds: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: "2026-12-31" as string | null,
  };
  assert.equal(
    findSameSpecificityConflict(window, [{ id: "general", ...window, employmentIds: null }])?.id,
    "general",
  );
  assert.equal(
    findSameSpecificityConflict(window, [{ id: "pinned", ...window, employmentIds: ["e1"] }]),
    null,
  );
});

test("reigns follow per-day classifications: a mid-period change splits the reign", () => {
  const org = { ...candidate({ id: "org" }), rule: { kind: "per_year", hours: "80" } as const };
  const cls = {
    ...candidate({ id: "cls", classificationIds: ["c1"] }),
    rule: { kind: "per_year", hours: "120" } as const,
  };
  const base = { employerSubsidiaryId: null, departmentId: null, employmentId: "e1" };
  const reigns = selectReigns(
    [org, cls],
    (day) => ({
      ...base,
      classificationIds: day < "2026-04-01" ? (["c1"] as string[]) : ([] as string[]),
    }),
    "2026-01-01",
    "2026-12-31",
  );
  assert.deepEqual(
    reigns.map((reign) => [reign.from, reign.to]),
    [
      ["2026-01-01", "2026-03-31"],
      ["2026-04-01", "2026-12-31"],
    ],
  );
});
