import assert from "node:assert/strict";
import test from "node:test";
import {
  EntryAllocationError,
  explodeDocumentLine,
  planEntryDistributions,
  type EntryDocumentContext,
  type EntryLineInput,
} from "./entry.ts";
import type { AllocationRuleTarget, RuleInEffect } from "./types.ts";

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function target(overrides: Partial<AllocationRuleTarget> = {}): AllocationRuleTarget {
  return {
    id: nextId("target"),
    sequence: 0,
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

function rule(
  key: string,
  targets: AllocationRuleTarget[],
  versionOverrides: Partial<RuleInEffect["version"]> = {},
  ruleOverrides: Partial<RuleInEffect["rule"]> = {},
): RuleInEffect {
  const ruleId = nextId("rule");
  const versionId = nextId("version");
  targets.forEach((t, i) => {
    t.sequence = i;
  });
  return {
    rule: {
      id: ruleId,
      orgId: "org-1",
      key,
      name: key,
      description: null,
      mode: "entry",
      sortOrder: 100,
      isActive: true,
      isSystem: false,
      currentVersionId: versionId,
      ...ruleOverrides,
    },
    version: {
      id: versionId,
      orgId: "org-1",
      ruleId,
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
      definitionHash: "hash-1",
      publishedAt: null,
      publishedBy: null,
      ...versionOverrides,
    },
    targets,
  };
}

function doc(overrides: Partial<EntryDocumentContext> = {}): EntryDocumentContext {
  return { kind: "vendor_bill", ...overrides };
}

function entryLine(overrides: Partial<EntryLineInput> = {}): EntryLineInput {
  return {
    accountId: "account-src",
    amount: "100.0000",
    quantity: null,
    unit: null,
    unitPrice: null,
    itemId: null,
    description: "source line",
    taxCodeId: null,
    taxGroupId: null,
    partyId: null,
    departmentId: null,
    projectId: null,
    locationId: null,
    classId: null,
    subsidiaryId: null,
    stockLocationId: null,
    extraDims: {},
    custom: {},
    isBillable: null,
    distributionKey: null,
    distributionGroupId: null,
    distributionLocked: null,
    ...overrides,
  };
}

function sumAmounts(amounts: string[]): string {
  let total = 0n;
  for (const a of amounts) {
    const [whole = "0", frac = ""] = a.replace("-", "").split(".");
    const units = BigInt(whole) * 10000n + BigInt((frac + "0000").slice(0, 4));
    total += a.startsWith("-") ? -units : units;
  }
  const neg = total < 0n;
  const abs = neg ? -total : total;
  return `${neg ? "-" : ""}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, "0")}`;
}

// --- explodeDocumentLine: fixed_percent -------------------------------------

test("explode splits a fixed 60/40 line exactly with shared stamps", () => {
  const r = rule("split", [
    target({ departmentId: "d1", fixedPercent: "60" }),
    target({ departmentId: "d2", fixedPercent: "40" }),
  ]);
  const { children, apportionments } = explodeDocumentLine(entryLine({ amount: "100.0000" }), r, {
    groupId: "group-1",
  });
  assert.equal(children.length, 2);
  assert.deepEqual(children.map((c) => c.amount), ["60.0000", "40.0000"]);
  assert.equal(sumAmounts(children.map((c) => c.amount)), "100.0000");
  for (const child of children) {
    assert.equal(child.distributionGroupId, "group-1");
    assert.equal(child.distributionRuleId, r.rule.id);
    assert.equal(child.distributionVersionId, r.version.id);
    assert.equal(child.distributionLocked, false);
  }
  assert.deepEqual(children.map((c) => c.departmentId), ["d1", "d2"]);
  assert.deepEqual(apportionments.map((a) => a.residual), ["0.0000", "0.0000"]);
});

test("explode places the rounding residual per policy and never loses a cent", () => {
  const r = rule("thirds", [
    target({ departmentId: "d1", fixedPercent: "33.3333" }),
    target({ departmentId: "d2", fixedPercent: "33.3333" }),
    target({ departmentId: "d3", fixedPercent: "33.3334" }),
  ]);
  const { children, apportionments } = explodeDocumentLine(entryLine({ amount: "10.0000" }), r, {
    groupId: "group-1",
  });
  assert.deepEqual(children.map((c) => c.amount), ["3.3333", "3.3333", "3.3334"]);
  assert.equal(sumAmounts(children.map((c) => c.amount)), "10.0000");
  assert.deepEqual(apportionments.map((a) => a.residual), ["0.0000", "0.0000", "0.0001"]);
});

test("explode gives a remainder target the leftover percent", () => {
  const r = rule("rem", [
    target({ departmentId: "d1", fixedPercent: "60" }),
    target({ departmentId: "d2", isRemainder: true }),
  ]);
  const { children } = explodeDocumentLine(entryLine({ amount: "200.0000" }), r, {
    groupId: "group-1",
  });
  assert.deepEqual(children.map((c) => c.amount), ["120.0000", "80.0000"]);
});

test("explode overrides target account and dims but inherits line economics", () => {
  const r = rule("over", [
    target({
      targetAccountId: "account-new",
      departmentId: "d9",
      fixedPercent: "100",
      extraDims: { region: "r1" },
      label: "Ops share",
    }),
  ]);
  const { children } = explodeDocumentLine(
    entryLine({
      amount: "50.0000",
      itemId: "item-1",
      description: "widgets",
      taxCodeId: "tax-1",
      taxGroupId: null,
      partyId: "party-1",
      isBillable: true,
      unitPrice: "5.00000000",
      custom: { origin: "import" },
      extraDims: { region: "r0", channel: "ch1" },
    }),
    r,
    { groupId: "group-1" },
  );
  const child = children[0]!;
  assert.equal(child.accountId, "account-new");
  assert.equal(child.departmentId, "d9");
  assert.equal(child.itemId, "item-1");
  assert.equal(child.description, "widgets");
  assert.equal(child.taxCodeId, "tax-1");
  assert.equal(child.partyId, "party-1");
  assert.equal(child.isBillable, true);
  assert.equal(child.unitPrice, "5.00000000");
  assert.deepEqual(child.custom, { origin: "import" });
  assert.deepEqual(child.extraDims, { region: "r1", channel: "ch1" });
});

test("explode keeps the source account and dims when the target leaves them null", () => {
  const r = rule("same", [target({ fixedPercent: "100" })]);
  const { children } = explodeDocumentLine(
    entryLine({ accountId: "a-src", departmentId: "d-src", amount: "7.5000" }),
    r,
    { groupId: "group-1" },
  );
  assert.equal(children[0]!.accountId, "a-src");
  assert.equal(children[0]!.departmentId, "d-src");
});

test("explode apportions quantity proportionally so it still sums to the parent", () => {
  const r = rule("q", [
    target({ departmentId: "d1", fixedPercent: "60" }),
    target({ departmentId: "d2", fixedPercent: "40" }),
  ]);
  const { children } = explodeDocumentLine(
    entryLine({ amount: "100.0000", quantity: "7" }),
    r,
    { groupId: "group-1" },
  );
  assert.equal(children.length, 2);
  let total = 0n;
  for (const child of children) {
    const [whole = "0", frac = ""] = String(child.quantity).split(".");
    total += BigInt(whole) * 100000000n + BigInt((frac + "00000000").slice(0, 8));
  }
  assert.equal(total, 700000000n);
});

test("explode handles negative and zero amounts exactly", () => {
  const r = rule("neg", [
    target({ departmentId: "d1", fixedPercent: "60" }),
    target({ departmentId: "d2", fixedPercent: "40" }),
  ]);
  const neg = explodeDocumentLine(entryLine({ amount: "-100.0000" }), r, { groupId: "g" });
  assert.equal(sumAmounts(neg.children.map((c) => c.amount)), "-100.0000");
  const zero = explodeDocumentLine(entryLine({ amount: "0.0000" }), r, { groupId: "g" });
  assert.deepEqual(zero.children.map((c) => c.amount), ["0.0000", "0.0000"]);
});

test("explode renders the line description template with rule and target vars", () => {
  const r = rule(
    "tmpl",
    [target({ departmentId: "d1", fixedPercent: "100", label: "Ops" })],
    { lineDescriptionTemplate: "{{rule.name}} — {{target.label}}" },
  );
  const { children } = explodeDocumentLine(entryLine({ description: "original" }), r, {
    groupId: "g",
  });
  assert.equal(children[0]!.description, "tmpl — Ops");
});

test("explode rejects misconfigured fixed_percent rules", () => {
  const twoRemainders = rule("bad1", [
    target({ fixedPercent: "50", isRemainder: true }),
    target({ isRemainder: true }),
  ]);
  assert.throws(() => explodeDocumentLine(entryLine(), twoRemainders, { groupId: "g" }), EntryAllocationError);
  const overHundred = rule("bad2", [
    target({ fixedPercent: "60" }),
    target({ fixedPercent: "50" }),
  ]);
  assert.throws(() => explodeDocumentLine(entryLine(), overHundred, { groupId: "g" }), EntryAllocationError);
  const missingPercent = rule("bad3", [target({ departmentId: "d1" })]);
  assert.throws(() => explodeDocumentLine(entryLine(), missingPercent, { groupId: "g" }), EntryAllocationError);
});

test("explode refuses a fixed grid under 100 with no remainder target", () => {
  const r = rule("short", [target({ fixedPercent: "60" }), target({ fixedPercent: "30" })]);
  assert.throws(() => explodeDocumentLine(entryLine(), r, { groupId: "g" }), EntryAllocationError);
});

test("explode rejects stepped basis and dynamic targets without a resolver", () => {
  const stepped = rule("step", [target({ fixedPercent: "100" })], { basisKind: "stepped" });
  assert.throws(() => explodeDocumentLine(entryLine(), stepped, { groupId: "g" }), EntryAllocationError);
  const dynamic = rule("dyn", [], { targetKind: "dynamic" });
  assert.throws(() => explodeDocumentLine(entryLine(), dynamic, { groupId: "g" }), EntryAllocationError);
});

test("explode resolves driver weights for explicit targets", () => {
  const r = rule(
    "drv",
    [
      target({ departmentId: "d1", weight: "3" }),
      target({ departmentId: "d2", weight: "1" }),
    ],
    { basisKind: "driver", driverId: "driver-1" },
  );
  const { children } = explodeDocumentLine(entryLine({ amount: "100.0000" }), r, {
    groupId: "g",
  });
  assert.deepEqual(children.map((c) => c.amount), ["75.0000", "25.0000"]);
});

test("explode rejects a driver basis whose weights are all zero", () => {
  const r = rule(
    "drv0",
    [target({ departmentId: "d1" }), target({ departmentId: "d2" })],
    { basisKind: "driver", driverId: "driver-1" },
  );
  assert.throws(
    () => explodeDocumentLine(entryLine(), r, { groupId: "g", driverVector: new Map() }),
    EntryAllocationError,
  );
});

// --- planEntryDistributions --------------------------------------------------

const autoRule = () =>
  rule(
    "auto-split",
    [target({ departmentId: "d1", fixedPercent: "50" }), target({ departmentId: "d2", fixedPercent: "50" })],
    { applyPolicy: "automatic", dimensionFilters: { departmentIds: ["d0"] } },
  );

test("plan explodes an automatic match and stamps lineage per child", () => {
  const r = autoRule();
  const plan = planEntryDistributions(
    doc(),
    [entryLine({ amount: "80.0000", departmentId: "d0" })],
    [r],
    { newGroupId: () => "group-new" },
  );
  assert.equal(plan.exploded, true);
  assert.equal(plan.lines.length, 2);
  assert.equal(sumAmounts(plan.lines.map((l) => l.amount)), "80.0000");
  assert.equal(plan.lineage.length, 2);
  for (const [i, row] of plan.lineage.entries()) {
    assert.equal(row.ruleId, r.rule.id);
    assert.equal(row.versionId, r.version.id);
    assert.equal(row.definitionHash, "hash-1");
    assert.equal(row.targetLineIndex, i);
    assert.equal(row.sourceDocumentLineId, null);
  }
  assert.deepEqual(plan.lines.map((l) => l.distributionGroupId), ["group-new", "group-new"]);
});

test("plan uses header-default dims when the line leaves them blank", () => {
  const r = autoRule();
  const plan = planEntryDistributions(
    doc({ departmentId: "d0" }),
    [entryLine({ amount: "80.0000", departmentId: null })],
    [r],
    { newGroupId: () => "group-new" },
  );
  assert.equal(plan.lines.length, 2);
});

test("plan leaves unmatched lines plain without lineage", () => {
  const r = autoRule();
  const plan = planEntryDistributions(doc(), [entryLine({ departmentId: "other" })], [r]);
  assert.equal(plan.exploded, false);
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0]!.distributionGroupId, null);
  assert.deepEqual(plan.lineage, []);
});

test("plan explodes an explicit distributionKey regardless of apply policy", () => {
  const r = rule(
    "manual-split",
    [target({ departmentId: "d1", fixedPercent: "100" })],
    { applyPolicy: "manual" },
  );
  const plan = planEntryDistributions(
    doc(),
    [entryLine({ amount: "30.0000", distributionKey: "manual-split" })],
    [r],
    { explicitRules: new Map([[r.rule.key, r]]), newGroupId: () => "group-new" },
  );
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0]!.departmentId, "d1");
  assert.equal(plan.lineage.length, 1);
});

test("plan rejects an explicit key with no resolved rule", () => {
  assert.throws(
    () =>
      planEntryDistributions(
        doc(),
        [entryLine({ distributionKey: "missing-key" })],
        [],
        { explicitRules: new Map() },
      ),
    (error: unknown) =>
      error instanceof EntryAllocationError && error.code === "unknown_key",
  );
});

test("plan keeps the line plain when an automatic rule is misconfigured", () => {
  const broken = rule("broken", [target({ departmentId: "d1" })], {
    applyPolicy: "automatic",
  });
  const plan = planEntryDistributions(doc(), [entryLine({ amount: "10.0000" })], [broken]);
  assert.equal(plan.exploded, false);
  assert.equal(plan.lines.length, 1);
  assert.deepEqual(plan.lineage, []);
});

test("plan regenerates a stored group whose submitted sum changed", () => {
  const r = autoRule();
  const lines = [
    entryLine({ amount: "50.0000", departmentId: "d1", distributionGroupId: "group-1" }),
    entryLine({ amount: "70.0000", departmentId: "d2", distributionGroupId: "group-1" }),
  ];
  const plan = planEntryDistributions(doc(), lines, [r], {
    existingGroups: new Map([
      [
        "group-1",
        {
          groupId: "group-1",
          ruleId: r.rule.id,
          versionId: r.version.id,
          locked: false,
          total: "80.0000",
          memberIds: ["old-child-1", "old-child-2"],
        },
      ],
    ]),
  });
  assert.equal(plan.exploded, true);
  assert.equal(plan.lines.length, 2);
  assert.equal(sumAmounts(plan.lines.map((l) => l.amount)), "120.0000");
  assert.deepEqual(plan.lines.map((l) => l.distributionGroupId), ["group-1", "group-1"]);
  assert.equal(plan.lineage.length, 2);
  for (const row of plan.lineage) {
    assert.equal(row.sourceDocumentLineId, "old-child-1");
  }
});

test("plan keeps a stored group untouched when its sum is unchanged", () => {
  const r = autoRule();
  const lines = [
    entryLine({ amount: "40.0000", departmentId: "d1", distributionGroupId: "group-1" }),
    entryLine({ amount: "40.0000", departmentId: "d2", distributionGroupId: "group-1" }),
  ];
  const plan = planEntryDistributions(doc(), lines, [r], {
    existingGroups: new Map([
      [
        "group-1",
        {
          groupId: "group-1",
          ruleId: r.rule.id,
          versionId: r.version.id,
          locked: false,
          total: "80.0000",
          memberIds: ["old-child-1", "old-child-2"],
        },
      ],
    ]),
  });
  assert.equal(plan.exploded, false);
  assert.deepEqual(plan.lines.map((l) => l.amount), ["40.0000", "40.0000"]);
  assert.deepEqual(plan.lineage, []);
});

test("plan never regenerates a locked group", () => {
  const r = autoRule();
  const changed = [
    entryLine({ amount: "10.0000", departmentId: "d1", distributionGroupId: "group-1" }),
    entryLine({ amount: "90.0000", departmentId: "d9", distributionGroupId: "group-1" }),
  ];
  const stored = {
    groupId: "group-1",
    ruleId: r.rule.id,
    versionId: r.version.id,
    locked: true,
    total: "80.0000",
    memberIds: ["old-child-1", "old-child-2"],
  };
  const kept = planEntryDistributions(doc(), changed, [r], {
    existingGroups: new Map([["group-1", stored]]),
  });
  assert.equal(kept.exploded, false);
  assert.deepEqual(kept.lines.map((l) => l.departmentId), ["d1", "d9"]);

  const incomingLock = planEntryDistributions(
    doc(),
    changed.map((l) => ({ ...l, distributionLocked: true })),
    [r],
    { existingGroups: new Map([["group-1", { ...stored, locked: false }]]) },
  );
  assert.equal(incomingLock.exploded, false);
  assert.ok(incomingLock.lines.every((l) => l.distributionLocked));
});

test("plan unlocks a group on an explicit false and regenerates the changed sum", () => {
  const r = autoRule();
  const plan = planEntryDistributions(
    doc(),
    [
      entryLine({ amount: "50.0000", departmentId: "d1", distributionGroupId: "group-1", distributionLocked: false }),
      entryLine({ amount: "70.0000", departmentId: "d2", distributionGroupId: "group-1", distributionLocked: false }),
    ],
    [r],
    {
      existingGroups: new Map([
        [
          "group-1",
          {
            groupId: "group-1",
            ruleId: r.rule.id,
            versionId: r.version.id,
            locked: true,
            total: "80.0000",
            memberIds: ["old-child-1", "old-child-2"],
          },
        ],
      ]),
    },
  );
  assert.equal(plan.exploded, true);
  assert.equal(sumAmounts(plan.lines.map((l) => l.amount)), "120.0000");
  assert.ok(plan.lines.every((l) => !l.distributionLocked));
});

test("plan strips stamps from an unknown group and matches the line fresh", () => {
  const r = autoRule();
  const plan = planEntryDistributions(
    doc(),
    [entryLine({ amount: "80.0000", departmentId: "d0", distributionGroupId: "forged" })],
    [r],
    { existingGroups: new Map(), newGroupId: () => "group-new" },
  );
  assert.equal(plan.lines.length, 2);
  assert.deepEqual(plan.lines.map((l) => l.distributionGroupId), ["group-new", "group-new"]);
});

test("plan collapses an un-split group to one line at the first child's coordinates", () => {
  const r = autoRule();
  const plan = planEntryDistributions(
    doc({ unsplitDistributionGroups: ["group-1"] }),
    [
      entryLine({ amount: "40.0000", departmentId: "d1", distributionGroupId: "group-1" }),
      entryLine({ amount: "40.0000", departmentId: "d2", distributionGroupId: "group-1" }),
      entryLine({ amount: "25.0000", departmentId: "other" }),
    ],
    [r],
    {
      existingGroups: new Map([
        [
          "group-1",
          {
            groupId: "group-1",
            ruleId: r.rule.id,
            versionId: r.version.id,
            locked: false,
            total: "80.0000",
            memberIds: ["old-child-1", "old-child-2"],
          },
        ],
      ]),
    },
  );
  assert.equal(plan.exploded, true);
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.lines[0]!.amount, "80.0000");
  assert.equal(plan.lines[0]!.departmentId, "d1");
  assert.equal(plan.lines[0]!.distributionGroupId, null);
  assert.equal(plan.lines[1]!.amount, "25.0000");
  assert.deepEqual(plan.lineage, []);
});

test("plan lets an explicit key win over existing group membership with a new group", () => {
  const manual = rule("manual-split", [target({ departmentId: "d8", fixedPercent: "100" })], {
    applyPolicy: "manual",
  });
  const plan = planEntryDistributions(
    doc(),
    [entryLine({ amount: "30.0000", distributionGroupId: "group-1", distributionKey: "manual-split" })],
    [manual],
    {
      explicitRules: new Map([[manual.rule.key, manual]]),
      existingGroups: new Map([
        [
          "group-1",
          {
            groupId: "group-1",
            ruleId: "other-rule",
            versionId: "other-version",
            locked: false,
            total: "30.0000",
            memberIds: ["old-child-1"],
          },
        ],
      ]),
      newGroupId: () => "group-fresh",
    },
  );
  assert.equal(plan.lines.length, 1);
  assert.equal(plan.lines[0]!.departmentId, "d8");
  assert.equal(plan.lines[0]!.distributionGroupId, "group-fresh");
});
