import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRetroSelection } from "./retro-selection";

const periods = [
  {
    candidate: { employeePartyId: "employee-a", sourcePayRunDocumentId: "run-a" },
    difference: { delta: "9007199254740993.0001" },
  },
  {
    candidate: { employeePartyId: "employee-a", sourcePayRunDocumentId: "run-b" },
    difference: { delta: "0.0002" },
  },
  {
    candidate: { employeePartyId: "employee-b", sourcePayRunDocumentId: "run-c" },
    difference: { delta: "12.9999" },
  },
];

test("retro summary totals and employee count follow the selected source runs exactly", () => {
  const all = summarizeRetroSelection(periods, []);
  assert.equal(all.owed, "9007199254741006.0002");
  assert.equal(all.employeeCount, 2);

  const excluded = summarizeRetroSelection(periods, ["run-a", "run-c"]);
  assert.deepEqual(
    excluded.selected.map((period) => period.candidate.sourcePayRunDocumentId),
    ["run-b"],
  );
  assert.equal(excluded.owed, "0.0002");
  assert.equal(excluded.employeeCount, 1);
});

test("empty selection has no owed amount or employees", () => {
  assert.deepEqual(summarizeRetroSelection(periods, ["run-a", "run-b", "run-c"]), {
    selected: [],
    owed: "0.0000",
    employeeCount: 0,
  });
});

test("a selected payable period must carry its calculated difference", () => {
  assert.throws(
    () =>
      summarizeRetroSelection(
        [
          {
            candidate: { employeePartyId: "employee-a", sourcePayRunDocumentId: "run-a" },
            difference: null,
          },
        ],
        [],
      ),
    /payable retro period is missing its calculated difference/,
  );
});
