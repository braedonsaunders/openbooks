import assert from "node:assert/strict";
import test from "node:test";
import { definitionHash, validateRuleVersion, type RuleVersionValidationContext } from "./validate.ts";
import type { AllocationRuleTarget, AllocationRuleVersion } from "./types.ts";

function version(over: Partial<AllocationRuleVersion> = {}): AllocationRuleVersion {
  return {
    id: "version-1",
    orgId: "org-1",
    ruleId: "rule-1",
    versionNo: 1,
    status: "draft",
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
    ...over,
  };
}

function ctx(over: Partial<RuleVersionValidationContext> = {}): RuleVersionValidationContext {
  return { orgId: "org-1", ruleId: "rule-1", mode: "period", publishedVersions: [], activePostingBookIds: [], ...over };
}

function tgt(over: Partial<AllocationRuleTarget> = {}): AllocationRuleTarget {
  return { id: `t-${over.sequence ?? 1}`, sequence: over.sequence ?? 1, fixedPercent: "100", ...over };
}

const codes = (v: AllocationRuleVersion, t: AllocationRuleTarget[], c: RuleVersionValidationContext): string[] =>
  validateRuleVersion(v, t, c).map((p) => p.code);

test("a well-formed fixed_percent version validates clean", () => {
  const problems = validateRuleVersion(
    version(),
    [tgt({ sequence: 1, fixedPercent: "60" }), tgt({ sequence: 2, fixedPercent: "40" })],
    ctx(),
  );
  assert.deepEqual(problems, []);
});

test("definitionHash is stable across target insert order and key order", () => {
  const v = version();
  const a = tgt({ sequence: 1, fixedPercent: "60", departmentId: "d1" });
  const b = tgt({ sequence: 2, fixedPercent: null, isRemainder: true });
  const h1 = definitionHash(v, [a, b]);
  const h2 = definitionHash(v, [b, a]);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
  // Shuffled object keys hash identically (nested and top level).
  const cfgA: Record<string, unknown> = {};
  cfgA["z"] = 1;
  cfgA["a"] = [3, 2, 1];
  const cfgB: Record<string, unknown> = {};
  cfgB["a"] = [3, 2, 1];
  cfgB["z"] = 1;
  assert.equal(
    definitionHash({ ...v, basisConfig: cfgA }, [a]),
    definitionHash({ ...v, basisConfig: cfgB }, [a]),
  );
  const fwd: AllocationRuleVersion = { ...v, memoTemplate: "x" };
  const rev = {} as AllocationRuleVersion;
  for (const key of Object.keys(fwd).reverse() as (keyof AllocationRuleVersion)[]) {
    (rev as unknown as Record<string, unknown>)[key as string] = fwd[key];
  }
  assert.equal(definitionHash(fwd, [a]), definitionHash(rev, [a]));
  // Any definition change moves the hash.
  assert.notEqual(definitionHash(v, [a, b]), definitionHash(v, [{ ...a, fixedPercent: "61" }, b]));
  assert.notEqual(definitionHash(v, [a, b]), definitionHash({ ...v, impact: "net_zero_pair" }, [a, b]));
});

test("definitionHash survives a numeric round-trip (30 vs 30.0000)", () => {
  const v = version();
  const h1 = definitionHash(v, [tgt({ sequence: 1, fixedPercent: "30" }), tgt({ sequence: 2, fixedPercent: "70" })]);
  const h2 = definitionHash(v, [tgt({ sequence: 1, fixedPercent: "30.0000" }), tgt({ sequence: 2, fixedPercent: "70.0000" })]);
  assert.equal(h1, h2);
});

test("fixed_percent grids are validated, never silently short", () => {
  assert.ok(codes(version(), [tgt({ sequence: 1, fixedPercent: "30" })], ctx()).includes("fixed_percent_sum"));
  assert.ok(
    codes(
      version(),
      [tgt({ sequence: 1, fixedPercent: "60" }), tgt({ sequence: 2, fixedPercent: "50" })],
      ctx(),
    ).includes("fixed_percent_sum"),
  );
  assert.ok(
    codes(version(), [tgt({ sequence: 1, fixedPercent: "40", isRemainder: true }), tgt({ sequence: 2, isRemainder: true })], ctx()).includes(
      "remainder_count",
    ),
  );
  assert.ok(
    codes(version(), [tgt({ sequence: 1, fixedPercent: null })], ctx()).includes("fixed_percent_missing"),
  );
  assert.ok(
    codes(version(), [tgt({ sequence: 1, fixedPercent: "101" })], ctx()).includes("fixed_percent_range"),
  );
  // Remainder completing the grid is clean.
  assert.deepEqual(
    codes(version(), [tgt({ sequence: 1, fixedPercent: "30" }), tgt({ sequence: 2, fixedPercent: null, isRemainder: true })], ctx()),
    [],
  );
});

test("entry mode needs an apply policy and a target population", () => {
  const c = ctx({ mode: "entry" });
  assert.ok(codes(version({ applyPolicy: "automatic" }), [], c).includes("targets_empty"));
  assert.ok(
    codes(version(), [], { ...c }).includes("targets_empty"),
    "explicit with no targets is refused",
  );
  const dynNoDim = version({ targetKind: "dynamic", dynamicTarget: {} });
  assert.ok(codes(dynNoDim, [], c).includes("dynamic_dimension"));
  const dyn = version({ targetKind: "dynamic", dynamicTarget: { dimension: "department" } });
  assert.deepEqual(codes(dyn, [], c), []);
});

test("period mode needs a source measure and a usable basis", () => {
  assert.ok(codes(version({ basisKind: "driver", driverId: null }), [tgt()], ctx()).includes("driver_missing"));
  assert.ok(
    codes(version({ basisKind: "stepped", basisConfig: {} }), [tgt()], ctx()).includes("stepped_tiers"),
  );
  assert.deepEqual(
    codes(
      version({ basisKind: "stepped", basisConfig: { tiers: [{ upTo: "1000" }, { upTo: null }] } }),
      [tgt({ fixedPercent: null })],
      ctx(),
    ),
    [],
    "stepped basis ignores fixed_percent columns",
  );
});

test("driver basis needs a known driver whose dimension matches the targets", () => {
  const v = version({ basisKind: "driver", driverId: "drv-1" });
  assert.ok(codes(v, [tgt()], ctx({ driver: null })).includes("driver_unknown"));
  const deptDriver = { id: "drv-1", dimension: "department", isActive: true };
  assert.ok(codes(v, [tgt({ departmentId: null })], ctx({ driver: deptDriver })).includes("driver_dimension"));
  assert.deepEqual(codes(v, [tgt({ departmentId: "d1" })], ctx({ driver: deptDriver })), []);
  // Dynamic targets must resolve along the driver's dimension.
  const dyn = version({ basisKind: "driver", driverId: "drv-1", targetKind: "dynamic", dynamicTarget: { dimension: "location" } });
  assert.ok(codes(dyn, [], ctx({ driver: deptDriver })).includes("driver_dimension"));
  assert.deepEqual(
    codes({ ...dyn, dynamicTarget: { dimension: "department" } }, [], ctx({ driver: deptDriver })),
    [],
  );
  assert.ok(codes(v, [tgt({ departmentId: "d1" })], ctx({ driver: { ...deptDriver, isActive: false } })).includes("driver_inactive"));
});

test("impact and offset must cohere", () => {
  assert.ok(
    codes(version({ impact: "net_zero_pair", offsetAccountId: "acct-1" }), [tgt()], ctx()).includes("offset_impact"),
  );
  assert.ok(
    codes(version({ impact: "report_only", offsetAccountId: "acct-1" }), [tgt()], ctx()).includes("offset_impact"),
  );
  assert.deepEqual(codes(version({ impact: "reclass", offsetAccountId: "acct-1" }), [tgt()], ctx()), []);
});

test("explicit residual policy needs a residual target that exists", () => {
  const v = version({ residualPolicy: "explicit_target", residualTargetId: null });
  assert.ok(codes(v, [tgt()], ctx()).includes("residual_target"));
  const dangling = version({ residualPolicy: "explicit_target", residualTargetId: "ghost" });
  assert.ok(codes(dangling, [tgt()], ctx()).includes("residual_target"));
  const ok = version({ residualPolicy: "explicit_target", residualTargetId: "t-1" });
  assert.deepEqual(codes(ok, [tgt()], ctx()), []);
});

test("published effective windows of one rule must not overlap", () => {
  const sib = { id: "sib-1", effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" };
  const c = ctx({ publishedVersions: [sib] });
  // Touching on the boundary day still overlaps (closed intervals).
  assert.ok(codes(version({ effectiveFrom: "2026-06-30" }), [tgt()], c).includes("effective_overlap"));
  assert.ok(codes(version({ effectiveFrom: "2026-01-15", effectiveTo: "2026-02-01" }), [tgt()], c).includes("effective_overlap"));
  assert.deepEqual(codes(version({ effectiveFrom: "2026-07-01" }), [tgt()], c), []);
  // Open-ended siblings overlap everything after their start.
  const open = ctx({ publishedVersions: [{ id: "sib-2", effectiveFrom: "2026-01-01", effectiveTo: null }] });
  assert.ok(codes(version({ effectiveFrom: "2027-01-01" }), [tgt()], open).includes("effective_overlap"));
  // The version never overlaps itself.
  const self = ctx({ publishedVersions: [{ id: "version-1", effectiveFrom: "2026-01-01", effectiveTo: null }] });
  assert.deepEqual(codes(version({ effectiveFrom: "2026-03-01" }), [tgt()], self), []);
  // Inverted windows are refused outright.
  assert.ok(codes(version({ effectiveFrom: "2026-05-01", effectiveTo: "2026-04-01" }), [tgt()], ctx()).includes("effective_window"));
});

test("simultaneous solving is refused: the kernel executes sequentially only", () => {
  const problems = validateRuleVersion(version({ solveMethod: "simultaneous" }), [tgt()], ctx());
  const flagged = problems.find((p) => p.code === "solve_method");
  assert.ok(flagged, "expected a solve_method problem");
  assert.equal(flagged?.field, "solveMethod");
  assert.match(flagged?.message ?? "", /simultaneous/);
  assert.deepEqual(codes(version({ solveMethod: "sequential" }), [tgt()], ctx()), []);
});

test("book_scope books needs live posting books and nothing else", () => {
  const c = ctx({ activePostingBookIds: ["book-1", "book-2"] });
  const v = version({ bookScope: "books", bookIds: [] });
  assert.ok(codes(v, [tgt()], c).includes("book_scope"));
  assert.ok(codes({ ...v, bookIds: ["book-1", "ghost"] }, [tgt()], c).includes("book_scope"));
  assert.deepEqual(codes({ ...v, bookIds: ["book-2", "book-1"] }, [tgt()], c), []);
});

test("net_zero_pair refuses explicit targets naming an account at publish", () => {
  const problems = validateRuleVersion(
    version({ impact: "net_zero_pair" }),
    [tgt({ sequence: 1, fixedPercent: "100", targetAccountId: "account-1" })],
    ctx(),
  );
  assert.ok(problems.some((p) => p.code === "net_zero_account"), JSON.stringify(problems));
});

test("net_zero_pair refuses a dynamic targetAccountId at publish", () => {
  const problems = validateRuleVersion(
    version({
      impact: "net_zero_pair",
      targetKind: "dynamic",
      dynamicTarget: { dimension: "department", targetAccountId: "account-1" },
    }),
    [],
    ctx(),
  );
  assert.ok(problems.some((p) => p.code === "net_zero_account"), JSON.stringify(problems));
});
