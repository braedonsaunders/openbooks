import assert from "node:assert/strict";
import test from "node:test";
import { buildTaxFilingSnapshot } from "./tax-filing.ts";
import type { TaxReturnResult } from "./tax-return.ts";

const RETURN_WITH_EDITABLE_BOXES: TaxReturnResult = {
  formCode: "CA_GST34",
  formName: "GST34",
  from: "2026-01-01",
  to: "2026-03-31",
  submissionChannel: "portal_manual",
  watermark: null,
  boxes: [
    { lineCode: "9", label: "Adjustment 9", value: "0.0000", computed: false, editable: true, pdfField: null },
    { lineCode: "10", label: "Adjustment 10", value: "0.0000", computed: false, editable: true, pdfField: null },
  ],
};

function adjustmentsWithKeyOrder(order: readonly string[]): Record<string, string> {
  const values = { "9": "7.00", "10": "5.00" };
  // Numeric-looking property names normally have ECMAScript's numeric
  // enumeration order. The proxy models the distinct order a JSONB driver
  // can expose and keeps this regression red against the old JSON.stringify
  // fingerprint while retaining the exact statutory box codes.
  return new Proxy(values, { ownKeys: () => [...order] });
}

test("tax filing fingerprints survive jsonb reordering of mixed-length adjustment keys", () => {
  // Prepare normalizes user input before writing JSONB, while mark-filed gets
  // the object back in the driver's JSONB key order. These are the same
  // adjustments and must therefore reproduce the same source fingerprint.
  const prepared = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    adjustmentsWithKeyOrder(["10", "9"]),
  );
  const readBack = buildTaxFilingSnapshot(
    RETURN_WITH_EDITABLE_BOXES,
    adjustmentsWithKeyOrder(["9", "10"]),
  );

  assert.equal(prepared.snapshotHash, readBack.snapshotHash);
});

test("tax filing fingerprints still reject changed adjustment values", () => {
  const prepared = buildTaxFilingSnapshot(RETURN_WITH_EDITABLE_BOXES, {
    "10": "5.00",
    "9": "7.00",
  });
  const changed = buildTaxFilingSnapshot(RETURN_WITH_EDITABLE_BOXES, {
    "9": "7.01",
    "10": "5.00",
  });

  assert.notEqual(prepared.snapshotHash, changed.snapshotHash);
});
