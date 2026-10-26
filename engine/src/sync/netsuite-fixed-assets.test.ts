import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeNetSuiteFamTaxAttributes,
  netSuiteFamDate,
  netSuiteFamHistoryHasFinancialFacts,
  netSuiteFamHistorySourceId,
  netSuiteFamPeriodForDate,
  netSuiteFamState,
  planNetSuiteFamAcquisitions,
  reconcileNetSuiteFamAcquisitions,
  type NetSuiteFamExistingAcquisition,
} from "./netsuite-fixed-assets.ts";

test("unassigned journal-link metadata is preserved separately from financial asset history", () => {
  assert.equal(
    netSuiteFamHistoryHasFinancialFacts({
      custrecord_deprhistjournal: "348279",
      custrecord_deprhistamount: null,
    }),
    false,
  );
  assert.equal(netSuiteFamHistoryHasFinancialFacts({ custrecord_deprhistamount: "0.0000" }), true);
  assert.equal(netSuiteFamHistoryHasFinancialFacts({ custrecord_deprhistamount: "1.00" }), true);
  assert.equal(
    netSuiteFamHistoryHasFinancialFacts({ custrecord_deprhistbookvalue: "12.00" }),
    true,
  );
});

test("NetSuite FAM dates remain date-only", () => {
  assert.equal(netSuiteFamDate("11/14/2021"), "2021-11-14");
  assert.equal(netSuiteFamDate("2026-07-21T14:00:00Z"), "2026-07-21");
  assert.equal(netSuiteFamDate(null), null);
});

test("NetSuite FAM depreciation dates outside the accounting calendar are not shifted", () => {
  const periods = [
    { id: "2026-12", starts_on: "2026-12-01", ends_on: "2026-12-31", is_adjustment: false },
  ];
  assert.equal(netSuiteFamPeriodForDate(periods, "2027-01-15"), null);
  assert.equal(netSuiteFamPeriodForDate(periods, "2026-12-15")?.id, "2026-12");
});

test("NetSuite FAM state reconciles current cost to exact book value", () => {
  const state = netSuiteFamState(
    { id: "2", custrecord_assetcurrentcost: "20316.15" },
    { custrecord_slavebookvalue: "19477.38" },
    [{ id: "3", custrecord_deprhistamount: "19477.38" }],
  );
  assert.deepEqual(
    { cost: state.cost, accumulated: state.accumulated, bookValue: state.bookValue },
    { cost: "20316.1500", accumulated: "838.7700", bookValue: "19477.3800" },
  );
  assert.equal(
    mergeNetSuiteFamTaxAttributes({ ca_cca_class: "8" }, { nsId: "type-1" }).ca_cca_class,
    "8",
  );
});
const acquisitionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "history-1",
  fam_history_type_label: "Acquisition",
  custrecord_deprhistdate: "01/15/2024",
  custrecord_deprhistamount: "12000.00",
  ...overrides,
});

const admittedEvent = (
  overrides: Partial<NetSuiteFamExistingAcquisition> = {},
): NetSuiteFamExistingAcquisition => ({
  id: "event-1",
  kind: "acquired",
  occurredOn: "2024-01-15",
  amount: "12000.0000",
  journalEntryId: null,
  financialChangeId: null,
  bookId: null,
  memo: "[NetSuite FAM history history-1]",
  reversed: false,
  ...overrides,
});

test("NetSuite FAM history identity is proved only by the exact admission marker", () => {
  assert.equal(netSuiteFamHistorySourceId("[NetSuite FAM history 4821]"), "4821");
  assert.equal(netSuiteFamHistorySourceId("[NetSuite FAM history unknown]"), null);
  assert.equal(netSuiteFamHistorySourceId("NetSuite FAM history 4821"), null);
  assert.equal(netSuiteFamHistorySourceId(null), null);
});

test("NetSuite FAM acquisition planning requires identity and exact money", () => {
  assert.deepEqual(planNetSuiteFamAcquisitions("asset-1", [acquisitionRow()], null, "2026-07-15"), [
    { sourceHistoryId: "history-1", occurredOn: "2024-01-15", amount: "12000.0000" },
  ]);
  assert.throws(
    () =>
      planNetSuiteFamAcquisitions("asset-1", [acquisitionRow({ id: "  " })], null, "2026-07-15"),
    /without a stable source history id/,
  );
  assert.throws(
    () =>
      planNetSuiteFamAcquisitions(
        "asset-1",
        [acquisitionRow(), acquisitionRow()],
        null,
        "2026-07-15",
      ),
    /repeats source history id history-1/,
  );
  assert.throws(
    () =>
      planNetSuiteFamAcquisitions(
        "asset-1",
        [acquisitionRow({ custrecord_deprhistamount: "" })],
        null,
        "2026-07-15",
      ),
    /must be an exact decimal/,
  );
  assert.throws(
    () =>
      planNetSuiteFamAcquisitions(
        "asset-1",
        [acquisitionRow({ custrecord_deprhistamount: "12,000.00" })],
        null,
        "2026-07-15",
      ),
    /must be an exact decimal/,
  );
});

test("NetSuite FAM exact replay reuses the admitted acquisition with nothing to insert", () => {
  const planned = planNetSuiteFamAcquisitions("asset-1", [acquisitionRow()], null, "2026-07-15");
  assert.deepEqual(reconcileNetSuiteFamAcquisitions("asset-1", planned, [admittedEvent()]), {
    reusedEventIds: ["event-1"],
    insert: [],
  });
  const withNewRow = planNetSuiteFamAcquisitions(
    "asset-1",
    [acquisitionRow(), acquisitionRow({ id: "history-2", custrecord_deprhistamount: "500" })],
    null,
    "2026-07-15",
  );
  assert.deepEqual(reconcileNetSuiteFamAcquisitions("asset-1", withNewRow, [admittedEvent()]), {
    reusedEventIds: ["event-1"],
    insert: [withNewRow[1]!],
  });
});

test("NetSuite FAM changed or vanished source history refuses with history preserved", () => {
  const planned = planNetSuiteFamAcquisitions("asset-1", [acquisitionRow()], null, "2026-07-15");
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [
        admittedEvent({ amount: "11999.0000" }),
      ]),
    /append-only and has been preserved/,
  );
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [
        admittedEvent({ occurredOn: "2024-01-16" }),
      ]),
    /no longer matches the admitted date or amount/,
  );
  assert.throws(
    () => reconcileNetSuiteFamAcquisitions("asset-1", [], [admittedEvent()]),
    /absent from the full source snapshot/,
  );
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [admittedEvent({ kind: "revalued" })]),
    /conflicts with the admitted native representation/,
  );
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [
        admittedEvent({ journalEntryId: "entry-1" }),
      ]),
    /conflicts with the admitted native representation/,
  );
  assert.throws(
    () => reconcileNetSuiteFamAcquisitions("asset-1", planned, [admittedEvent({ reversed: true })]),
    /reversed by a governed native correction/,
  );
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [
        admittedEvent(),
        admittedEvent({ id: "event-2" }),
      ]),
    /admitted more than once/,
  );
  assert.throws(
    () =>
      reconcileNetSuiteFamAcquisitions("asset-1", planned, [
        admittedEvent({ memo: "[NetSuite FAM history unknown]" }),
      ]),
    /without a provable source history identity/,
  );
});

test("NetSuite FAM state refuses a carrying value above cost", () => {
  assert.throws(
    () =>
      netSuiteFamState(
        { id: "bad", custrecord_assetcurrentcost: "10" },
        { custrecord_slavebookvalue: "10.01" },
        [],
      ),
    /book value .* above current cost/,
  );
});
