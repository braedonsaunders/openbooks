import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp, neg, sum } from "./money.ts";
import { setPackSlotAccount } from "./payroll/packs.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "employer taxes: WCB splits by project under the assessable cap, EHT past the exemption",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const account = async (number: string, name: string, type: string) => {
        const id = randomUUID();
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                                reconcilable, required_dimensions, custom, subsidiary_include_children)
          values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
                  '[]'::jsonb, '{}'::jsonb, true)`);
        return id;
      };
      const wageExpense = await account("6000", "Wages expense", "expense");
      const burdenExpense = await account("6010", "Payroll burden", "expense");
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      const wcbPayable = await account("2330", "WSIB payable", "liability_current");
      const ehtPayable = await account("2340", "EHT payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
            // Ontario EHT: 1.95% past a (deliberately tiny) $1,000 exemption.
            ca: { eht: { enabled: true, rate: "1.95", annualExemption: "1000" } },
          },
        })}::jsonb where id = ${org.orgId}`);

      await seedPayrollComponents(org.orgId, actorId);
      await setPackSlotAccount(org.orgId, actorId, "CA", "wcb", wcbPayable);
      await setPackSlotAccount(org.orgId, actorId, "CA", "eht", ehtPayable);

      // Worker-comp class: 2% of assessable earnings, capped at $2,000/yr so
      // the cap binds inside this single $2,400 run.
      const wcbGroupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, max_assessable, is_active)
        values (${wcbGroupId}, ${org.orgId}, 'CLASS-A', 'Construction class A', '2', '2000', true)`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Casey Siteworker', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id, worker_comp_group_id)
        values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${wcbGroupId})`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                      is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2026-01-01', true, ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 1, 1,
                true, ${actorId}, ${actorId})`);

      // 40h on each of two jobs → $1,200 per job, $2,400 gross.
      const jobA = randomUUID();
      const jobB = randomUUID();
      for (const [id, name] of [[jobA, "Job A"], [jobB, "Job B"]] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${id}, ${org.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      for (const [workedOn, projectId] of [
        ["2026-07-06", jobA], ["2026-07-08", jobA],
        ["2026-07-10", jobB], ["2026-07-14", jobB],
      ] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                    is_billable, billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${workedOn}, 20, ${projectId}, 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
      }

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      assert.equal(result.employees, 1);
      assert.deepEqual(result.errors, []);

      const stub = ((await db.execute(sql`
        select id, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { id: string; factors: Record<string, string> }[] }).rows[0]!;

      // WCB: cap binds → assessable 2000 of 2400 gross, premium 2% = 40.00.
      assert.equal(stub.factors.WCB_EARN, "2000.0000");
      assert.equal(stub.factors.WCB, "40.0000");
      // EHT: (2400 − 1000 exemption) × 1.95% = 27.30 on full ON remuneration.
      assert.equal(stub.factors.EHT_EARN, "2400.0000");
      assert.equal(stub.factors.EHT, "27.3000");

      const wcbLines = (await db.execute(sql`
        select amount, project_id from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'WCB/WSIB'
         order by project_id`)) as unknown as { rows: { amount: string; project_id: string | null }[] };
      // Proportional to earnings: each job carried half the gross → 20.00 each.
      assert.equal(wcbLines.rows.length, 2);
      assert.ok(wcbLines.rows.every((l) => l.project_id !== null));
      assert.deepEqual(wcbLines.rows.map((l) => l.amount).sort(), ["20.0000", "20.0000"]);
      assert.equal(sum(wcbLines.rows.map((l) => l.amount)), "40.0000");

      const ehtLines = (await db.execute(sql`
        select amount from pay_stub_lines
         where org_id = ${org.orgId} and stub_id = ${stub.id} and description = 'Employer Health Tax'
      `)) as unknown as { rows: { amount: string }[] };
      assert.equal(ehtLines.rows.length, 1);
      assert.equal(ehtLines.rows[0]!.amount, "27.3000");

      // Commit: balanced projection, WCB/EHT credit their slot accounts.
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
      const lines = (await db.execute(sql`
        select account_id, amount, project_id from document_lines
         where org_id = ${org.orgId} and document_id = ${run.documentId}
      `)) as unknown as { rows: { account_id: string; amount: string; project_id: string | null }[] };
      assert.equal(cmp(sum(lines.rows.map((l) => l.amount)), "0"), 0, "GL projection balances");
      const wcbLeg = lines.rows.filter((l) => l.account_id === wcbPayable);
      assert.equal(sum(wcbLeg.map((l) => l.amount)), neg("40.0000"));
      const ehtLeg = lines.rows.filter((l) => l.account_id === ehtPayable);
      assert.equal(sum(ehtLeg.map((l) => l.amount)), neg("27.3000"));
      // The employer-side burden debits carry the job tags.
      const jobDebits = lines.rows.filter((l) => l.project_id !== null && cmp(l.amount, "0") > 0);
      assert.ok(jobDebits.length >= 2, "job-tagged burden debits exist");

      // A second run consumes the remaining WCB room: only $0 of cap is left
      // (2000 already assessed), so no WCB accrues; EHT keeps accruing with
      // the exemption fully consumed.
      await db.execute(sql`
        insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                                  is_billable, billing_status, costing_basis, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, '2026-07-22', 20, ${jobA}, 'approved', false,
                'unbilled', 'actual', ${actorId}, ${actorId})`);
      const run2 = await createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId });
      await calculatePayRun({ orgId: org.orgId, documentId: run2.documentId, actorId });
      const stub2 = ((await db.execute(sql`
        select factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${run2.documentId}
      `)) as unknown as { rows: { factors: Record<string, string> }[] }).rows[0]!;
      assert.equal(stub2.factors.WCB ?? "0", "0");
      // 600 × 1.95% — exemption already used by the committed run.
      assert.equal(stub2.factors.EHT, "11.7000");
      assert.equal(stub2.factors.EHT_EARN, "600.0000");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
