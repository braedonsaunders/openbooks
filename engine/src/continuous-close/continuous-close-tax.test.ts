import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAX_DETECTOR_KEYS } from "../agents/tax.ts";
import {
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "../agents/continuous-close-config.ts";

const source = readFileSync(new URL("../agents/tax.ts", import.meta.url), "utf8");

test("the tax-readiness pack owns four detectors, on by default", () => {
  assert.deepEqual([...TAX_DETECTOR_KEYS], [
    "tax_missing_codes",
    "tax_missing_registration",
    "tax_return_blocked",
    "tax_unlocked_period",
  ]);
  assert.deepEqual(
    detectorSpecsForAgent("tax").map((spec) => spec.detectorKey),
    [...TAX_DETECTOR_KEYS],
  );
  const defaults = defaultContinuousCloseDetectors("tax");
  for (const key of TAX_DETECTOR_KEYS) {
    assert.ok(
      enabledDetectorKeys(defaults).includes(key),
      `${key} defaults on`,
    );
  }
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("tax", {
        tax_missing_codes: { parameters: { lookbackDays: 366 } },
      }),
    /invalid detector parameter/,
  );
});

test("tax readiness reuses the filing engine and the missing-code review list", () => {
  // documents_missing_tax_code (web/lib/assistant/tools-tax.ts) defines the
  // review population: posted documents with non-zero lines carrying no tax
  // code. The pack watches the same population so the agent and the
  // interactive review list can never disagree.
  assert.match(source, /dl\.tax_code_id is null and dl\.amount <> 0/, "untaxed-line population matches the review list");
  assert.match(source, /d\.status = 'posted'/, "only posted documents count toward a return");
  // Return boxes come from the SAME engine the filing screen uses
  // (computeTaxReturn): the agent can never quote boxes the filer would not
  // see, and a configured-but-uncomputable return is itself a finding.
  assert.match(source, /await computeTaxReturn\(orgId, form\.code, from, today\)/);
  assert.match(source, /error instanceof TaxReturnError/);
  // Registration coverage mirrors list_tax_return_forms: active forms joined
  // against active registrations naming that form.
  assert.match(source, /from tax_return_forms/);
  assert.match(source, /from tax_registrations/);
  // Period locks reuse the close module's lock table, tax module only.
  assert.match(source, /from period_locks/);
  assert.match(source, /module = 'tax'/);
  assert.match(source, /agentKey: "tax"/, "findings belong to the tax pack");
  // Blocked returns stay findings-only: a computable return emits nothing,
  // and an unregistered form is a registration finding, never a broken
  // computation.
  for (const fingerprint of [
    "tax-missing-codes:",
    "tax-missing-registration:",
    "tax-return-blocked:",
    "tax-unlocked-period:",
  ]) {
    assert.ok(source.includes(fingerprint), `fingerprint ${fingerprint}* is stable`);
  }
});
