import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SqlExecutor } from "../platform/db.ts";
import { annualPeriodOpeningBounds } from "./period-opening-bounds.ts";
import { payrollPeriodOpeningPriors } from "./period-opening-source.ts";
import {
  employeeEmployerAssignmentHistory,
  lockEmployerAssignmentProfiles,
} from "./employer-assignment-history.ts";
import { payrollPack } from "./packs.ts";

const orgId = "00000000-0000-4000-8000-000000000001";
const employee = "00000000-0000-4000-8000-000000000002";

for (const operation of [
  "annual bounds",
  "period priors",
  "assignment history",
  "assignment locks",
] as const) {
  test(`missing required payroll storage refuses ${operation} without inventing empty evidence`, async () => {
    const missing = Object.assign(new Error("Required payroll relation is unavailable"), {
      code: "42P01",
    });
    const dialect = new PgDialect();
    const executor = {
      execute: async (query: SQL, mode?: string) => {
        const inMode = <T extends { rows: unknown }>(result: T) =>
          mode === "objects" ? result.rows : result;
        if (dialect.sqlToQuery(query).sql.includes("to_regclass"))
          return inMode({ rows: [{ available: false }] });
        throw missing;
      },
    } as unknown as SqlExecutor;
    const read = () => {
      switch (operation) {
        case "annual bounds":
          return annualPeriodOpeningBounds(executor, orgId, [employee], 2026);
        case "period priors":
          return payrollPeriodOpeningPriors(executor, {
            orgId,
            employeePartyIds: [employee],
            pack: payrollPack("CA"),
            periodic: true,
            run: {
              payScheduleId: orgId,
              periodStart: "2026-07-12",
              periodEnd: "2026-07-18",
              payDate: "2026-07-21",
              taxYear: 2026,
              country: "CA",
              currency: "CAD",
              subsidiaryId: orgId,
              label: "PAY-00001",
            },
          });
        case "assignment history":
          return employeeEmployerAssignmentHistory(executor, {
            orgId,
            payDate: "2026-07-21",
            employeePartyIds: [employee],
          });
        case "assignment locks":
          return lockEmployerAssignmentProfiles(executor, orgId, [employee]);
      }
    };
    await assert.rejects(read, (error) => error === missing);
  });
}
