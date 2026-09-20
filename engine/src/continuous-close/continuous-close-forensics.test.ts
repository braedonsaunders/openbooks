import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyForensicItem } from "../agents/measure.ts";
import { FORENSICS_DETECTOR_KEYS } from "../agents/forensics.ts";
import {
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
} from "../agents/continuous-close-config.ts";

const source = readFileSync(new URL("../agents/forensics.ts", import.meta.url), "utf8");

test("forensic items escalate at the exact materiality multiple", () => {
  assert.equal(
    classifyForensicItem({ materiality: "4999.9999", threshold: "1000.0000" }),
    "warning",
  );
  assert.equal(
    classifyForensicItem({ materiality: "5000.0000", threshold: "1000.0000" }),
    "critical",
  );
  // Exposure is absolute: credits escalate exactly like debits.
  assert.equal(
    classifyForensicItem({ materiality: "-5000.0000", threshold: "1000.0000" }),
    "critical",
  );
  assert.equal(
    classifyForensicItem({
      materiality: "2999.9999",
      threshold: "1000.0000",
      criticalMaterialityMultiple: 3,
    }),
    "warning",
  );
  assert.equal(
    classifyForensicItem({
      materiality: "3000.0000",
      threshold: "1000.0000",
      criticalMaterialityMultiple: 3,
    }),
    "critical",
  );
});

test("the forensics pack owns four detectors, on by default", () => {
  assert.deepEqual([...FORENSICS_DETECTOR_KEYS], [
    "forensic_weekend_postings",
    "forensic_round_dollar",
    "forensic_threshold_trap",
    "forensic_duplicate_bills",
  ]);
  assert.deepEqual(
    detectorSpecsForAgent("forensics").map((spec) => spec.detectorKey),
    [...FORENSICS_DETECTOR_KEYS],
  );
  const defaults = defaultContinuousCloseDetectors("forensics");
  for (const key of FORENSICS_DETECTOR_KEYS) {
    assert.ok(
      enabledDetectorKeys(defaults).includes(key),
      `${key} defaults on`,
    );
  }
});

test("forensic detectors reuse the sentinel spend population and stay org-scoped", () => {
  // The scheduled sentinel dashboard (web/lib/analytics/sentinel-data.ts)
  // defines the spend population: the same seven non-voided kinds. A
  // background diff that watched a different population would surface "new"
  // findings the dashboard never shows, or miss ones it does.
  for (const kind of [
    "vendor_bill",
    "vendor_credit",
    "vendor_payment",
    "check",
    "expense_report",
    "journal",
    "customer_credit",
  ]) {
    assert.match(source, new RegExp(`['"]${kind}['"]`), `sentinel spend kind ${kind} is watched`);
  }
  assert.match(source, /d\.voided_at is null/, "voided documents never flag");
  assert.match(source, /d\.org_id = \$\{orgId\}/, "every detector query is org-scoped");
  assert.match(source, /agentKey: "forensics"/, "findings belong to the forensics pack");
  // Weekend, round-dollar, threshold-trap, and duplicate classes each get a
  // stable per-item fingerprint, so the run upsert surfaces only genuinely
  // new items and auto-resolves cleared ones — the "diffed against the last
  // run" semantics without a second state store.
  for (const fingerprint of [
    "forensic-weekend:",
    "forensic-round-dollar:",
    "forensic-threshold-trap:",
    "forensic-duplicate:",
  ]) {
    assert.ok(source.includes(fingerprint), `fingerprint ${fingerprint}* is stable`);
  }
  // The sentinel threshold-trap predicate is transcribed exactly: integer
  // part ending in 99 with cents of .00 or .99.
  assert.match(source, /trunc\(abs\(coalesce\(d\.total, 0\)\)\)::bigint % 100 = 99/);
  // Round-dollar items must be whole thousands with real exposure: a 0.00
  // document is divisible by everything and must never flag.
  assert.match(source, /% 1000 = 0/);
});
