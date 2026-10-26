import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlExecutor } from "../platform/db.ts";
import { assertPeriodModulesOpen, PeriodClosedError } from "./period-policy.ts";

test("the year-end seal supplies the reopen scope before period locks are checked", async () => {
  let calls = 0;
  const executor = {
    execute: async (_query: unknown, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      calls += 1;
      return inMode({
        rows:
          calls === 1
            ? [
                {
                  fiscal_year: 2026,
                  closing_period_id: "closing-period-id",
                  closing_period_name: "P12 FY2026",
                  subsidiary_id: "subsidiary-id",
                },
              ]
            : [],
      });
    },
  } as unknown as SqlExecutor;

  const failure = await assertPeriodModulesOpen(executor, {
    orgId: "org-id",
    periodId: "locked-midyear-period-id",
    bookId: "book-id",
    subsidiaryIds: ["subsidiary-id"],
    modules: ["ap"],
  }).catch((error: unknown) => error);

  assert.ok(failure instanceof PeriodClosedError);
  assert.match(failure.message, /period-end journals of fiscal year 2026/);
  assert.equal(failure.details.periodId, "closing-period-id");
  assert.equal(calls, 1);
});
