import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";
registerHooks({
  resolve(s, c, n) {
    if (s === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return n(s, c);
  },
});
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption, calculatedRun } =
  await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } =
  await import("@openbooks/engine/src/test-fixtures.ts");
const { commitPayRun } = await import("@openbooks/engine/src/payroll-run.ts");
const { orgYearEndFilings } =
  await import("@openbooks/engine/src/payroll-yearend.ts");
const {
  guardPayrollYearEndFilings,
  guardPayrollFilingData,
  guardPayrollFilingRowIds,
} = await import("../app/api/payroll/subsidiary-scope");

test(
  "annual filing and amendment access stays with the historical employer after a transfer",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const gate = {
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["payroll.read"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      const filings = await orgYearEndFilings(fx.orgId, 2026);
      const t4 = filings.find((f) => f.country === "CA" && f.key === "t4")!;
      assert.equal(t4.data.rows.length, 1);
      const rowId = String(t4.data.rows[0]![t4.data.rowKey]);
      const hidden = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Transferred employee entity','CAD','CA')`,
      );
      await db.execute(
        sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      assert.equal(
        await guardPayrollYearEndFilings(gate, filings, 2026),
        null,
        "original employer retains the issued-year population",
      );
      assert.equal(
        await guardPayrollFilingData(gate, "CA", "t4", t4.data, 2026),
        null,
      );
      assert.equal(
        await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
        null,
        "stored amendment rows use the same historical scope",
      );
      const moved = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
      assert.equal(
        (await guardPayrollYearEndFilings(moved, filings, 2026))?.status,
        404,
      );
      assert.equal(
        (await guardPayrollFilingRowIds(moved, "CA", "t4", [rowId], 2026))
          ?.status,
        404,
        "new employer cannot read earlier payroll",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            { ...gate, allowedSubsidiaryIds: new Set() },
            "CA",
            "t4",
            [rowId],
            2026,
          )
        )?.status,
        404,
      );
      assert.equal(
        await guardPayrollFilingRowIds(
          { ...gate, allowedSubsidiaryIds: null },
          "CA",
          "t4",
          [rowId],
          2026,
        ),
        null,
      );
      assert.equal(
        (await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2025))
          ?.status,
        404,
        "a different year cannot borrow this year ownership",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "opening carry-in retains its additional entity boundary alongside historical payroll",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      await db.execute(
        sql`insert into payroll_opening_balances(org_id,employee_party_id,tax_year,taxable_ytd,created_by,updated_by) values(${fx.orgId},${fx.employeeId},2026,100,${fx.actorId},${fx.actorId})`,
      );
      const gate = {
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["payroll.read"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      const rowId = `${fx.employeeId}:ON:`;
      assert.equal(
        await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
        null,
        "opening-only population retains its employee boundary",
      );
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      const hidden = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Opening balance employee transfer','CAD','CA')`,
      );
      await db.execute(
        sql`update parties set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      assert.equal(
        (await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026))
          ?.status,
        404,
        "unstamped carry-in cannot be assigned to an original pay-run employer by inference",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            { ...gate, allowedSubsidiaryIds: new Set([hidden]) },
            "CA",
            "t4",
            [rowId],
            2026,
          )
        )?.status,
        404,
        "current employee ownership cannot grant access to another employer payroll",
      );
      assert.equal(
        await guardPayrollFilingRowIds(
          { ...gate, allowedSubsidiaryIds: new Set([hidden, fx.subsidiaryId]) },
          "CA",
          "t4",
          [rowId],
          2026,
        ),
        null,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
