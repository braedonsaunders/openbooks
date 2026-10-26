import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildNecPreparationRows,
  type FilingComputation,
  type RecipientComputation,
} from "./information-returns.ts";

/**
 * Preparation rows are a pure projection of the filing computation: the same
 * recipients in filing order, with the exception vocabulary attached and the
 * card-funded totals joined in. These pin the mapping (box assignment,
 * threshold flags, masked-TIN passthrough, exclusions) without a database.
 */

function recipient(
  overrides: Partial<RecipientComputation> & { partyId: string },
): RecipientComputation {
  const { partyId, ...rest } = overrides;
  return {
    profile: {
      partyId,
      displayName: `Vendor ${partyId}`,
      legalName: null,
      reportable: true,
      resolvedForm: "1099-NEC",
      defaultBox: null,
      taxClassification: null,
      tinLast4: "4321",
      tinType: "ein",
      backupWithholding: false,
      address: {},
    },
    amounts: {
      boxAmounts: { nec1: "1500.00" },
      reportableTotal: "1500.00",
      withheld: "0",
      paymentCount: 3,
      tracedCash: "1500.00",
    },
    belowThreshold: false,
    paymentIds: [],
    paymentTraces: [],
    ...rest,
  };
}

function computation(
  recipients: RecipientComputation[],
  exceptions: FilingComputation["exceptions"] = [],
): FilingComputation {
  return {
    taxYear: 2025,
    formType: "1099-NEC",
    threshold: "2000",
    currency: "USD",
    recipients,
    exceptions,
    tracedCash: "0",
  };
}

test("reportable recipients map boxes, totals and card exclusions", () => {
  const rows = buildNecPreparationRows(
    computation([recipient({ partyId: "v1" })]),
    new Map([["v1", "250.00"]]),
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.vendorName, "Vendor v1");
  assert.equal(row.tinLast4, "4321");
  assert.equal(row.box1, "1500.00");
  assert.equal(row.withheld, "0");
  assert.equal(row.reportableTotal, "1500.00");
  assert.equal(row.belowThreshold, false);
  assert.equal(row.paymentCount, 3);
  assert.equal(row.cardPaid, "250.00");
  assert.deepEqual(row.exclusionKinds, []);
  assert.deepEqual(row.exclusionDetails, []);
});

test("below-threshold and missing-TIN recipients keep their flags", () => {
  const rows = buildNecPreparationRows(
    computation(
      [
        recipient({
          partyId: "v2",
          belowThreshold: true,
          amounts: {
            boxAmounts: { nec1: "120.00" },
            reportableTotal: "120.00",
            withheld: "0",
            paymentCount: 1,
            tracedCash: "120.00",
          },
        }),
      ],
      [
        { kind: "missing_tin", partyId: "v2", partyName: "Vendor v2", detail: "no TIN" },
        {
          kind: "corporation_flagged",
          partyId: "v2",
          partyName: "Vendor v2",
          detail: "classified c_corp",
        },
      ],
    ),
    new Map(),
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.belowThreshold, true);
  assert.equal(row.cardPaid, "0");
  // The TIN column owns missing-TIN; the notes column keeps the rest.
  assert.deepEqual(row.exclusionKinds, ["corporation_flagged"]);
  assert.deepEqual(row.exclusionDetails, ["classified c_corp"]);
});

test("a null TIN passes through for the masked column", () => {
  const base = recipient({ partyId: "v3" });
  const rows = buildNecPreparationRows(
    computation([{ ...base, profile: { ...base.profile, tinLast4: null } }]),
    new Map(),
  );
  assert.equal(rows[0]!.tinLast4, null);
});

test("an empty computation yields no rows", () => {
  assert.deepEqual(buildNecPreparationRows(computation([]), new Map()), []);
});
