import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PAYROLL_DETECTOR_KEYS } from "./agents/payroll.ts";
import {
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "./continuous-close-config.ts";

const source = readFileSync(new URL("./agents/payroll.ts", import.meta.url), "utf8");

test("the payroll-compliance pack owns four detectors, on by default", () => {
  assert.deepEqual([...PAYROLL_DETECTOR_KEYS], [
    "payroll_remittance_due",
    "payroll_unknown_accounts",
    "payroll_missing_elections",
    "payroll_yearend_gaps",
  ]);
  assert.deepEqual(
    detectorSpecsForAgent("payroll").map((spec) => spec.detectorKey),
    [...PAYROLL_DETECTOR_KEYS],
  );
  const defaults = defaultContinuousCloseDetectors("payroll");
  for (const key of PAYROLL_DETECTOR_KEYS) {
    assert.ok(
      enabledDetectorKeys(defaults).includes(key),
      `${key} defaults on`,
    );
  }
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("payroll", {
        payroll_remittance_due: { parameters: { dueWithinDays: 0 } },
      }),
    /invalid detector parameter/,
  );
});

test("payroll compliance reuses the remittance engine and its exact refusal predicates", () => {
  // Due dates come from the SAME summary the remittance cockpit bills from
  // (payrollRemittanceSummary): the agent can never name a date the biller
  // would not use, and pack-declared schedules stay pack declarations.
  // Per-period summaries: both dating rules key off the range end, so one
  // trailing window would misdate older liability.
  assert.match(source, /await payrollRemittanceSummary\(orgId, \{ from: month\.from, to: month\.to \}\)/);
  assert.match(source, /scheduled\?\.dueDate/);
  // The CRA fallback is the bill's own rule, not a copy: the filing
  // account's remitter-type computation with its quoted statutory rule.
  assert.match(source, /remittanceDueDateExplained\(month\.to, group\.filingAccount\.remitterType/);
  // The unknown-account detector mirrors the two fail-closed PayrollError
  // sites exactly: filing attribution (payroll-filing.ts) and historical
  // liability evidence (payroll-remittance.ts). A blocked summary is the
  // same condition, never a second finding.
  assert.match(source, /s\.filing_account_source = 'unknown'/);
  assert.match(source, /l\.liability_account_id is null/);
  assert.match(source, /error instanceof PayrollError/);
  // Statutory elections are the TD1/W-4 claims on the payroll profile; the
  // year-end gaps reuse the rates surface's own computation and the SIN the
  // slips cannot file without.
  assert.match(source, /federal_claim_code is null/);
  assert.match(source, /await payrollStatutoryRateGaps\(orgId, country, taxYear\)/);
  assert.match(source, /sin_encrypted is null/);
  assert.match(source, /agentKey: "payroll"/, "findings belong to the payroll pack");
  for (const fingerprint of [
    "payroll-remittance-due:",
    "payroll-unknown-accounts:",
    "payroll-missing-elections:",
    "payroll-yearend-",
  ]) {
    assert.ok(source.includes(fingerprint), `fingerprint ${fingerprint}* is stable`);
  }
});
