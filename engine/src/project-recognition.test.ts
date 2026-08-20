import { strict as assert } from "node:assert";
import { test } from "node:test";
import { groupLaborPostings, type LaborPostingSourceRow } from "./project-recognition.ts";

test("labor postings never mix subsidiaries and remain balanced by group", () => {
  const rows: LaborPostingSourceRow[] = [
    { id: "a", project_id: "p1", hours: "2", cost_rate: "50", worked_on: "2026-07-10", subsidiary_id: "ca", cost_rate_currency: "CAD" },
    { id: "b", project_id: "p1", hours: "1.5", cost_rate: "40", worked_on: "2026-07-11", subsidiary_id: "ca", cost_rate_currency: "CAD" },
    { id: "c", project_id: "p2", hours: "3", cost_rate: "30", worked_on: "2026-07-09", subsidiary_id: "us", cost_rate_currency: "USD" },
  ];
  const groups = groupLaborPostings(rows).sort((a, b) => String(a.subsidiaryId).localeCompare(String(b.subsidiaryId)));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    subsidiaryId: "ca",
    currency: "CAD",
    postingDate: "2026-07-11",
    timeEntryIds: ["a", "b"],
    projectCosts: [{ projectId: "p1", amount: "160.0000" }],
    total: "160.0000",
  });
  assert.equal(groups[1].subsidiaryId, "us");
  assert.equal(groups[1].total, "90.0000");
  assert.equal(groups[1].projectCosts.reduce((sum, row) => sum + Number(row.amount), 0), Number(groups[1].total));
});

test("zero labor is omitted without creating an empty journal group", () => {
  assert.deepEqual(groupLaborPostings([
    { id: "a", project_id: "p1", hours: "0", cost_rate: "50", worked_on: "2026-07-10", subsidiary_id: "ca", cost_rate_currency: "CAD" },
  ]), []);
});

test("labor posting groups never mix functional currencies", () => {
  const groups = groupLaborPostings([
    { id: "a", project_id: "p1", hours: "1", cost_rate: "20", worked_on: "2026-07-10", subsidiary_id: "sub", cost_rate_currency: "CAD" },
    { id: "b", project_id: "p1", hours: "1", cost_rate: "20", worked_on: "2026-07-10", subsidiary_id: "sub", cost_rate_currency: "USD" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(new Set(groups.map((group) => group.currency)), new Set(["CAD", "USD"]));
});

test("a time entry with no wage rate is skipped, not fatal", () => {
  // Regression: mulRate validates its second argument as an FX RATE and
  // rejects zero, so a null/zero cost_rate threw before the isZero skip could
  // run — approving a week for anyone without a configured wage rate failed
  // outright, reporting an "FX rate" problem that was really a missing rate.
  const rows: LaborPostingSourceRow[] = [
    { id: "no-rate", project_id: "p1", hours: "4", cost_rate: null as unknown as string, worked_on: "2026-07-10", subsidiary_id: "ca", cost_rate_currency: "CAD" },
    { id: "zero-rate", project_id: "p1", hours: "4", cost_rate: "0", worked_on: "2026-07-10", subsidiary_id: "ca", cost_rate_currency: "CAD" },
    { id: "zero-hours", project_id: "p1", hours: "0", cost_rate: "50", worked_on: "2026-07-10", subsidiary_id: "ca", cost_rate_currency: "CAD" },
    { id: "real", project_id: "p1", hours: "2", cost_rate: "50", worked_on: "2026-07-11", subsidiary_id: "ca", cost_rate_currency: "CAD" },
  ];
  const groups = groupLaborPostings(rows);
  assert.equal(groups.length, 1);
  // Only the costed entry posts, and it posts its full value.
  assert.deepEqual(groups[0].timeEntryIds, ["real"]);
  assert.equal(groups[0].total, "100.0000");
});

test("a week with no costed entries at all produces no postings", () => {
  const groups = groupLaborPostings([
    { id: "a", project_id: "p1", hours: "8", cost_rate: null as unknown as string, worked_on: "2026-07-10", subsidiary_id: null, cost_rate_currency: "CAD" },
  ]);
  assert.deepEqual(groups, []);
});
