import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  groupLaborPostings,
  laborPostingLines,
  LaborPostingPeriodError,
  type LaborPostingSourceRow,
} from "./recognition.ts";

test("labor postings never mix subsidiaries and remain balanced by group", () => {
  const rows: LaborPostingSourceRow[] = [
    {
      id: "a",
      project_id: "p1",
      hours: "2",
      cost_rate: "50",
      worked_on: "2026-07-10",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "b",
      project_id: "p1",
      hours: "1.5",
      cost_rate: "40",
      worked_on: "2026-07-11",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "c",
      project_id: "p2",
      hours: "3",
      cost_rate: "30",
      worked_on: "2026-07-09",
      subsidiary_id: "us",
      cost_rate_currency: "USD",
      period_id: "jul",
    },
  ];
  const groups = groupLaborPostings(rows).sort((a, b) =>
    String(a.subsidiaryId).localeCompare(String(b.subsidiaryId)),
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], {
    subsidiaryId: "ca",
    currency: "CAD",
    periodId: "jul",
    postingDate: "2026-07-11",
    timeEntryIds: ["a", "b"],
    projectCosts: [{ projectId: "p1", amount: "160.0000" }],
    total: "160.0000",
  });
  const usGroup = groups[1]!;
  assert.equal(usGroup.subsidiaryId, "us");
  assert.equal(usGroup.total, "90.0000");
  assert.equal(
    usGroup.projectCosts.reduce((sum, row) => sum + Number(row.amount), 0),
    Number(usGroup.total),
  );
});

test("a week spanning a period boundary posts each period's labor on its own latest worked day", () => {
  const groups = groupLaborPostings([
    {
      id: "sep-29",
      project_id: "p1",
      hours: "8",
      cost_rate: "50",
      worked_on: "2026-09-29",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "sep",
    },
    {
      id: "sep-30",
      project_id: "p1",
      hours: "8",
      cost_rate: "50",
      worked_on: "2026-09-30",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "sep",
    },
    {
      id: "oct-01",
      project_id: "p1",
      hours: "8",
      cost_rate: "50",
      worked_on: "2026-10-01",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "oct",
    },
    {
      id: "oct-05",
      project_id: "p2",
      hours: "4",
      cost_rate: "50",
      worked_on: "2026-10-05",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "oct",
    },
  ]).sort((a, b) => a.postingDate.localeCompare(b.postingDate));
  assert.deepEqual(
    groups.map((group) => [group.periodId, group.postingDate, group.timeEntryIds, group.total]),
    [
      ["sep", "2026-09-30", ["sep-29", "sep-30"], "800.0000"],
      ["oct", "2026-10-05", ["oct-01", "oct-05"], "600.0000"],
    ],
  );
});

test("costed time outside every accounting period is refused by its worked date", () => {
  assert.throws(
    () =>
      groupLaborPostings([
        {
          id: "a",
          project_id: "p1",
          hours: "1",
          cost_rate: "50",
          worked_on: "2026-07-10",
          subsidiary_id: "ca",
          cost_rate_currency: "CAD",
          period_id: "jul",
        },
        {
          id: "b",
          project_id: "p1",
          hours: "1",
          cost_rate: "50",
          worked_on: "2031-01-02",
          subsidiary_id: "ca",
          cost_rate_currency: "CAD",
          period_id: null,
        },
      ]),
    (error: unknown) => error instanceof LaborPostingPeriodError && error.workedOn === "2031-01-02",
  );
  assert.deepEqual(
    groupLaborPostings([
      {
        id: "uncosted",
        project_id: "p1",
        hours: "1",
        cost_rate: null as unknown as string,
        worked_on: "2031-01-02",
        subsidiary_id: "ca",
        cost_rate_currency: "CAD",
        period_id: null,
      },
    ]),
    [],
    "uncosted time needs no period",
  );
});

test("zero labor is omitted without creating an empty journal group", () => {
  assert.deepEqual(
    groupLaborPostings([
      {
        id: "a",
        project_id: "p1",
        hours: "0",
        cost_rate: "50",
        worked_on: "2026-07-10",
        subsidiary_id: "ca",
        cost_rate_currency: "CAD",
        period_id: "jul",
      },
    ]),
    [],
  );
});

test("labor posting groups never mix functional currencies", () => {
  const groups = groupLaborPostings([
    {
      id: "a",
      project_id: "p1",
      hours: "1",
      cost_rate: "20",
      worked_on: "2026-07-10",
      subsidiary_id: "sub",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "b",
      project_id: "p1",
      hours: "1",
      cost_rate: "20",
      worked_on: "2026-07-10",
      subsidiary_id: "sub",
      cost_rate_currency: "USD",
      period_id: "jul",
    },
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
    {
      id: "no-rate",
      project_id: "p1",
      hours: "4",
      cost_rate: null as unknown as string,
      worked_on: "2026-07-10",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "zero-rate",
      project_id: "p1",
      hours: "4",
      cost_rate: "0",
      worked_on: "2026-07-10",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "zero-hours",
      project_id: "p1",
      hours: "0",
      cost_rate: "50",
      worked_on: "2026-07-10",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
    {
      id: "real",
      project_id: "p1",
      hours: "2",
      cost_rate: "50",
      worked_on: "2026-07-11",
      subsidiary_id: "ca",
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
  ];
  const groups = groupLaborPostings(rows);
  assert.equal(groups.length, 1);
  // Only the costed entry posts, and it posts its full value.
  const group = groups[0]!;
  // Only the costed entry posts, and it posts its full value.
  assert.deepEqual(group.timeEntryIds, ["real"]);
  assert.equal(group.total, "100.0000");
});

test("a week with no costed entries at all produces no postings", () => {
  const groups = groupLaborPostings([
    {
      id: "a",
      project_id: "p1",
      hours: "8",
      cost_rate: null as unknown as string,
      worked_on: "2026-07-10",
      subsidiary_id: null,
      cost_rate_currency: "CAD",
      period_id: "jul",
    },
  ]);
  assert.deepEqual(groups, []);
});

test("an amended week's offset and re-coded time post a balanced reclass with no zero line", () => {
  const accounts = { laborWip: "wip", laborClearing: "clearing" };
  const reclass = laborPostingLines(
    {
      projectCosts: [
        { projectId: "lot-15", amount: "-1947.1140" },
        { projectId: "lot-12", amount: "1947.1140" },
      ],
      total: "0.0000",
    },
    accounts,
  );
  assert.deepEqual(
    reclass.map((line) => [line.accountId, line.projectId ?? null, line.amount]),
    [
      ["wip", "lot-15", "-1947.1140"],
      ["wip", "lot-12", "1947.1140"],
    ],
  );
  assert.equal(
    laborPostingLines(
      { projectCosts: [{ projectId: "lot-15", amount: "0.0000" }], total: "0.0000" },
      accounts,
    ).length,
    0,
    "a group netting to nothing posts nothing",
  );
  const ordinary = laborPostingLines(
    { projectCosts: [{ projectId: "lot-12", amount: "100" }], total: "100" },
    accounts,
  );
  assert.deepEqual(
    ordinary.map((line) => [line.accountId, line.amount]),
    [
      ["wip", "100"],
      ["clearing", "-100.0000"],
    ],
  );
});
