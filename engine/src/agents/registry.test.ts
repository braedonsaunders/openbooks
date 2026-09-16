import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  CONTINUOUS_CLOSE_DETECTOR_SPECS,
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "../continuous-close-config.ts";
import { AGENT_PACKS } from "./registry.ts";

const controlPlane = readFileSync(new URL("../continuous-close.ts", import.meta.url), "utf8");

test("every registered agent key has exactly one pack implementation", () => {
  assert.deepEqual(
    Object.keys(AGENT_PACKS).sort(),
    [...CONTINUOUS_CLOSE_AGENT_KEYS].sort(),
    "a new agent key without a pack (or a pack without a key) fails here, not in production",
  );
  for (const pack of Object.values(AGENT_PACKS)) {
    assert.equal(typeof pack, "function");
  }
});

test("the control plane dispatches through the registry, never a per-agent branch", () => {
  assert.match(
    controlPlane,
    /await AGENT_PACKS\[args\.agentKey\]\(args\.orgId, configured\.materiality_threshold, detectors\)/,
    "one dispatch line serves all six agents",
  );
  assert.doesNotMatch(
    controlPlane,
    /args\.agentKey === "accounting" \?/,
    "the accounting/finance ternary is gone: packs own their detectors",
  );
  assert.doesNotMatch(controlPlane, /async function accountingFindings/);
  assert.doesNotMatch(controlPlane, /async function financeFindings/);
});

test("every detector spec belongs to a registered agent pack", () => {
  for (const spec of CONTINUOUS_CLOSE_DETECTOR_SPECS) {
    assert.ok(
      (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(spec.agentKey),
      `${spec.detectorKey} names an unknown agent`,
    );
    assert.ok(AGENT_PACKS[spec.agentKey], `${spec.detectorKey} has no pack implementation`);
  }
});

test("the four wave-2 packs register their detectors and default on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("collections").map((spec) => spec.detectorKey),
    ["overdue_customer_balance", "broken_payment_promise", "credit_hold_candidate"],
  );
  assert.deepEqual(
    detectorSpecsForAgent("payables").map((spec) => spec.detectorKey),
    ["duplicate_bills", "bills_due_before_payrun", "early_pay_discount_opportunity", "bills_missing_approval"],
  );
  assert.deepEqual(
    detectorSpecsForAgent("reconciliation").map((spec) => spec.detectorKey),
    ["bank_line_match_candidate", "stale_reconciliation", "never_reconciled_account"],
  );
  assert.deepEqual(
    detectorSpecsForAgent("hygiene").map((spec) => spec.detectorKey),
    [
      "control_account_type_mismatch",
      "duplicate_party_identity",
      "item_missing_tax_code",
      "project_missing_cost_budget",
      "budget_scenario_without_lines",
      "unmapped_payroll_component",
    ],
  );
  for (const agentKey of ["collections", "payables", "reconciliation", "hygiene"] as const) {
    const defaults = defaultContinuousCloseDetectors(agentKey);
    assert.deepEqual(
      enabledDetectorKeys(defaults),
      defaults.map((detector) => detector.detectorKey),
      `${agentKey} controls all default on`,
    );
  }
});

test("new-pack detector tuning validates like the original packs", () => {
  const configured = normalizeContinuousCloseDetectors("collections", {
    overdue_customer_balance: {
      enabled: false,
      materialityThreshold: "2500.125",
      parameters: { criticalAgeDays: 14, criticalCustomerCount: 5, criticalMaterialityMultiple: 3 },
    },
  });
  assert.deepEqual(enabledDetectorKeys(configured), ["broken_payment_promise", "credit_hold_candidate"]);
  assert.equal(configured[0]!.materialityThreshold, "2500.1250");

  assert.throws(
    () => normalizeContinuousCloseDetectors("payables", { duplicate_bills: { parameters: { duplicateWindowDays: 0 } } }),
    /invalid detector parameter/,
  );
  assert.throws(
    () => normalizeContinuousCloseDetectors("reconciliation", { bank_line_match_candidate: { materialityThreshold: "-1" } }),
    /invalid materiality threshold/,
  );
});

test("unstubbed wave-2 packs stay quiet until their detectors land", async () => {
  // Collections landed its detectors (see collections.test.ts); the packs
  // below still return [] with no detectors enabled and no DB touched.
  for (const agentKey of ["payables", "reconciliation", "hygiene"] as const) {
    const findings = await AGENT_PACKS[agentKey]("00000000-0000-0000-0000-000000000000", "1000.0000", []);
    assert.deepEqual(findings, [], `${agentKey} emits nothing before its detectors land`);
  }
});
