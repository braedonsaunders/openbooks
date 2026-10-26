import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
  seedHourlyPayrollTime,
} from "../testing/payroll-hourly-fixture.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a country-less statutory component cannot substitute for its required country-pack identity",
  { skip: !DB },
  async () => {
    const fx = await seedHourlyPayrollOrg();
    try {
      const { partyId } = await seedHourlyPayrollEmployee(fx, "Scoped statutory employee");
      await seedHourlyPayrollTime(fx, partyId, ["2026-07-13"]);
      await db.execute(sql`insert into pay_components(org_id,code,name,kind,system_key,country,basis,sequence,
      liability_account_id,expense_account_id,created_by,updated_by)
      select org_id,'UNSCOPED-CPP',name,kind,system_key,null,basis,sequence,
        liability_account_id,expense_account_id,created_by,updated_by
      from pay_components where org_id=${fx.orgId} and country='CA' and system_key='cpp' and kind='deduction'`);
      await db.execute(sql`update pay_components set is_active=false
      where org_id=${fx.orgId} and country='CA' and system_key='cpp' and kind='deduction'`);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(result.errors.length, 1);
      assert.match(
        result.errors[0]!.message,
        /missing system pay component cpp\/deduction.*Payroll setup/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
        "the refused statutory identity leaves no partially calculated employee",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
