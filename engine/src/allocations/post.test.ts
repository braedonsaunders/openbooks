import assert from "node:assert/strict";
import test from "node:test";
import {
  assertContributorBalance,
  collectPostContributions,
  resolveRuleBooks,
  __testBuildContributedLines,
  type PostableDocument,
  type PostRunner,
  type PostSourceLine,
  type PostingBook,
} from "./post.ts";
import type { AllocationRuleTarget, RuleInEffect, WeightedTarget } from "./types.ts";

const emptyRunner = {
  execute: (async () => ({ rows: [] })) as unknown as PostRunner["execute"],
};

/** Stub runner answering registry reads by matching the query text. */
function stubRunner(
  answer: (queryText: string) => Record<string, unknown>[],
): PostRunner {
  return {
    execute: (async (query: unknown) => ({ rows: answer(JSON.stringify(query)) })) as unknown as PostRunner["execute"],
  };
}

const DRIVER_ROW = {
  id: "drv-1",
  key: "drv",
  name: "Driver",
  unit: null,
  dimension: "department",
  is_active: true,
  source_kind: "manual",
  config: {},
};

const driverRunner = stubRunner((text) => {
  if (text.includes("allocation_drivers")) return [DRIVER_ROW];
  if (text.includes("departments")) return [{ id: "dept-a" }, { id: "dept-b" }];
  return [];
});

const gateOn = () => Promise.resolve(true);

function target(overrides: Partial<AllocationRuleTarget> & { sequence: number }): AllocationRuleTarget {
  return {
    targetAccountId: null,
    departmentId: null,
    locationId: null,
    classId: null,
    projectId: null,
    subsidiaryId: null,
    extraDims: {},
    fixedPercent: null,
    weight: null,
    isRemainder: false,
    label: null,
    ...overrides,
  };
}

function ruleFixture(overrides?: {
  rule?: Partial<RuleInEffect["rule"]>;
  version?: Partial<RuleInEffect["version"]>;
  targets?: AllocationRuleTarget[];
}): RuleInEffect {
  return {
    rule: {
      id: "rule-1",
      orgId: "org-1",
      key: "test-rule",
      name: "Test Rule",
      mode: "post",
      sortOrder: 100,
      isActive: true,
      isSystem: false,
      currentVersionId: "v-1",
      ...overrides?.rule,
    },
    version: {
      id: "v-1",
      orgId: "org-1",
      ruleId: "rule-1",
      versionNo: 1,
      status: "published",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      bookScope: "primary",
      bookIds: [],
      documentKinds: ["vendor_bill"],
      accountScope: { kind: "accounts", accountIds: ["acct-expense"] },
      dimensionFilters: {},
      applyPolicy: "automatic",
      sourceMeasure: "period_activity",
      basisKind: "fixed_percent",
      driverId: null,
      driverAsOf: "document_date",
      basisConfig: {},
      targetKind: "explicit",
      dynamicTarget: {},
      impact: "net_zero_pair",
      offsetAccountId: null,
      residualPolicy: "largest_share",
      residualTargetId: null,
      solveMethod: "sequential",
      runPolicy: "manual",
      runOffsetDays: 0,
      approvalFlowId: null,
      memoTemplate: null,
      lineDescriptionTemplate: null,
      definitionHash: "hash-1",
      ...overrides?.version,
    },
    targets: overrides?.targets ?? [
      target({ sequence: 1, departmentId: "dept-a", fixedPercent: "60.0000", label: "Team A" }),
      target({ sequence: 2, departmentId: "dept-b", fixedPercent: "40.0000", label: "Team B" }),
    ],
  };
}

const docFixture: PostableDocument = {
  id: "doc-1",
  orgId: "org-1",
  kind: "vendor_bill",
  documentDate: "2026-07-15",
  currency: "CAD",
  subsidiaryId: null,
};

const expenseLine: PostSourceLine = {
  accountId: "acct-expense",
  amount: "100.0000",
  departmentId: "dept-src",
};

function weights(keys: string[], values: string[]): WeightedTarget[] {
  return keys.map((key, i) => ({ key, weight: values[i]! }));
}

// Exactness and percent validation belong to A1's apportion.ts (tested
// there); post-mode pins impacts, balance, books, and wiring.
// ---------------------------------------------------------------------------
// assertContributorBalance
// ---------------------------------------------------------------------------

test("assertContributorBalance passes balanced sets and refuses the rest", () => {
  assertContributorBalance([
    { contributorKind: "rule", contributorRef: "v-1", subsidiaryId: null, amount: "60.0000" },
    { contributorKind: "rule", contributorRef: "v-1", subsidiaryId: null, amount: "-60.0000" },
    { contributorKind: "rule", contributorRef: "v-2", subsidiaryId: "sub-x", amount: "1.0000" },
    { contributorKind: "rule", contributorRef: "v-2", subsidiaryId: "sub-x", amount: "-1.0000" },
  ]);
  assert.throws(
    () =>
      assertContributorBalance([
        { contributorKind: "rule", contributorRef: "v-9", subsidiaryId: null, amount: "60.0000" },
        { contributorKind: "rule", contributorRef: "v-9", subsidiaryId: null, amount: "-59.9999" },
      ]),
    /v-9.*does not balance/,
  );
  // Same contributor split across subsidiaries must balance in each one.
  assert.throws(
    () =>
      assertContributorBalance([
        { contributorKind: "rule", contributorRef: "v-9", subsidiaryId: "a", amount: "5.0000" },
        { contributorKind: "rule", contributorRef: "v-9", subsidiaryId: "b", amount: "-5.0000" },
      ]),
    /does not balance/,
  );
});

// ---------------------------------------------------------------------------
// Impact line building
// ---------------------------------------------------------------------------

test("net_zero_pair adds dimensional attribution without moving account totals", () => {
  const { lines, reportOnly } = __testBuildContributedLines({
    rule: ruleFixture(),
    doc: docFixture,
    kernelLine: expenseLine,
    sourceKernelIndex: 0,
    coords: ruleFixture().targets,
    weights: weights(["t1", "t2"], ["60", "40"]),
    books: [undefined],
  });
  assert.equal(reportOnly.length, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => [l.accountId, l.departmentId, l.amount]), [
    ["acct-expense", "dept-a", "60.0000"],
    ["acct-expense", "dept-b", "40.0000"],
    ["acct-expense", "dept-src", "-100.0000"],
  ]);
  for (const line of lines) {
    assert.equal(line.contributorKind, "rule");
    assert.equal(line.contributorRef, "v-1");
    assert.equal(line.sourceKernelIndex, 0);
    assert.ok(line.lineage);
    assert.equal(line.lineage?.ruleId, "rule-1");
  }
  // Net zero at the account level by construction.
  const accountTotal = lines
    .filter((l) => l.accountId === "acct-expense")
    .reduce((acc, l) => acc + Number(l.amount.replace(".", "")), 0);
  assert.equal(accountTotal, 0);
});

test("reclass moves the cost to the target account with an offset credit", () => {
  const targets = [
    target({ sequence: 1, targetAccountId: "acct-cogs", departmentId: "dept-a", fixedPercent: "100.0000" }),
  ];
  const { lines } = __testBuildContributedLines({
    rule: ruleFixture({
      version: { impact: "reclass" },
      targets,
    }),
    doc: docFixture,
    kernelLine: expenseLine,
    sourceKernelIndex: 2,
    coords: targets,
    weights: weights(["t1"], ["100"]),
    books: [undefined],
  });
  assert.deepEqual(lines.map((l) => [l.accountId, l.amount]), [
    ["acct-cogs", "100.0000"],
    ["acct-expense", "-100.0000"],
  ]);
  assert.equal(lines[0]!.sourceKernelIndex, 2);
});

test("reclass honors the offset account for the credit side", () => {
  const targets = [target({ sequence: 1, departmentId: "dept-a", fixedPercent: "100.0000" })];
  const { lines } = __testBuildContributedLines({
    rule: ruleFixture({ version: { impact: "reclass", offsetAccountId: "acct-clearing" }, targets }),
    doc: docFixture,
    kernelLine: expenseLine,
    sourceKernelIndex: 0,
    coords: targets,
    weights: weights(["t1"], ["100"]),
    books: [undefined],
  });
  assert.deepEqual(lines.map((l) => [l.accountId, l.amount]), [
    ["acct-expense", "100.0000"],
    ["acct-clearing", "-100.0000"],
  ]);
});

test("report_only writes lineage drafts and no GL lines", () => {
  const { lines, reportOnly } = __testBuildContributedLines({
    rule: ruleFixture({ version: { impact: "report_only" } }),
    doc: docFixture,
    kernelLine: expenseLine,
    sourceKernelIndex: 0,
    coords: ruleFixture().targets,
    weights: weights(["t1", "t2"], ["60", "40"]),
    books: [undefined],
  });
  assert.equal(lines.length, 0);
  assert.equal(reportOnly.length, 2);
  assert.deepEqual(reportOnly.map((r) => r.amount), ["60.0000", "40.0000"]);
  for (const draft of reportOnly) {
    assert.equal(draft.mode, "post");
    assert.equal(draft.documentId, "doc-1");
    assert.equal(draft.sourceKernelIndex, 0);
  }
});

test("net_zero_pair refuses a target account (account totals must not move)", () => {
  const targets = [
    target({ sequence: 1, targetAccountId: "acct-other", departmentId: "dept-a", fixedPercent: "100.0000" }),
  ];
  assert.throws(
    () =>
      __testBuildContributedLines({
        rule: ruleFixture({ targets }),
        doc: docFixture,
        kernelLine: expenseLine,
        sourceKernelIndex: 0,
        coords: targets,
        weights: weights(["t1"], ["100"]),
        books: [undefined],
      }),
    /net_zero_pair but names a target account/,
  );
});

test("zero-weight targets write no zero-amount GL line", () => {
  const { lines } = __testBuildContributedLines({
    rule: ruleFixture(),
    doc: docFixture,
    kernelLine: { ...expenseLine, amount: "0.0001" },
    sourceKernelIndex: 0,
    coords: ruleFixture().targets,
    weights: weights(["t1", "t2"], ["1", "0"]),
    books: [undefined],
  });
  assert.ok(lines.every((l) => l.amount !== "0.0000"));
  const total = lines.reduce((acc, l) => acc + Number(l.amount.replace(".", "")), 0);
  assert.equal(total, 0);
});

test("memo templates render rule and target names", () => {
  const { lines } = __testBuildContributedLines({
    rule: ruleFixture({ version: { lineDescriptionTemplate: "{{rule.name}} to {{target.label}}" } }),
    doc: docFixture,
    kernelLine: expenseLine,
    sourceKernelIndex: 0,
    coords: ruleFixture().targets,
    weights: weights(["t1", "t2"], ["60", "40"]),
    books: [undefined],
  });
  assert.equal(lines[0]!.memo, "Test Rule to Team A");
});

// ---------------------------------------------------------------------------
// Rule books
// ---------------------------------------------------------------------------

const booksFixture: PostingBook[] = [
  { id: "book-pri", code: "PRI", isPrimary: true, isActive: true, postsGl: true },
  { id: "book-sec", code: "SEC", isPrimary: false, isActive: true, postsGl: true },
  { id: "book-dead", code: "OLD", isPrimary: false, isActive: false, postsGl: true },
];

test("resolveRuleBooks covers primary, all_posting, and listed books", () => {
  assert.deepEqual(resolveRuleBooks(ruleFixture(), booksFixture), [undefined]);
  assert.deepEqual(
    resolveRuleBooks(ruleFixture({ version: { bookScope: "all_posting" } }), booksFixture),
    [undefined, "book-sec"],
  );
  assert.deepEqual(
    resolveRuleBooks(ruleFixture({ version: { bookScope: "books", bookIds: ["book-sec"] } }), booksFixture),
    ["book-sec"],
  );
  assert.throws(
    () => resolveRuleBooks(ruleFixture({ version: { bookScope: "books", bookIds: ["book-dead"] } }), booksFixture),
    /not an active posting book/,
  );
  assert.throws(
    () => resolveRuleBooks(ruleFixture({ version: { bookScope: "books", bookIds: ["nope"] } }), booksFixture),
    /unknown book/,
  );
});

// ---------------------------------------------------------------------------
// collectPostContributions (wiring: gates, skips, real matcher)
// ---------------------------------------------------------------------------

test("migration, suppressAutomation, and a closed gate contribute nothing", async () => {
  const rule = ruleFixture();
  for (const deps of [
    { rulesOverride: [rule], migration: true as const, featureGate: gateOn },
    { rulesOverride: [rule], suppressAutomation: true as const, featureGate: gateOn },
    { rulesOverride: [rule], featureGate: () => Promise.resolve(false) },
  ]) {
    const result = await collectPostContributions(emptyRunner, docFixture, [expenseLine], deps, {
      postingDate: "2026-07-15",
    });
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.reportOnly, []);
  }
});

test("a rule scoped to another document kind never fires", async () => {
  const result = await collectPostContributions(
    emptyRunner,
    docFixture,
    [expenseLine],
    { rulesOverride: [ruleFixture({ version: { documentKinds: ["journal"] } })], featureGate: gateOn },
    { postingDate: "2026-07-15" },
  );
  assert.deepEqual(result.lines, []);
});

test("the most specific matching rule wins per kernel line", async () => {
  const generic = ruleFixture({
    rule: { key: "generic", name: "Generic" },
    version: { id: "v-generic", accountScope: { kind: "any" }, documentKinds: null },
  });
  const specific = ruleFixture({
    rule: { key: "specific", name: "Specific", sortOrder: 200 },
    version: { id: "v-specific" },
  });
  const result = await collectPostContributions(
    emptyRunner,
    docFixture,
    [expenseLine],
    { rulesOverride: [generic, specific], featureGate: gateOn },
    { postingDate: "2026-07-15" },
  );
  assert.equal(result.lines.length, 3);
  assert.ok(result.lines.every((l) => l.contributorRef === "v-specific"));
});

test("driver-basis explicit targets resolve through the injected resolver", async () => {
  const targets = [
    target({ sequence: 1, departmentId: "dept-a" }),
    target({ sequence: 2, departmentId: "dept-b" }),
  ];
  const result = await collectPostContributions(
    driverRunner,
    docFixture,
    [expenseLine],
    {
      rulesOverride: [
        ruleFixture({
          version: { basisKind: "driver", driverId: "drv-1" },
          targets,
        }),
      ],
      driverResolver: {
        resolve: () => Promise.resolve(new Map([["dept-a", "3.0000"], ["dept-b", "1.0000"]])),
      },
      featureGate: gateOn,
    },
    { postingDate: "2026-07-15" },
  );
  assert.deepEqual(result.lines.map((l) => l.amount), ["75.0000", "25.0000", "-100.0000"]);
  assert.equal(result.lines[0]!.lineage?.driverValue, "3.0000");
  assert.equal(result.lines[0]!.lineage?.driverTotal, "4.0000");
});

test("dynamic targets fan out to every measured dimension value", async () => {
  const result = await collectPostContributions(
    driverRunner,
    docFixture,
    [expenseLine],
    {
      rulesOverride: [
        ruleFixture({
          version: {
            basisKind: "driver",
            driverId: "drv-1",
            targetKind: "dynamic",
            dynamicTarget: { dimension: "department", minWeight: "0" },
          },
          targets: [],
        }),
      ],
      driverResolver: {
        resolve: () => Promise.resolve(new Map([["dept-a", "1.0000"], ["dept-b", "1.0000"]])),
      },
      featureGate: gateOn,
    },
    { postingDate: "2026-07-15" },
  );
  // Two 50.0000 target debits plus the -100.0000 source credit.
  assert.deepEqual(result.lines.map((l) => l.amount), ["50.0000", "50.0000", "-100.0000"]);
  assert.deepEqual(result.lines.slice(0, 2).map((l) => l.departmentId), ["dept-a", "dept-b"]);
});
