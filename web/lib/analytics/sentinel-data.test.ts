import assert from "node:assert/strict";
import test from "node:test";

// Unit tests for Sentinel's pure detection kernels: the published Benford
// bands, Nigrini's digit Z-statistic, the Flows limit extraction and the
// baseline window. No database: every case is exact arithmetic or a
// realistic authored graph.

const {
  benfordConformity1D,
  benfordConformity2D,
  benfordDigitZ,
  extractFlowAmountLimits,
  sentinelBaselineFrom,
} = await import("./sentinel-data.ts");

// Nigrini's published first-two-digit MAD bands are 0.0012 / 0.0018 / 0.0022
// (close / acceptable / marginal; above, nonconforming). The previous bands
// (0.0012 / 0.0022 / 0.0033) labelled MAD 0.0025 "marginal"; under Nigrini it
// is nonconforming, and this case pins the correction.
test("first-two-digit MAD bands follow Nigrini 0.0012/0.0018/0.0022", () => {
  assert.equal(benfordConformity2D(0.0012), "excellent");
  assert.equal(benfordConformity2D(0.0018), "acceptable");
  assert.equal(benfordConformity2D(0.0022), "marginal");
  assert.equal(benfordConformity2D(0.0025), "nonConforming");
  assert.equal(benfordConformity2D(0.0033), "nonConforming");
  assert.equal(benfordConformity2D(0), "excellent");
});

test("first-digit MAD bands stay at the cited 0.006/0.012/0.015", () => {
  assert.equal(benfordConformity1D(0.006), "excellent");
  assert.equal(benfordConformity1D(0.012), "acceptable");
  assert.equal(benfordConformity1D(0.015), "marginal");
  assert.equal(benfordConformity1D(0.0151), "nonConforming");
});

// n = 1000, digit 1 observed at 35% against 30.103% expected: the corrected
// deviation (0.04847) over the standard error (~0.0145) lands near Z 3.3 —
// a genuine flag. At 31% observed the same slice scores Z ~0.6 — noise.
test("Nigrini digit Z flags real deviations and clears noise", () => {
  const flagged = benfordDigitZ(0.35, 0.30103, 1000);
  assert.ok(flagged > 1.96 && flagged < 4, `expected a flag near 3.3, got ${flagged}`);
  const noise = benfordDigitZ(0.31, 0.30103, 1000);
  assert.ok(noise < 1.96, `expected noise below 1.96, got ${noise}`);
});

test("Nigrini digit Z never divides by nothing", () => {
  assert.equal(benfordDigitZ(0.35, 0.30103, 0), 0);
  assert.equal(benfordDigitZ(0.30103, 0.30103, 1000), 0);
  assert.equal(benfordDigitZ(0.5, 0, 100), 0);
  assert.equal(benfordDigitZ(0.5, 1, 100), 0);
});

// A realistic approval flow: the amount gate on vendor_bill total, nested in
// an and-rule beside a status check, plus an unrelated action node. Only the
// numeric total comparison is a candidate limit.
test("flow amount limits collect numeric total conditions per subject kind", () => {
  const graph = {
    nodes: [
      { id: "t", position: { x: 0, y: 0 }, data: { kind: "trigger", trigger: { trigger: "on_create" } } },
      {
        id: "c",
        position: { x: 0, y: 1 },
        data: {
          kind: "condition",
          rule: {
            op: "and",
            rules: [
              { op: "gte", field: "total", value: 5000 },
              { op: "eq", field: "status", value: "submitted" },
            ],
          },
        },
      },
      { id: "a", position: { x: 0, y: 2 }, data: { kind: "action", action: { action: "notify" } } },
    ],
    edges: [],
  };
  assert.deepEqual(extractFlowAmountLimits([{ subjectKind: "vendor_bill", graph }]), [
    { subjectKind: "vendor_bill", limit: "5000" },
  ]);
});

test("flow amount limits ignore non-limits and dedupe repeats", () => {
  const graph = {
    nodes: [
      {
        id: "c",
        position: { x: 0, y: 0 },
        data: {
          kind: "condition",
          rule: {
            op: "or",
            rules: [
              { op: "gte", field: "total", value: 5000 },
              { op: "gte", field: "total", value: 5000 },
              { op: "gte", field: "total", value: 0 },
              { op: "gte", field: "total", value: -10 },
              { op: "gte", field: "total", value: "much" },
              { op: "gte", field: "subtotal", value: 7000 },
              { op: "isSet", field: "total" },
            ],
          },
        },
      },
      {
        id: "n",
        position: { x: 0, y: 1 },
        data: { kind: "condition", rule: { op: "not", rule: { op: "lt", field: "total", value: "250.50" } } },
      },
    ],
    edges: [],
  };
  assert.deepEqual(extractFlowAmountLimits([{ subjectKind: "check", graph }]), [
    { subjectKind: "check", limit: "250.50" },
    { subjectKind: "check", limit: "5000" },
  ]);
  assert.deepEqual(extractFlowAmountLimits([{ subjectKind: "x", graph: null }]), []);
  assert.deepEqual(extractFlowAmountLimits([{ subjectKind: "x", graph: {} }]), []);
});

// A limit on a non-spend subject can never gate a spend document, so it
// must not count as threshold-trap coverage — otherwise the detector would
// report configured and scan nothing.
test("flow amount limits ignore non-spend subject kinds", () => {
  const graph = {
    nodes: [
      {
        id: "c",
        position: { x: 0, y: 0 },
        data: { kind: "condition", rule: { op: "gte", field: "total", value: 5000 } },
      },
    ],
    edges: [],
  };
  assert.deepEqual(extractFlowAmountLimits([{ subjectKind: "sales_order", graph }]), []);
  assert.deepEqual(
    extractFlowAmountLimits([
      { subjectKind: "sales_order", graph },
      { subjectKind: "vendor_bill", graph },
    ]),
    [{ subjectKind: "vendor_bill", limit: "5000" }],
  );
});

test("vendor baseline window counts back whole months", () => {
  assert.equal(sentinelBaselineFrom("2026-07-31", 36), "2023-07-31");
  assert.equal(sentinelBaselineFrom("2026-07-31"), "2023-07-31");
  assert.equal(sentinelBaselineFrom("2026-07-31", 3), "2026-04-30");
});
