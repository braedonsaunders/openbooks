import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, sum } from "../money/money.ts";
import {
  createRetroPayRun,
  proposeRetroPay,
  quantifyRetroCandidates,
  retroRunFindings,
  retroRunReview,
} from "./retro-store.ts";
import { payRunReadiness } from "./readiness.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { acknowledgePayRunRefusals, commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The real scenario, end to end, with the money hand-computed.
 *
 * Three biweekly periods are paid at $30.00/h — 60 hours on job A and 20 on job
 * B every period. In August a wage row of $33.00/h effective the previous
 * 1 January is entered, backdating the increase over all three. The difference
 * is $3.00 × 80 h = $240.00 a period, $720.00 in total, and it belongs to the
 * jobs in the proportions the ORIGINAL hours had: $180.00 to job A and $60.00
 * to job B, every period.
 *
 * The test asserts that number to the penny in four places — the proposal, the
 * settlement rows, the retro stub, and the per-project stub lines — and then
 * asserts that running detection again finds nothing.
 */
test(
  "retro pay: backdated increase over three committed periods, to the penny, exactly once",
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
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const jobA = randomUUID();
      const jobB = randomUUID();
      for (const [id, code, name] of [[jobA, "JOB-A", "Job A"], [jobB, "JOB-B", "Job B"]] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
          values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${name}, 'active', true, '{}'::jsonb)`);
      }

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Robin Field', true, '{}'::jsonb)`);
      // The wage in force when the three periods were paid.
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2025-06-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);

      // Three committed periods, 60 h on job A and 20 h on job B in each.
      const periods = [
        { start: "2026-01-05", end: "2026-01-18", pay: "2026-01-21", days: ["2026-01-06", "2026-01-13"] },
        { start: "2026-01-19", end: "2026-02-01", pay: "2026-02-04", days: ["2026-01-20", "2026-01-27"] },
        { start: "2026-02-02", end: "2026-02-15", pay: "2026-02-18", days: ["2026-02-03", "2026-02-10"] },
      ];
      const sourceRuns: string[] = [];
      for (const period of periods) {
        for (const day of period.days) {
          for (const [projectId, hours] of [[jobA, 30], [jobB, 10]] as const) {
            await db.execute(sql`
              insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                                        status, is_billable, billing_status, costing_basis,
                                        created_by, updated_by)
              values (${org.orgId}, ${employeeId}, ${day}, ${hours}, ${projectId}, 'approved',
                      false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
          }
        }
        const run = await createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: period.start, periodEnd: period.end, payDate: period.pay,
        });
        const calculated = await calculatePayRun({
          orgId: org.orgId, documentId: run.documentId, actorId,
        });
        assert.deepEqual(calculated.errors, [], `${period.start} calculated cleanly`);
        assert.equal(calculated.gross, "2400.0000", "80 h × $30.00");
        await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
        sourceRuns.push(run.documentId);
      }

      // Nothing has changed yet: detection must find nothing at all.
      const quiet = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(quiet.periods.length, 0, "an unchanged payroll owes no retro");

      // ---- The union settles: $33.00/h, effective the previous 1 January ----
      // Exactly how an operator enters a backdated raise: close the row that
      // was in force and open the new one behind it. `labor_cost_rates` is the
      // ONE home for a wage, and its overlap guard requires the pair.
      await db.execute(sql`
        update labor_cost_rates set effective_to = '2025-12-31', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2025-06-01'`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '33', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);

      // ---- Detect + quantify ------------------------------------------------
      const proposal = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(proposal.taxYear, 2026);
      assert.equal(proposal.periods.length, 3, "all three paid periods are affected");
      assert.deepEqual(
        proposal.periods.filter((p) => p.outcome === "unavailable").map((p) => p.blockedReason),
        [],
        "every affected period could be recalculated",
      );
      assert.equal(proposal.payableTotal, "720.0000", "3 periods × 80 h × $3.00");
      assert.equal(proposal.overpaidTotal, "0.0000");
      for (const period of proposal.periods) {
        assert.equal(period.outcome, "payable");
        assert.equal(period.difference!.originalEarnings, "2400.0000");
        assert.equal(period.difference!.recomputedEarnings, "2640.0000");
        assert.equal(period.difference!.delta, "240.0000");
        assert.ok(
          period.candidate.reasons.some((reason) => reason.source === "wage_rate"),
          "the wage row is named as the reason",
        );
        // The increase lands on the jobs in the proportions the hours had.
        const byProject = new Map(period.difference!.buckets.map((b) => [b.projectId, b.amount]));
        assert.equal(byProject.get(jobA), "180.0000", "60 h × $3.00 to job A");
        assert.equal(byProject.get(jobB), "60.0000", "20 h × $3.00 to job B");
      }

      // The simulation is rolled back: the committed stubs are untouched.
      const untouched = (await db.execute<{ gross: string }>(sql`
        select gross from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${sourceRuns[0]}
      `));
      assert.equal(untouched.rows[0]!.gross, "2400.0000", "recalculating a paid period changes nothing");

      // ---- Pay ---------------------------------------------------------------
      const retro = await createRetroPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(retro.settlements, 3);
      assert.equal(retro.employees, 1);
      assert.equal(retro.total, "720.0000");

      // A second proposal while that run is still open (a double-click, a
      // second operator) must not mint a second run holding the same cells.
      await assert.rejects(
        createRetroPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
        }),
        /already settles Robin Field's period\(s\) and has not been committed/,
      );

      const review = await retroRunReview(org.orgId, retro.documentId);
      assert.equal(review.total, "720.0000");
      assert.equal(review.settlements.length, 3);
      assert.deepEqual(review.employees.map((e) => [e.employeeName, e.payable]), [
        ["Robin Field", "720.0000"],
      ]);
      // Old, new and delta are all on the row an operator reads.
      assert.deepEqual(
        review.settlements.map((s) => [s.originalEarnings, s.recomputedEarnings, s.delta]),
        [
          ["2400.0000", "2640.0000", "240.0000"],
          ["2400.0000", "2640.0000", "240.0000"],
          ["2400.0000", "2640.0000", "240.0000"],
        ],
      );

      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);

      // The settlement is quantified before the retro run exists. Editing a
      // source hour after that point must block the run: paying the stored
      // allocation would otherwise settle a number the source no longer
      // supports. Restore the exact source value/timestamp so the later
      // correction below can exercise the normal exactly-once path.
      await db.execute(sql`
        update time_entries
           set hours = hours + 1, updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and worked_on = '2026-01-06' and project_id = ${jobA}
           and payroll_batch_ref = ${sourceRuns[0]}`);
      const staleAfterTimeEdit = await retroRunFindings(org.orgId, retro.documentId);
      const staleTimeFinding = staleAfterTimeEdit.find((finding) => finding.code === "retro.stale");
      assert.ok(staleTimeFinding, "editing source time after quantification blocks the retro run");
      assert.equal(staleTimeFinding!.severity, "blocker");
      await db.execute(sql`
        update time_entries t
           set hours = '30', updated_at = st.quantified_at
          from payroll_retro_settlements st
         where st.org_id = ${org.orgId}
           and st.retro_pay_run_document_id = ${retro.documentId}
           and st.source_pay_run_document_id = ${sourceRuns[0]}
           and t.org_id = st.org_id and t.employee_party_id = st.employee_party_id
           and t.worked_on = '2026-01-06' and t.project_id = ${jobA}
           and t.payroll_batch_ref = st.source_pay_run_document_id::text`);
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);

      // Vacation accrual follows the COMPONENT's own vacationable flag, not a
      // retro-specific rule. Turned off, the retro accrues nothing.
      await db.execute(sql`
        update pay_components set vacationable = false
         where org_id = ${org.orgId} and system_key = 'base_pay'`);
      await calculatePayRun({ orgId: org.orgId, documentId: retro.documentId, actorId });
      const noVacation = (await db.execute<{ vacation_accrued: string }>(sql`
        select vacation_accrued from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${retro.documentId}
      `));
      assert.equal(noVacation.rows[0]!.vacation_accrued, "0.0000");
      await db.execute(sql`
        update pay_components set vacationable = true
         where org_id = ${org.orgId} and system_key = 'base_pay'`);

      const calculated = await calculatePayRun({
        orgId: org.orgId, documentId: retro.documentId, actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "720.0000", "the retro cheque IS the difference");

      const stub = (await db.execute<{ gross: string; vacation_accrued: string; factors: Record<string, string> }>(sql`
        select gross, vacation_accrued, factors from pay_stubs
         where org_id = ${org.orgId} and pay_run_document_id = ${retro.documentId}
      `));
      assert.equal(stub.rows[0]!.gross, "720.0000");
      assert.equal(stub.rows[0]!.vacation_accrued, "28.8000", "4% of $720.00");
      // The CA pack declares retroactive pay non-periodic (T4127 Method 2), so
      // the whole amount arrives as factor B — the bonus path — rather than
      // being annualized as period income.
      assert.equal(stub.rows[0]!.factors.B, "720.0000");
      assert.equal(stub.rows[0]!.factors.I, "0.0000");

      // Job costing: the retro earning lines carry the projects.
      const stubLines = (await db.execute<{ project_id: string | null; amount: string; hours: string | null; description: string }>(sql`
        select l.project_id, l.amount, l.hours, l.description
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id
         where l.org_id = ${org.orgId} and s.pay_run_document_id = ${retro.documentId}
           and l.kind = 'earning'
      `));
      assert.equal(stubLines.rows.length, 6, "two jobs × three periods");
      const jobATotal = sum(stubLines.rows.filter((l) => l.project_id === jobA).map((l) => l.amount));
      const jobBTotal = sum(stubLines.rows.filter((l) => l.project_id === jobB).map((l) => l.amount));
      assert.equal(jobATotal, "540.0000", "3 × 60 h × $3.00");
      assert.equal(jobBTotal, "180.0000", "3 × 20 h × $3.00");
      assert.ok(
        stubLines.rows.every((l) => l.hours === null),
        "no hours on a retro line: the source periods already paid every per-hour component",
      );
      assert.ok(
        stubLines.rows.every((l) => /retro 2026-/.test(l.description)),
        "each line names the period it makes good",
      );

      // The retro control set is ENFORCED at commit, not merely displayed: a
      // competing open retro run holding one of this run's cells (the state a
      // creator that bypassed the fence above would leave) blocks the commit
      // and shows in the pre-flight until it is resolved.
      const competitor = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-01-05", periodEnd: "2026-01-18", payDate: "2026-08-21",
        runType: "retro", employeePartyIds: [employeeId],
      });
      await db.execute(sql`
        insert into payroll_retro_settlements
          (org_id, retro_pay_run_document_id, employee_party_id, source_pay_run_document_id,
           source_period_start, source_period_end, source_pay_date, source_tax_year,
           original_earnings, recomputed_earnings, previously_settled, delta, reasons,
           created_by, updated_by)
        select org_id, ${competitor.documentId}, employee_party_id, source_pay_run_document_id,
               source_period_start, source_period_end, source_pay_date, source_tax_year,
               original_earnings, recomputed_earnings, previously_settled, delta, reasons,
               created_by, updated_by
          from payroll_retro_settlements
         where org_id = ${org.orgId} and retro_pay_run_document_id = ${retro.documentId}
           and source_pay_run_document_id = ${sourceRuns[0]}`);
      const preflight = await payRunReadiness(org.orgId, retro.documentId);
      assert.ok(
        preflight.items.some((item) => item.code === "retro.doubleSettled" && item.severity === "blocker"),
        "the pre-flight shows the competing open run",
      );
      await assert.rejects(
        commitPayRun({ orgId: org.orgId, documentId: retro.documentId, actorId }),
        /retro run cannot be committed \(retro\.doubleSettled\)/,
      );
      await db.execute(sql`
        update pay_runs set run_status = 'voided', updated_at = now()
         where org_id = ${org.orgId} and document_id = ${competitor.documentId}`);
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);
      // The voided competitor changed another run for these employees after
      // this run was calculated; recalculate through the ordinary gate.
      await calculatePayRun({ orgId: org.orgId, documentId: retro.documentId, actorId });

      await commitPayRun({ orgId: org.orgId, documentId: retro.documentId, actorId });
      const legs = (await db.execute<{ amount: string; project_id: string | null }>(sql`
        select amount, project_id from document_lines
         where org_id = ${org.orgId} and document_id = ${retro.documentId}
      `));
      assert.equal(cmp(sum(legs.rows.map((l) => l.amount)), "0"), 0, "the GL projection balances");
      assert.equal(
        sum(legs.rows.filter((l) => l.project_id === jobA).map((l) => l.amount)),
        "540.0000",
        "job A's ledger carries its share of the retro wage",
      );

      // ---- Exactly once -------------------------------------------------------
      const after = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(after.payableTotal, "0.0000", "the same difference is never owed twice");
      assert.equal(after.overpaidTotal, "0.0000");
      assert.ok(
        after.periods.every((period) => period.outcome === "none"),
        "every period differences to zero once it has been settled",
      );
      await assert.rejects(
        createRetroPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
        }),
        /nothing to pay retroactively/,
      );

      // ---- A second, later correction is still payable ------------------------
      // The settlement is corrected to $34.00/h over the same window. Only the
      // further $1.00/h is owed: an "already settled" flag would have refused
      // this outright, and re-detecting from scratch would pay the $3.00 again.
      await db.execute(sql`
        update labor_cost_rates set rate = '34', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      const corrected = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(corrected.payableTotal, "240.0000", "3 periods × 80 h × the further $1.00");
      assert.equal(corrected.periods.length, 3, "three committed periods share the correction");
      for (const period of corrected.periods) {
        assert.equal(period.difference!.previouslySettled, "240.0000");
        assert.equal(period.difference!.recomputedEarnings, "2720.0000");
        assert.equal(period.difference!.delta, "80.0000");
      }
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "retro readiness ignores a later raise that still covers the settled period",
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
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const jobA = randomUUID();
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
        values (${jobA}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-A', 'Job A', 'active', true, '{}'::jsonb)`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Robin Field', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2025-06-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);

      // One committed period: 30 h on job A at $30.00/h = $900.00.
      for (const [day, hours] of [["2026-01-06", 20], ["2026-01-13", 10]] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                                    status, is_billable, billing_status, costing_basis,
                                    created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${day}, ${hours}, ${jobA}, 'approved',
                  false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
      }
      const source = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-01-05", periodEnd: "2026-01-18", payDate: "2026-01-21",
      });
      const calculated = await calculatePayRun({
        orgId: org.orgId, documentId: source.documentId, actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "900.0000", "30 h x $30.00");
      await commitPayRun({ orgId: org.orgId, documentId: source.documentId, actorId });

      // The January raise that nominates the period: $33.00/h effective
      // 1 January, entered the operator's way.
      await db.execute(sql`
        update labor_cost_rates set effective_to = '2025-12-31', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2025-06-01'`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '33', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);
      const proposal = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(proposal.periods.length, 1);
      assert.equal(proposal.periods[0]!.difference!.recomputedEarnings, "990.0000");
      assert.equal(proposal.periods[0]!.difference!.delta, "90.0000");
      const retro = await createRetroPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(retro.total, "90.0000");
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);

      // A new row effective inside the settled period blocks: the product's
      // own overlap guard forces the old row to be capped before it (here to
      // 9 January), so January would recalculate against the $99.00 row.
      // Undoing both heals.
      await db.execute(sql`
        update labor_cost_rates set effective_to = '2026-01-09', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '99', 'hour', '2026-01-10', true,
                ${actorId}, ${actorId})`);
      assert.ok(
        (await retroRunFindings(org.orgId, retro.documentId))
          .some((finding) => finding.code === "retro.stale"),
        "a new row effective inside the settled period still blocks the run",
      );
      await db.execute(sql`
        delete from labor_cost_rates
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-10'`);
      await db.execute(sql`
        update labor_cost_rates set effective_to = null, updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);

      // Months later a routine October raise closes the $33.00 row at
      // 30 September and opens $36.00 — exactly what the product's own
      // save-rate does. The January row still covers January in full, so
      // re-running January prices the same $990.00: the settlement is not
      // stale and the open retro run must stay payable.
      await db.execute(sql`
        update labor_cost_rates set effective_to = '2026-09-30', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '36', 'hour', '2026-10-01', true,
                ${actorId}, ${actorId})`);
      assert.deepEqual(
        await retroRunFindings(org.orgId, retro.documentId),
        [],
        "capping the governing row after the settled period ends changes no January number",
      );

      // The arm still bites on changes that DO move January money. A
      // backdated rate correction to the governing row blocks ...
      await db.execute(sql`
        update labor_cost_rates set rate = '34', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      const staleAfterRateEdit = await retroRunFindings(org.orgId, retro.documentId);
      assert.ok(
        staleAfterRateEdit.some((finding) => finding.code === "retro.stale"),
        "a backdated rate change to the governing row still blocks the run",
      );
      // ... while restoring the exact quantified value heals it again.
      await db.execute(sql`
        update labor_cost_rates set rate = '33', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);

      // Deactivating the governing row blocks (January would recalculate
      // against a different row), and reactivating heals.
      await db.execute(sql`
        update labor_cost_rates set is_active = false, updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      assert.ok(
        (await retroRunFindings(org.orgId, retro.documentId))
          .some((finding) => finding.code === "retro.stale"),
        "deactivating the governing row still blocks the run",
      );
      await db.execute(sql`
        update labor_cost_rates set is_active = true, updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2026-01-01'`);
      assert.deepEqual(await retroRunFindings(org.orgId, retro.documentId), []);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "retro readiness ignores a time correction made before quantification",
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
      const vacationPayable = await account("2320", "Vacation payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            burdenExpenseAccountId: burdenExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            vacationPayableAccountId: vacationPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");

      const jobA = randomUUID();
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
        values (${jobA}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-A', 'Job A', 'active', true, '{}'::jsonb)`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'person', 'Robin Field', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2025-06-01', true,
                ${actorId}, ${actorId})`);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
                ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country, province,
                                               pay_basis, federal_claim_code, provincial_claim_code,
                                               vacation_percent, vacation_method, is_active,
                                               created_by, updated_by)
        values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', 'hourly', 1, 1,
                '4', 'accrue', true, ${actorId}, ${actorId})`);

      // One committed period: 20 h + 10 h on job A at $30.00/h = $900.00.
      for (const [day, hours] of [["2026-01-06", 20], ["2026-01-13", 10]] as const) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id,
                                    status, is_billable, billing_status, costing_basis,
                                    created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${day}, ${hours}, ${jobA}, 'approved',
                  false, 'unbilled', 'actual', ${actorId}, ${actorId})`);
      }
      const source = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-01-05", periodEnd: "2026-01-18", payDate: "2026-01-21",
      });
      const calculated = await calculatePayRun({
        orgId: org.orgId, documentId: source.documentId, actorId,
      });
      assert.deepEqual(calculated.errors, []);
      assert.equal(calculated.gross, "900.0000", "30 h x $30.00");
      await commitPayRun({ orgId: org.orgId, documentId: source.documentId, actorId });

      // A late correction arrives BEFORE quantification: the 6 January sheet
      // understated the day by one hour (20 h -> 21 h). The source run's own
      // snapshot still shows 20 h; the quantification below will see 21 h.
      await db.execute(sql`
        update time_entries
           set hours = '21', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and worked_on = '2026-01-06' and project_id = ${jobA}
           and payroll_batch_ref = ${source.documentId}`);
      // The raise that nominates the period for retro: $33.00/h effective
      // 1 January, entered the operator's way (close the old row, open the
      // new one behind it).
      await db.execute(sql`
        update labor_cost_rates set effective_to = '2025-12-31', updated_at = now()
         where org_id = ${org.orgId} and employee_party_id = ${employeeId}
           and effective_from = '2025-06-01'`);
      await db.execute(sql`
        insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis,
                                      effective_from, is_active, created_by, updated_by)
        values (${org.orgId}, ${employeeId}, 'CAD', '33', 'hour', '2026-01-01', true,
                ${actorId}, ${actorId})`);

      // Quantification re-runs the period on today's inputs: 31 h x $33.00.
      const proposal = await proposeRetroPay({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(proposal.periods.length, 1);
      assert.equal(proposal.periods[0]!.difference!.originalEarnings, "900.0000");
      assert.equal(proposal.periods[0]!.difference!.recomputedEarnings, "1023.0000");
      assert.equal(proposal.periods[0]!.difference!.delta, "123.0000");

      const retro = await createRetroPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
      });
      assert.equal(retro.total, "123.0000");

      // The corrected hour is already inside the settlement's recomputed
      // numbers, so readiness must NOT cry stale: the run is payable as
      // quantified and there is nothing newer to review.
      assert.deepEqual(
        await retroRunFindings(org.orgId, retro.documentId),
        [],
        "a correction that predates quantification is priced in, not stale",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "retro pay refuses what it cannot evidence: unscoped runs, empty proposals, overpayments",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await seedPayrollComponents(org.orgId, actorId, "CA");
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-01-18', 3, true,
                ${actorId}, ${actorId})`);

      // A retro run may never be opened against a whole schedule.
      await assert.rejects(
        createPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId,
          periodStart: "2026-01-05", periodEnd: "2026-01-18", payDate: "2026-08-20",
          runType: "retro",
        }),
        /must name the employees it pays/,
      );

      // With nothing paid at all there is nothing to make good.
      await assert.rejects(
        createRetroPayRun({
          orgId: org.orgId, actorId, payScheduleId: scheduleId, payDate: "2026-08-20",
        }),
        /nothing to pay retroactively/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "two same-named employees each get their own blocked reason, never each other's",
  { skip: !DB },
  async () => {
    // The display-name defect: the blocked reason was matched with
    // errors.find(e => e.employee === candidate.employeeName), so with two
    // employees sharing a name one failure text attached to both candidates,
    // even though the recomputed map one line above is keyed by party id.
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
      const netPayable = await account("2300", "Wages payable", "liability_current");
      const craPayable = await account("2310", "CRA remittances payable", "liability_current");
      await db.execute(sql`
        update orgs set settings = settings || ${JSON.stringify({
          payroll: {
            wageExpenseAccountId: wageExpense,
            netPayAccountId: netPayable,
            cppPayableAccountId: craPayable,
            eiPayableAccountId: craPayable,
            taxPayableAccountId: craPayable,
            wagesTo: "expense",
          },
        })}::jsonb where id = ${org.orgId}`);
      await seedPayrollComponents(org.orgId, actorId, "CA");
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
                ${actorId}, ${actorId})`);
      const addEmployee = async (payBasis: string, rateBasis: string | null) => {
        const employeeId = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom)
          values (${employeeId}, ${org.orgId}, 'person', 'Sam Same', true, '{}'::jsonb)`);
        if (rateBasis) {
          await db.execute(sql`
            insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                          is_active, created_by, updated_by)
            values (${org.orgId}, ${employeeId}, 'CAD', '30', ${rateBasis}, '2026-01-01', true,
                    ${actorId}, ${actorId})`);
        }
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, country,
                                                 province, pay_basis, federal_claim_code,
                                                 provincial_claim_code, vacation_method, is_active,
                                                 created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${scheduleId}, 'CA', 'ON', ${payBasis}, 1, 1,
                  'accrue', true, ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, '2026-07-06', '8', 'approved', false,
                  'unbilled', 'actual', ${actorId}, ${actorId})`);
        return employeeId;
      };
      // Same display name, different failure modes: hourly loses its rate
      // after the commit; salary holds a rate row on the wrong basis, so the
      // re-simulation refuses it for the missing ANNUAL rate instead. (A
      // salary employee with no rate row at all would fail with the same
      // "no labor cost rate" text as hourly — identical messages cannot prove
      // the reasons are matched by identity rather than by name.)
      const hourlyId = await addEmployee("hourly", "hour");
      const salaryId = await addEmployee("salary", "hour");

      const run = await createPayRun({
        orgId: org.orgId, actorId, payScheduleId: scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const calculated = await calculatePayRun({
        orgId: org.orgId, documentId: run.documentId, actorId,
      });
      assert.equal(calculated.employees, 1);
      assert.equal(calculated.errors.length, 1);
      await acknowledgePayRunRefusals({ orgId: org.orgId, documentId: run.documentId, actorId });
      await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });

      // The hourly employee's rate disappears after the commit, so the
      // re-simulation refuses them too — for a different reason.
      await db.execute(sql`
        delete from labor_cost_rates where org_id = ${org.orgId} and employee_party_id = ${hourlyId}`);

      const candidate = (employeePartyId: string) => ({
        employeePartyId,
        employeeName: "Sam Same",
        sourcePayRunDocumentId: run.documentId,
        sourceDocumentNumber: run.documentNumber,
        payScheduleId: scheduleId,
        payScheduleName: "Biweekly",
        periodStart: "2026-07-05",
        periodEnd: "2026-07-18",
        payDate: "2026-07-21",
        taxYear: 2026,
        reasons: [{ source: "wage_rate" as const, detail: "rate changed after the period was paid" }],
      });
      const periods = await quantifyRetroCandidates({
        orgId: org.orgId, actorId,
        candidates: [candidate(hourlyId), candidate(salaryId)],
      });
      assert.equal(periods.length, 2);
      const byEmployee = new Map(periods.map((period) => [period.candidate.employeePartyId, period]));
      const hourly = byEmployee.get(hourlyId)!;
      const salary = byEmployee.get(salaryId)!;
      assert.equal(hourly.outcome, "unavailable");
      assert.equal(salary.outcome, "unavailable");
      // Each carries their OWN failure text — never each other's. Matching by
      // name attached the first same-named error to both candidates.
      assert.notEqual(hourly.blockedReason, salary.blockedReason);
      assert.match(hourly.blockedReason ?? "", /no labor cost rate covers this employee/);
      assert.match(salary.blockedReason ?? "", /no annual labor cost rate/);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
