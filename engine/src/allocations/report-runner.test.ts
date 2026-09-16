import assert from "node:assert/strict";
import test from "node:test";
import { DriverNotAvailableError } from "./drivers.ts";
import { projectDriverRows, runDriverReport } from "./report-runner.ts";

const rowsCompiled = {
  mode: "rows" as const,
  columns: ["department_id", "headcount"],
  breakouts: [],
  measures: [],
};

const summarizeCompiled = {
  mode: "summarize" as const,
  columns: [],
  breakouts: [{ column: "account_id" }],
  measures: [{ fn: "sum" as const, column: "debit" }],
};

test("rows mode projects dimension and value keys", () => {
  const out = projectDriverRows(
    [
      { department_id: "dept-a", headcount: "3.0000" },
      { department_id: "dept-b", headcount: "1.0000" },
    ],
    rowsCompiled,
    "department_id",
    "headcount",
  );
  assert.deepEqual(out, [
    { dimension: "dept-a", value: "3.0000" },
    { dimension: "dept-b", value: "1.0000" },
  ]);
});

test("duplicate dimensions sum exactly and nulls are handled", () => {
  const out = projectDriverRows(
    [
      { department_id: "dept-a", headcount: "0.1000" },
      { department_id: "dept-a", headcount: "0.2000" },
      { department_id: null, headcount: "99.0000" },
      { department_id: "dept-b", headcount: null },
    ],
    rowsCompiled,
    "department_id",
    "headcount",
  );
  assert.deepEqual(out, [
    { dimension: "dept-a", value: "0.3000" },
    { dimension: "dept-b", value: "0.0000" },
  ]);
});

test("rows mode refuses unselected columns", () => {
  assert.throws(
    () => projectDriverRows([{ a: "x" }], rowsCompiled, "nope", "headcount"),
    /nope/,
  );
  assert.throws(
    () => projectDriverRows([{ a: "x" }], rowsCompiled, "department_id", "nope"),
    /nope/,
  );
});

test("summarize mode reads d{i}/m{i} aliases", () => {
  const out = projectDriverRows(
    [
      { d0: "acct-1", m0: "100.0000", __txn_n: 1 },
      { d0: "acct-2", m0: "50.2500", __txn_n: 1 },
    ],
    summarizeCompiled,
    "account_id",
    "debit",
  );
  assert.deepEqual(out, [
    { dimension: "acct-1", value: "100.0000" },
    { dimension: "acct-2", value: "50.2500" },
  ]);
});

test("summarize falls back to the single candidate, else refuses", () => {
  const single = {
    mode: "summarize" as const,
    columns: [],
    breakouts: [{ column: "only-dim" }],
    measures: [{ fn: "sum" as const, column: "only-val" }],
  };
  const out = projectDriverRows([{ d0: "x", m0: "7" }], single, "whatever", "whatever");
  assert.deepEqual(out, [{ dimension: "x", value: "7.0000" }]);
  const multi = {
    mode: "summarize" as const,
    columns: [],
    breakouts: [{ column: "a" }, { column: "b" }],
    measures: [{ fn: "sum" as const, column: "v" }],
  };
  assert.throws(() => projectDriverRows([{ d0: "x", m0: "7" }], multi, "zzz", "v"), /zzz/);
});

test("report drivers fail closed without an actor", async () => {
  await assert.rejects(
    () =>
      runDriverReport({
        orgId: "org-1",
        reportDefinitionId: "def-1",
        dimensionColumn: "account_id",
        valueColumn: "amount",
        params: {},
        from: "2026-01-01",
        to: "2026-12-31",
        actorId: "",
        temporalMode: "balance_as_of",
      }),
    (error: unknown) => error instanceof DriverNotAvailableError && /actorId/.test(error.message),
  );
});
