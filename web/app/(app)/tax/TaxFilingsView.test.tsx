import assert from "node:assert/strict";
import test from "node:test";
import {
  adjustmentQuery,
  buildPrepareBody,
  checkAdjustmentDraft,
  exportScopeQuery,
  obligationPeriodForForm,
} from "./TaxFilingsView.tsx";

test("period lookup uses the selected form obligation, not another form", () => {
  const obligations = [
    {
      returnFormCode: "CA_GST34",
      reportableFrom: "2026-04-01",
      reportableTo: "2026-06-30",
    },
    {
      returnFormCode: "GB_VAT100",
      reportableFrom: "2026-05-01",
      reportableTo: "2026-06-30",
    },
  ];

  assert.deepEqual(obligationPeriodForForm(obligations, "GB_VAT100"), {
    from: "2026-05-01",
    to: "2026-06-30",
  });
});

test("a form without an obligation does not inherit the last response entry", () => {
  const obligations = [
    {
      returnFormCode: "CA_GST34",
      reportableFrom: "2026-04-01",
      reportableTo: "2026-06-30",
    },
  ];

  assert.equal(obligationPeriodForForm(obligations, "GB_VAT100"), null);
});

// Prepare freezes exactly what was previewed — the clamped window plus
// the preview's own filing scope — so an entity-scoped or translated preview
// is what gets filed, not the org-wide default.
test("prepare carries the preview window and filing scope", () => {
  assert.deepEqual(
    buildPrepareBody(
      "GST-Q",
      {
        from: "2026-07-16",
        to: "2026-07-31",
        subsidiaryIds: ["sub-a"],
        registrationId: "reg-1",
        translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-07-31" },
      },
      [],
    ),
    {
      code: "GST-Q",
      from: "2026-07-16",
      to: "2026-07-31",
      adjustments: [],
      filingEntity: { subsidiaryIds: ["sub-a"], registrationId: "reg-1" },
      translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-07-31" },
    },
  );
});

test("prepare of an org-wide preview carries reasoned adjustment entries", () => {
  assert.deepEqual(
    buildPrepareBody(
      "GST-Q",
      {
        from: "2026-07-01",
        to: "2026-07-31",
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      },
      [{ lineCode: "104", amount: "12.50", reason: "Prior-system activity" }],
    ),
    {
      code: "GST-Q",
      from: "2026-07-01",
      to: "2026-07-31",
      adjustments: [{ lineCode: "104", amount: "12.50", reason: "Prior-system activity" }],
    },
  );
});

test("export carries the preview scope and translation the export route parses", () => {
  assert.equal(
    exportScopeQuery({
      subsidiaryIds: ["sub-a", "sub-b"],
      registrationId: "reg-1",
      translation: { presentationCurrency: "CAD", rateType: "spot", rateDate: "2026-07-31" },
    }),
    "&subsidiary=sub-a&subsidiary=sub-b&registration=reg-1" +
      "&presentationCurrency=CAD&rateType=spot&rateDate=2026-07-31",
  );
});

test("export of an org-wide preview contributes no scope params", () => {
  assert.equal(
    exportScopeQuery({ subsidiaryIds: [], registrationId: null, translation: null }),
    "",
  );
});

test("adjustment preview preserves repeated lines and exact decimal strings", () => {
  assert.equal(
    adjustmentQuery([
      { lineCode: "104", amount: " 1000.00 ", reason: "January to June activity" },
      { lineCode: "104", amount: "2018.84", reason: "July and August activity" },
    ]),
    "&adj_104=1000.00&adj_104=2018.84",
  );
});

test("adjustment entry requires a supported line, exact amount and attributable reason", () => {
  const valid = { lineCode: "104", amount: " 3018.84 ", reason: " Pre-conversion activity " };
  const lines = new Set(["104"]);
  assert.deepEqual(checkAdjustmentDraft(valid, lines), {
    ok: true,
    entry: { lineCode: "104", amount: "3018.84", reason: "Pre-conversion activity" },
  });
  for (const amount of ["12,34", "1e3", "0.00001", "1000000000000000", ""]) {
    assert.deepEqual(checkAdjustmentDraft({ ...valid, amount }, lines), {
      ok: false,
      field: "amount",
    });
  }
  assert.deepEqual(checkAdjustmentDraft({ ...valid, reason: " " }, lines), {
    ok: false,
    field: "reason",
  });
  assert.deepEqual(checkAdjustmentDraft({ ...valid, lineCode: "109" }, lines), {
    ok: false,
    field: "lineCode",
  });
});
