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

test("the forensics pack registers its detectors and defaults on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("forensics").map((spec) => spec.detectorKey),
    [
      "forensic_weekend_postings",
      "forensic_round_dollar",
      "forensic_threshold_trap",
      "forensic_duplicate_bills",
    ],
  );
  const defaults = defaultContinuousCloseDetectors("forensics");
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    "forensics controls all default on",
  );
  assert.throws(
    () => normalizeContinuousCloseDetectors("forensics", {
      forensic_weekend_postings: { parameters: { lookbackDays: 0 } },
    }),
    /invalid detector parameter/,
  );
  assert.throws(
    () => normalizeContinuousCloseDetectors("forensics", {
      forensic_duplicate_bills: { parameters: { duplicateDays: 61 } },
    }),
    /invalid detector parameter/,
  );
});

test("the tax pack registers its detectors and defaults on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("tax").map((spec) => spec.detectorKey),
    [
      "tax_missing_codes",
      "tax_missing_registration",
      "tax_return_blocked",
      "tax_unlocked_period",
    ],
  );
  const defaults = defaultContinuousCloseDetectors("tax");
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    "tax controls all default on",
  );
});

test("the payroll pack registers its detectors and defaults on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("payroll").map((spec) => spec.detectorKey),
    [
      "payroll_remittance_due",
      "payroll_unknown_accounts",
      "payroll_missing_elections",
      "payroll_yearend_gaps",
    ],
  );
  const defaults = defaultContinuousCloseDetectors("payroll");
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    "payroll controls all default on",
  );
});

test("the projects pack registers its detectors and defaults on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("projects").map((spec) => spec.detectorKey),
    [
      "project_negative_margin",
      "project_budget_overrun",
      "project_stale_unbilled",
    ],
  );
  const defaults = defaultContinuousCloseDetectors("projects");
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    "projects controls all default on",
  );
});

test("the cash pack registers its detectors and defaults on", () => {
  assert.deepEqual(
    detectorSpecsForAgent("cash").map((spec) => spec.detectorKey),
    [
      "cash_low_balance",
      "cash_bill_crunch",
      "cash_forecast_shortfall",
    ],
  );
  const defaults = defaultContinuousCloseDetectors("cash");
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    "cash controls all default on",
  );
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

test("wave-2 packs stay quiet without touching the DB when nothing is enabled", async () => {
  // Every pack short-circuits before its loaders when none of its detectors
  // is enabled, so a fully-disabled agent costs no queries.
  for (const agentKey of ["collections", "payables", "reconciliation", "hygiene"] as const) {
    const findings = await AGENT_PACKS[agentKey]("00000000-0000-0000-0000-000000000000", "1000.0000", []);
    assert.deepEqual(findings, [], `${agentKey} emits nothing with no detectors enabled`);
  }
  for (const agentKey of ["collections", "payables", "reconciliation", "hygiene"] as const) {
    const detectors = defaultContinuousCloseDetectors(agentKey).map((detector) => ({ ...detector, enabled: false }));
    const findings = await AGENT_PACKS[agentKey]("00000000-0000-0000-0000-000000000000", "1000.0000", detectors);
    assert.deepEqual(findings, [], `${agentKey} emits nothing when all its detectors are off`);
  }
});
