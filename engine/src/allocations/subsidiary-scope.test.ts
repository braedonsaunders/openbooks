import assert from "node:assert/strict";
import test from "node:test";
import {
  allocationRuleVisible,
  allocationScopeVisible,
  allocationTouchedSubsidiaries,
  previewPinError,
  sourceScopeViolation,
  targetPinViolation,
} from "./subsidiary-scope";

const SUB_A = "11111111-1111-4111-8111-111111111111";
const SUB_B = "22222222-2222-4222-8222-222222222222";

test("restricted preview must pin a visible subsidiary", () => {
  assert.equal(previewPinError(null, undefined), null);
  assert.equal(previewPinError(null, null), null);
  assert.match(previewPinError(new Set([SUB_A]), undefined) ?? "", /subsidiary pin is required/);
  assert.match(previewPinError(new Set([SUB_A]), null) ?? "", /subsidiary pin is required/);
  assert.match(previewPinError(new Set([SUB_A]), SUB_B) ?? "", /outside the caller's scope/);
  assert.equal(previewPinError(new Set([SUB_A]), SUB_A), null);
  assert.equal(previewPinError(new Set(), SUB_A) ?? "", "subsidiary outside the caller's scope");
});

test("visibility needs the pin and every touched subsidiary", () => {
  const computation = {
    subsidiaryId: SUB_A,
    sources: [{ subsidiaryId: SUB_A }],
    targets: [{ coordinate: { subsidiaryId: SUB_A } }],
    lines: [{ subsidiaryId: SUB_A }, { subsidiaryId: SUB_A }],
  };
  assert.equal(allocationScopeVisible(null, null), true);
  assert.equal(allocationScopeVisible(null, SUB_B, computation), true);
  // Org-wide pin aggregates unseen entities: invisible to restricted callers.
  assert.equal(allocationScopeVisible(new Set([SUB_A, SUB_B]), null, computation), false);
  assert.equal(allocationScopeVisible(new Set([SUB_A]), SUB_B, computation), false);
  // Pin visible but a target posts into the other company: refused, and the
  // touched set names company B so the refusal can too.
  const crossed = {
    ...computation,
    subsidiaryId: SUB_A,
    targets: [{ coordinate: { subsidiaryId: SUB_B } }],
  };
  assert.equal(allocationScopeVisible(new Set([SUB_A, SUB_B]), SUB_A, crossed), true);
  assert.equal(allocationScopeVisible(new Set([SUB_A]), SUB_A, crossed), false);
  const { touched } = allocationTouchedSubsidiaries(SUB_A, crossed);
  assert.ok(touched.includes(SUB_B), "touched subsidiaries must include the foreign target");
  // Null coordinates inherit their source: no independent scope.
  const inherited = {
    subsidiaryId: SUB_A,
    sources: [{ subsidiaryId: SUB_A }],
    targets: [{ coordinate: { subsidiaryId: null } }],
    lines: [],
  };
  assert.equal(allocationScopeVisible(new Set([SUB_A]), SUB_A, inherited), true);
  // Malformed stored evidence fails closed, never open.
  assert.equal(allocationScopeVisible(new Set([SUB_A]), SUB_A, { sources: "nope" }), false);
  assert.equal(allocationScopeVisible(new Set([SUB_A]), SUB_A, { targets: "nope" }), false);
  assert.equal(allocationScopeVisible(null, SUB_A, { sources: "nope" }), true);
});

test("cross-pin targets refuse by name", () => {
  assert.equal(targetPinViolation("sweep", null, [SUB_A, SUB_B]), null);
  assert.equal(targetPinViolation("sweep", SUB_A, [SUB_A, null]), null);
  assert.equal(targetPinViolation("sweep", SUB_A, []), null);
  const refusal = targetPinViolation("sweep", SUB_A, [SUB_A, SUB_B]) ?? "";
  assert.match(refusal, /sweep/);
  assert.match(refusal, new RegExp(SUB_B));
  assert.match(refusal, new RegExp(SUB_A));
});

test("rule subsidiary filter intersects the pin", () => {
  assert.equal(sourceScopeViolation("Sweep", null, [SUB_B]), null);
  assert.equal(sourceScopeViolation("Sweep", SUB_A, []), null);
  assert.equal(sourceScopeViolation("Sweep", SUB_A, [SUB_A, SUB_B]), null);
  const refusal = sourceScopeViolation("Sweep", SUB_A, [SUB_B]) ?? "";
  assert.match(refusal, /Sweep/);
  assert.match(refusal, new RegExp(SUB_A));
});

test("rule visibility needs every touched source and target", () => {
  const scoped = { sourceSubsidiaryIds: [SUB_A], targetSubsidiaryIds: [SUB_A] };
  assert.equal(allocationRuleVisible(null, scoped), true);
  assert.equal(allocationRuleVisible(new Set([SUB_A]), scoped), true);
  assert.equal(allocationRuleVisible(new Set([SUB_B]), scoped), false);
  // A B target on A sources touches both: the A caller is refused.
  assert.equal(
    allocationRuleVisible(new Set([SUB_A]), { sourceSubsidiaryIds: [SUB_A], targetSubsidiaryIds: [SUB_B] }),
    false,
  );
  // Null targets inherit the already-checked sources.
  assert.equal(
    allocationRuleVisible(new Set([SUB_A]), { sourceSubsidiaryIds: [SUB_A], targetSubsidiaryIds: [null] }),
    true,
  );
  // No source filter means every source: org-wide, restricted callers never qualify.
  assert.equal(allocationRuleVisible(new Set([SUB_A, SUB_B]), { targetSubsidiaryIds: [SUB_A] }), false);
  assert.equal(allocationRuleVisible(new Set([SUB_A]), { sourceSubsidiaryIds: [], targetSubsidiaryIds: [SUB_A] }), false);
  assert.equal(allocationRuleVisible(new Set([SUB_A]), { sourceSubsidiaryIds: [SUB_A], targetSubsidiaryIds: [] }), true);
  // Dynamic subsidiary targets name their entities in include; an unlisted
  // dynamic target is org-wide.
  const dynamicListed = {
    sourceSubsidiaryIds: [SUB_A],
    targetKind: "dynamic",
    dynamicDimension: "subsidiary",
    dynamicIncludes: [SUB_A],
    targetSubsidiaryIds: [],
  };
  assert.equal(allocationRuleVisible(new Set([SUB_A]), dynamicListed), true);
  assert.equal(allocationRuleVisible(new Set([SUB_B]), dynamicListed), false);
  const dynamicOpen = { ...dynamicListed, dynamicIncludes: [] as string[] };
  assert.equal(allocationRuleVisible(new Set([SUB_A, SUB_B]), dynamicOpen), false);
  assert.equal(allocationRuleVisible(null, dynamicOpen), true);
});
