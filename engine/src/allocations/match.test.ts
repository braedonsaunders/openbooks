import assert from "node:assert/strict";
import test from "node:test";
import type {
  AllocationRuleVersion,
  LineCoordinate,
  RuleInEffect,
} from "./types.ts";
import { matchLine, selectRule } from "./match.ts";

let ruleSeq = 0;

function version(overrides: Partial<AllocationRuleVersion> = {}): AllocationRuleVersion {
  return {
    id: `version-${++ruleSeq}`,
    orgId: "org-1",
    ruleId: `rule-${ruleSeq}`,
    versionNo: 1,
    status: "published",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    bookScope: "primary",
    bookIds: [],
    documentKinds: null,
    accountScope: { kind: "any" },
    dimensionFilters: {},
    applyPolicy: "automatic",
    sourceMeasure: "period_activity",
    basisKind: "fixed_percent",
    driverId: null,
    driverAsOf: "period",
    basisConfig: {},
    targetKind: "explicit",
    dynamicTarget: {},
    impact: "reclass",
    offsetAccountId: null,
    residualPolicy: "largest_share",
    residualTargetId: null,
    solveMethod: "sequential",
    runPolicy: "manual",
    runOffsetDays: 0,
    approvalFlowId: null,
    memoTemplate: null,
    lineDescriptionTemplate: null,
    definitionHash: "hash",
    publishedAt: null,
    publishedBy: null,
    ...overrides,
  };
}

function line(overrides: Partial<LineCoordinate> = {}): LineCoordinate {
  return {
    accountId: "account-1",
    subsidiaryId: null,
    departmentId: null,
    locationId: null,
    classId: null,
    projectId: null,
    partyId: null,
    extraDims: {},
    documentKind: "vendor_bill",
    itemId: null,
    amount: "100.0000",
    ...overrides,
  };
}

function candidate(
  key: string,
  sortOrder: number,
  v: Partial<AllocationRuleVersion> = {},
): RuleInEffect {
  const ruleId = `rule-${key}`;
  return {
    rule: {
      id: ruleId,
      orgId: "org-1",
      key,
      name: key,
      description: null,
      mode: "entry",
      sortOrder,
      isActive: true,
      isSystem: false,
      currentVersionId: `version-${key}`,
    },
    version: version({ ruleId, ...v }),
    targets: [],
  };
}

test("matchLine matches an unconstrained version with zero specificity", () => {
  assert.deepEqual(matchLine(version(), line()), { matched: true, specificity: 0 });
});

test("matchLine document_kinds: null matches any kind, list requires membership", () => {
  const v = version({ documentKinds: ["vendor_bill", "card_charge"] });
  assert.equal(matchLine(v, line({ documentKind: "vendor_bill" })).matched, true);
  assert.equal(matchLine(v, line({ documentKind: "customer_invoice" })).matched, false);
  assert.equal(matchLine(v, line({ documentKind: null })).matched, false);
  assert.equal(matchLine(version(), line({ documentKind: "anything" })).matched, true);
});

test("matchLine document_kinds contributes one specificity point when matched", () => {
  const v = version({ documentKinds: ["vendor_bill"] });
  assert.deepEqual(matchLine(v, line({ documentKind: "vendor_bill" })), {
    matched: true,
    specificity: 1,
  });
});

test("matchLine account_scope accounts requires membership", () => {
  const v = version({ accountScope: { kind: "accounts", accountIds: ["a1", "a2"] } });
  assert.deepEqual(matchLine(v, line({ accountId: "a1" })), { matched: true, specificity: 1 });
  assert.equal(matchLine(v, line({ accountId: "a9" })).matched, false);
  assert.deepEqual(matchLine(version({ accountScope: { kind: "any" } }), line()), {
    matched: true,
    specificity: 0,
  });
});

test("matchLine account_scope account_group uses the injected resolver", () => {
  const v = version({
    accountScope: { kind: "account_group", dimension: "cost_pool", groupKey: "overhead" },
  });
  const resolve = () => new Set(["a1", "a2"]);
  assert.deepEqual(matchLine(v, line({ accountId: "a2" }), resolve), {
    matched: true,
    specificity: 1,
  });
  assert.equal(matchLine(v, line({ accountId: "a9" }), resolve).matched, false);
});

test("matchLine account_scope account_group without a resolver never matches", () => {
  const v = version({
    accountScope: { kind: "account_group", dimension: "cost_pool", groupKey: "overhead" },
  });
  assert.deepEqual(matchLine(v, line({ accountId: "a1" })), { matched: false, specificity: 0 });
});

test("matchLine dimension id filters match per dimension with AND semantics", () => {
  const v = version({
    dimensionFilters: { departmentIds: ["d1"], locationIds: ["l1"] },
  });
  assert.deepEqual(
    matchLine(v, line({ departmentId: "d1", locationId: "l1" })),
    { matched: true, specificity: 2 },
  );
  assert.equal(
    matchLine(v, line({ departmentId: "d1", locationId: "l9" })).matched,
    false,
  );
  assert.equal(
    matchLine(v, line({ departmentId: "d1", locationId: null })).matched,
    false,
  );
});

test("matchLine covers class, project, subsidiary, party, and item filters", () => {
  const v = version({
    dimensionFilters: {
      classIds: ["c1"],
      projectIds: ["p1"],
      subsidiaryIds: ["s1"],
      partyIds: ["pt1"],
      itemIds: ["i1"],
    },
  });
  const full = line({
    classId: "c1",
    projectId: "p1",
    subsidiaryId: "s1",
    partyId: "pt1",
    itemId: "i1",
  });
  assert.deepEqual(matchLine(v, full), { matched: true, specificity: 5 });
  assert.equal(matchLine(v, line({ ...full, partyId: "other" })).matched, false);
  assert.equal(matchLine(v, line({ ...full, itemId: null })).matched, false);
});

test("matchLine extraDims filters match per segment key with AND semantics", () => {
  const v = version({
    dimensionFilters: { extraDims: { region: ["r1"], channel: ["ch1", "ch2"] } },
  });
  assert.deepEqual(
    matchLine(v, line({ extraDims: { region: "r1", channel: "ch2" } })),
    { matched: true, specificity: 2 },
  );
  assert.equal(
    matchLine(v, line({ extraDims: { region: "r1" } })).matched,
    false,
  );
  assert.equal(
    matchLine(v, line({ extraDims: { region: "r9", channel: "ch1" } })).matched,
    false,
  );
});

test("matchLine requireUntagged matches only lines with no value in each listed dimension", () => {
  const v = version({ dimensionFilters: { requireUntagged: ["department", "project"] } });
  assert.deepEqual(matchLine(v, line()), { matched: true, specificity: 1 });
  assert.equal(
    matchLine(v, line({ departmentId: "d1" })).matched,
    false,
  );
  assert.equal(
    matchLine(v, line({ projectId: "p1" })).matched,
    false,
  );
});

test("matchLine combines requireUntagged with positive filters under AND", () => {
  const v = version({
    accountScope: { kind: "accounts", accountIds: ["a1"] },
    dimensionFilters: { locationIds: ["l1"], requireUntagged: ["department"] },
  });
  assert.deepEqual(matchLine(v, line({ accountId: "a1", locationId: "l1" })), {
    matched: true,
    specificity: 3,
  });
  assert.equal(
    matchLine(v, line({ accountId: "a1", locationId: "l1", departmentId: "d1" })).matched,
    false,
  );
});

test("matchLine reports zero specificity on any mismatch", () => {
  const v = version({
    documentKinds: ["vendor_bill"],
    dimensionFilters: { departmentIds: ["d1"] },
  });
  assert.deepEqual(matchLine(v, line({ documentKind: "vendor_bill", departmentId: "d9" })), {
    matched: false,
    specificity: 0,
  });
});

test("selectRule returns null when nothing matches", () => {
  const pool = [candidate("a", 10, { dimensionFilters: { departmentIds: ["d1"] } })];
  assert.equal(selectRule(pool, line()), null);
  assert.equal(selectRule([], line()), null);
});

test("selectRule prefers the most specific match", () => {
  const generic = candidate("generic", 10);
  const specific = candidate("specific", 90, {
    dimensionFilters: { departmentIds: ["d1"], locationIds: ["l1"] },
  });
  const winner = selectRule([generic, specific], line({ departmentId: "d1", locationId: "l1" }));
  assert.equal(winner?.rule.key, "specific");
});

test("selectRule breaks specificity ties by sort_order then key", () => {
  const b = candidate("b-rule", 20, { dimensionFilters: { departmentIds: ["d1"] } });
  const a = candidate("a-rule", 20, { dimensionFilters: { locationIds: ["l1"] } });
  const late = candidate("late", 99, { dimensionFilters: { classIds: ["c1"] } });
  const l = line({ departmentId: "d1", locationId: "l1", classId: "c1" });
  assert.equal(selectRule([b, a], l)?.rule.key, "a-rule");
  assert.equal(selectRule([late, b], line({ departmentId: "d1", classId: "c1" }))?.rule.key, "b-rule");
});

test("selectRule applies the applyPolicy filter when given", () => {
  const auto = candidate("auto", 10, { applyPolicy: "automatic" });
  const manual = candidate("manual", 5, {
    applyPolicy: "manual",
    dimensionFilters: { departmentIds: ["d1"] },
  });
  const l = line({ departmentId: "d1" });
  assert.equal(selectRule([auto, manual], l)?.rule.key, "manual");
  assert.equal(selectRule([auto, manual], l, { applyPolicy: "automatic" })?.rule.key, "auto");
  assert.equal(
    selectRule([auto, manual], l, { applyPolicy: ["suggest", "manual"] })?.rule.key,
    "manual",
  );
  assert.equal(selectRule([auto], l, { applyPolicy: "suggest" }), null);
});

test("selectRule forwards the account group resolver to every candidate", () => {
  const grouped = candidate("grouped", 10, {
    accountScope: { kind: "account_group", dimension: "cost_pool", groupKey: "overhead" },
  });
  const plain = candidate("plain", 50);
  const resolve = () => new Set(["a1"]);
  assert.equal(
    selectRule([grouped, plain], line({ accountId: "a1" }), { resolveAccountGroup: resolve })
      ?.rule.key,
    "grouped",
  );
  assert.equal(selectRule([grouped, plain], line({ accountId: "a1" }))?.rule.key, "plain");
});
