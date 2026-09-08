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
const { seedAdoption } =
  await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } =
  await import("@openbooks/engine/src/test-fixtures.ts");
const { guardPayrollFilingRowIds, guardPayrollFilingData, payrollRowScope } =
  await import("../app/api/payroll/subsidiary-scope");

test(
  "native UUIDv7 filing accounts retain their entity authorization and invalid suffixes fail closed",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      const hidden = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden filing entity','CAD','CA')`,
      );
      const account = (
        await db.execute<{ id: string }>(
          sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'CA','ca_rp','123456789RP0001','Native filing account',${hidden}) returning id`,
        )
      ).rows[0]!.id;
      assert.equal(
        account[14],
        "7",
        "fixture uses the database native UUID generator",
      );
      const gate = {
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["payroll.read"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      const rowId = `${fx.employeeId}:ON:${account}`;
      assert.deepEqual(payrollRowScope("CA", "t4", rowId), {
        employees: [fx.employeeId],
        accounts: [account],
      });
      assert.equal(
        (await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026))
          ?.status,
        404,
      );
      assert.equal(
        (
          await guardPayrollFilingData(
            gate,
            "CA",
            "t4",
            {
              columns: [],
              rowKey: "rowId",
              rows: [{ rowId }],
            },
            2026,
          )
        )?.status,
        404,
      );
      await db.execute(
        sql`update payroll_filing_accounts set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${account}`,
      );
      assert.equal(
        await guardPayrollFilingRowIds(gate, "CA", "t4", [rowId], 2026),
        null,
        "visible native account remains usable",
      );
      for (const malformed of [
        `${fx.employeeId}:ON:not-an-account`,
        `${fx.employeeId}:not-an-account`,
      ]) {
        const filing = malformed.split(":").length === 3 ? "t4" : "w2";
        const country = filing === "t4" ? "CA" : "US";
        assert.equal(payrollRowScope(country, filing, malformed), null);
        assert.equal(
          (
            await guardPayrollFilingRowIds(
              gate,
              country,
              filing,
              [malformed],
              2026,
            )
          )?.status,
          404,
        );
      }
      const employee = (
        await db.execute<{ id: string }>(
          sql`insert into parties(org_id,kind,display_name,subsidiary_id) values(${fx.orgId},'person','Native payroll employee',${fx.subsidiaryId}) returning id`,
        )
      ).rows[0]!.id;
      assert.equal(employee[14], "7");
      for (const filing of ["roe", "rl1"])
        assert.deepEqual(payrollRowScope("CA", filing, employee), {
          employees: [employee],
          accounts: [],
        });
      assert.deepEqual(
        payrollRowScope("CA", "t4", `${employee}:ON:${account}`),
        { employees: [employee], accounts: [account] },
      );
      assert.deepEqual(payrollRowScope("US", "w2", `${employee}:${account}`), {
        employees: [employee],
        accounts: [account],
      });
      assert.deepEqual(payrollRowScope("US", "941", `${account}:1`), {
        employees: [],
        accounts: [account],
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
