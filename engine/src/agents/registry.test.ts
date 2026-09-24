import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  CONTINUOUS_CLOSE_DETECTOR_SPECS,
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "./continuous-close-config.ts";
import { AGENT_PACKS } from "./registry.ts";

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

test("every detector spec belongs to a registered agent pack", () => {
  for (const spec of CONTINUOUS_CLOSE_DETECTOR_SPECS) {
    assert.ok(
      (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(spec.agentKey),
      `${spec.detectorKey} names an unknown agent`,
    );
    assert.ok(AGENT_PACKS[spec.agentKey], `${spec.detectorKey} has no pack implementation`);
  }
});

/**
 * Pack registration is a rule, not a roster: every pack owns at least one
 * uniquely-keyed detector and ships it enabled. The exact detector set grows
 * over time, so no test pins the membership list — detector behaviours are
 * covered by the continuous-close pack suites.
 */
function assertPackRegistersEnabledDetectors(agentKey: (typeof CONTINUOUS_CLOSE_AGENT_KEYS)[number]): void {
  const specs = detectorSpecsForAgent(agentKey);
  assert.ok(specs.length > 0, `${agentKey} registers at least one detector`);
  const keys = specs.map((spec) => spec.detectorKey);
  assert.ok(keys.every((key) => key.length > 0), `${agentKey} detector keys are named`);
  assert.equal(new Set(keys).size, keys.length, `${agentKey} detector keys are unique`);
  const defaults = defaultContinuousCloseDetectors(agentKey);
  assert.deepEqual(
    enabledDetectorKeys(defaults),
    defaults.map((detector) => detector.detectorKey),
    `${agentKey} detectors all default on`,
  );
}

test("the four wave-2 packs register their detectors and default on", () => {
  for (const agentKey of ["collections", "payables", "reconciliation", "hygiene"] as const) {
    assertPackRegistersEnabledDetectors(agentKey);
  }
});

test("the forensics pack registers its detectors and defaults on", () => {
  assertPackRegistersEnabledDetectors("forensics");
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
  assertPackRegistersEnabledDetectors("tax");
});

test("the payroll pack registers its detectors and defaults on", () => {
  assertPackRegistersEnabledDetectors("payroll");
});

test("the projects pack registers its detectors and defaults on", () => {
  assertPackRegistersEnabledDetectors("projects");
});

test("the cash pack registers its detectors and defaults on", () => {
  assertPackRegistersEnabledDetectors("cash");
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
