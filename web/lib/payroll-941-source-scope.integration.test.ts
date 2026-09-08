import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
registerHooks({
  resolve(s, c, n) {
    if (s === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return n(s, c);
  },
});
import test from "node:test";
import type { Authz } from "./authz";
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption } =
  await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } =
  await import("@openbooks/engine/src/test-fixtures.ts");
const { form941Worksheet } =
  await import("@openbooks/engine/src/payroll-yearend.ts");
const { guardPayrollFilingRowIds, guardPayrollFilingData, payrollRowScope } =
  await import("../app/api/payroll/subsidiary-scope");
test(
  "Form 941 guards every quarter source and preserves unassigned-root isolation",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const hidden = randomUUID(),
        doc = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Hidden Form 941 employer','CAD','US')`,
      );
      const account = (
        await db.execute<{ id: string }>(
          sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'US','us_ein','12-3456789','Visible EIN',${fx.subsidiaryId}) returning id`,
        )
      ).rows[0]!.id;
      await db.execute(
        sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${doc},${fx.orgId},'pay_run','941-SOURCE',${hidden},'2026-07-15','USD','draft')`,
      );
      await db.execute(
        sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${doc},${fx.orgId},${fx.scheduleId},'2026-07-15','2026-07-15','2026-07-15',2026,'committed','bonus')`,
      );
      await db.execute(
        sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${doc},${fx.employeeId},'US','calculation',${account},'calculation','NY',26,'2026-07-15',2026,'USD',100)`,
      );
      const quarters = await form941Worksheet(fx.orgId, 2026);
      assert.equal(quarters.length, 1);
      const gate = {
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["payroll.read"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      const denied = await guardPayrollFilingRowIds(
        gate,
        "US",
        "941",
        [`${account}:3`],
        2026,
      );

      assert.equal(
        denied?.status,
        404,
        "a visible EIN cannot authorize hidden payroll sources",
      );
      await db.execute(
        sql`update payroll_filing_accounts set subsidiary_id=${hidden} where org_id=${fx.orgId} and id=${account}`,
      );
      const child = { ...gate, allowedSubsidiaryIds: new Set([hidden]) };
      assert.equal(
        await guardPayrollFilingRowIds(
          child,
          "US",
          "941",
          [`${account}:3`],
          2026,
        ),
        null,
        "visible account and source remain accessible",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            child,
            "US",
            "941",
            [`${account}:2`],
            2026,
          )
        )?.status,
        404,
        "a different quarter cannot borrow source ownership",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            child,
            "US",
            "941",
            [`${account}:3`],
            2025,
          )
        )?.status,
        404,
        "a different year cannot borrow source ownership",
      );
      const unassignedDoc = randomUUID();
      await db.execute(
        sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${unassignedDoc},${fx.orgId},'pay_run','941-UNASSIGNED',${hidden},'2026-07-16','USD','draft')`,
      );
      await db.execute(
        sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${unassignedDoc},${fx.orgId},${fx.scheduleId},'2026-07-16','2026-07-16','2026-07-16',2026,'committed','bonus')`,
      );
      await db.execute(
        sql`insert into pay_stubs(org_id,pay_run_document_id,employee_party_id,country,country_source,filing_account_id,filing_account_source,province,periods_per_year,pay_date,tax_year,currency_code,pensionable_earnings) values(${fx.orgId},${unassignedDoc},${fx.employeeId},'US','calculation',null,'calculation','NY',26,'2026-07-16',2026,'USD',50)`,
      );
      const all = await form941Worksheet(fx.orgId, 2026);
      assert.equal(all.length, 2);
      assert.deepEqual(payrollRowScope("US", "941", ":3"), {
        employees: [],
        accounts: [],
      });
      assert.equal(
        (await guardPayrollFilingRowIds(child, "US", "941", [":3"], 2026))
          ?.status,
        404,
        "unassigned aggregate still requires root visibility",
      );
      const rowIds = all.map((q) => `${q.filingAccountId ?? ""}:${q.quarter}`);
      assert.equal(
        (await guardPayrollFilingRowIds(child, "US", "941", rowIds, 2026))
          ?.status,
        404,
        "a visible assigned account cannot mask an unassigned row",
      );
      const both = {
        ...gate,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId, hidden]),
      };
      assert.equal(
        await guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026),
        null,
      );
      assert.equal(
        await guardPayrollFilingData(
          both,
          "US",
          "941",
          { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
          2026,
        ),
        null,
      );
      assert.equal(
        (
          await guardPayrollFilingData(
            child,
            "US",
            "941",
            { columns: [], rowKey: "id", rows: rowIds.map((id) => ({ id })) },
            2026,
          )
        )?.status,
        404,
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            { ...gate, allowedSubsidiaryIds: new Set() },
            "US",
            "941",
            rowIds,
            2026,
          )
        )?.status,
        404,
      );
      assert.equal(
        await guardPayrollFilingRowIds(
          { ...gate, allowedSubsidiaryIds: null },
          "US",
          "941",
          rowIds,
          2026,
        ),
        null,
      );
      for (const id of [
        `${account}:0`,
        `${account}:5`,
        `${account}:1x`,
        ":0",
        ":5",
        "bad-account:1",
      ])
        assert.equal(payrollRowScope("US", "941", id), null);
      await db.execute(
        sql`update pay_runs set run_status='voided' where org_id=${fx.orgId}`,
      );
      assert.equal(
        await guardPayrollFilingRowIds(both, "US", "941", rowIds, 2026),
        null,
        "voided payroll retains ownership evidence for stored correction artifacts",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
