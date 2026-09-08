import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";
const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("openbooks.roe-source-route")
] = state;
registerHooks({
  resolve(s, c, n) {
    if (s === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (
      s === "../../../../../lib/feature-gates" &&
      c.parentURL?.endsWith("/api/payroll/year-end/file/route.ts")
    )
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.roe-source-route')].gate}",
          ),
      };
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
const { roeRecord } = await import("@openbooks/engine/src/payroll-yearend.ts");
const { guardPayrollFilingRowIds, guardPayrollFilingData } =
  await import("../app/api/payroll/subsidiary-scope");
const { POST } = await import("../app/api/payroll/year-end/file/route");

test(
  "ROE row, population and selected-file access checks historical earnings and current profile ownership",
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
        permissions: new Set(["payroll.read", "payroll.run"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      assert.equal(
        await guardPayrollFilingRowIds(
          gate,
          "CA",
          "roe",
          [fx.employeeId],
          2026,
        ),
        null,
      );
      const movedId = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${movedId},${fx.orgId},${fx.subsidiaryId},'Transferred ROE employee','CAD','CA')`,
      );
      await db.execute(
        sql`update parties set subsidiary_id=${movedId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      const record = await roeRecord(fx.orgId, fx.employeeId);
      assert.equal(record?.totalInsurableEarnings, "240.0000");
      assert.equal(record?.periods.length, 1);
      const moved = { ...gate, allowedSubsidiaryIds: new Set([movedId]) };
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            moved,
            "CA",
            "roe",
            [fx.employeeId],
            2026,
          )
        )?.status,
        404,
        "the current employer cannot read the earlier employer earnings",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            moved,
            "CA",
            "roe",
            [fx.employeeId],
            2025,
          )
        )?.status,
        404,
        "ROE source reads span years, independently of the population year",
      );
      assert.equal(
        (
          await guardPayrollFilingData(
            moved,
            "CA",
            "roe",
            { columns: [], rowKey: "id", rows: [{ id: fx.employeeId }] },
            2026,
          )
        )?.status,
        404,
      );
      state.gate = moved;
      const response = await POST(
        new Request("http://localhost/api/payroll/year-end/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            country: "CA",
            filing: "roe",
            year: 2026,
            employees: `${fx.employeeId}:A`,
          }),
        }),
      );
      assert.equal(
        response.status,
        404,
        "selected employee files use the same source boundary",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            gate,
            "CA",
            "roe",
            [fx.employeeId],
            2026,
          )
        )?.status,
        404,
        "historical access alone cannot disclose the current employment profile",
      );
      const combined = {
        ...gate,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId, movedId]),
      };
      assert.equal(
        await guardPayrollFilingRowIds(
          combined,
          "CA",
          "roe",
          [fx.employeeId],
          2026,
        ),
        null,
      );
      const accountOwner = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${accountOwner},${fx.orgId},${fx.subsidiaryId},'Hidden ROE account','CAD','CA')`,
      );
      const account = (
        await db.execute<{ id: string }>(
          sql`insert into payroll_filing_accounts(org_id,country,program_type,account_number,name,subsidiary_id) values(${fx.orgId},'CA','ca_rp','123456789RP0001','ROE profile account',${accountOwner}) returning id`,
        )
      ).rows[0]!.id;
      await db.execute(
        sql`update employee_payroll_profiles set filing_account_id=${account} where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`,
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            combined,
            "CA",
            "roe",
            [fx.employeeId],
            2026,
          )
        )?.status,
        404,
        "the ROE header filing account is also protected",
      );
      assert.equal(
        await guardPayrollFilingRowIds(
          {
            ...combined,
            allowedSubsidiaryIds: new Set([
              ...combined.allowedSubsidiaryIds!,
              accountOwner,
            ]),
          },
          "CA",
          "roe",
          [fx.employeeId],
          2026,
        ),
        null,
      );
      assert.equal(
        await guardPayrollFilingRowIds(
          { ...gate, allowedSubsidiaryIds: null },
          "CA",
          "roe",
          [fx.employeeId],
          2026,
        ),
        null,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "ROE authorization follows the declared period window and includes final-date ties outside it",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.employeeId}`,
      );
      await db.execute(
        sql`update pay_schedules set frequency='monthly',periods_per_year=12 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const hidden = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${hidden},${fx.orgId},${fx.subsidiaryId},'Historical source outside the window','CAD','CA')`,
      );
      // Minimal committed source history for exercising the selector itself.
      // Thirteen monthly-window stubs supersede one older hidden source.
      await db.transaction(async (tx) => {
        for (let index = 0; index <= 13; index++) {
          const documentId = randomUUID();
          const stubId =
            index === 0 ? "00000000-0000-4000-8000-000000000001" : randomUUID();
          const date =
            index === 0
              ? "2026-06-30"
              : `2026-07-${String(index).padStart(2, "0")}`;
          await tx.execute(
            sql`insert into documents(id,org_id,kind,document_number,subsidiary_id,document_date,currency,status) values(${documentId},${fx.orgId},'pay_run',${`ROE-WINDOW-${index}`},${index === 0 ? hidden : fx.subsidiaryId},${date},'CAD','draft')`,
          );
          await tx.execute(
            sql`insert into pay_runs(document_id,org_id,pay_schedule_id,period_start,period_end,pay_date,tax_year,run_status,run_type) values(${documentId},${fx.orgId},${fx.scheduleId},${date},${date},${date},2026,'committed','bonus')`,
          );
          await tx.execute(
            sql`insert into pay_stubs(id,org_id,pay_run_document_id,employee_party_id,country,country_source,province,periods_per_year,pay_date,tax_year,currency_code,insurable_earnings) values(${stubId},${fx.orgId},${documentId},${fx.employeeId},'CA','calculation','ON',12,${date},2026,'CAD',${index === 0 ? "999" : "1"})`,
          );
        }
      });
      const gate = {
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["payroll.read"]),
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      } as Authz;
      assert.equal(
        await guardPayrollFilingRowIds(
          gate,
          "CA",
          "roe",
          [fx.employeeId],
          2026,
        ),
        null,
        "older history outside the actual window does not block access",
      );
      const before = await roeRecord(fx.orgId, fx.employeeId);
      assert.equal(before?.periods.length, 13);
      assert.equal(before?.totalInsurableEarnings, "13.0000");
      // All records now tie on the final pay date. The hidden UUID sorts last and
      // stays outside Block 15, but Block 17 reads that complete final date.
      await db.execute(
        sql`update pay_stubs set pay_date='2026-07-13' where org_id=${fx.orgId}`,
      );
      const tied = await roeRecord(fx.orgId, fx.employeeId);
      assert.equal(tied?.periods.length, 13);
      assert.equal(
        tied?.totalInsurableEarnings,
        "13.0000",
        "window ties have deterministic ordering",
      );
      assert.equal(
        (
          await guardPayrollFilingRowIds(
            gate,
            "CA",
            "roe",
            [fx.employeeId],
            2026,
          )
        )?.status,
        404,
        "the separate final-date source must also be authorized",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
