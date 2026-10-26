import { submitBenefitEnrollmentFixture } from "../testing/benefit-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
} from "../testing/payroll-hourly-fixture.ts";
import { createPayRun, discardPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import type { PayRunCalculationSourceSnapshot } from "./run-calculation-evidence.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

test(
  "a recurring earning changes vacation bases at pay date while retaining native benefit pricing and replay",
  { skip },
  async () => {
    const f = await seedHourlyPayrollOrg();
    try {
      const { partyId, employmentId } = await seedHourlyPayrollEmployee(
        f,
        "Dated vacation employee",
      );
      const componentId = randomUUID(),
        beforeId = randomUUID(),
        afterId = randomUUID();
      // The creation default is deliberately different from the later policy.
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,payment_kind,vacationable,
      expense_account_id,liability_account_id,created_by,updated_by)
      values(${componentId},${f.orgId},'PREMIUM','Hourly premium','earning','CA','cash',false,
        ${f.accounts.wageExpense},${f.accounts.otherPayable},${f.actorId},${f.actorId})`);
      await db.execute(sql`insert into pay_component_statutory_treatments
      (id,org_id,pay_component_id,effective_from,effective_to,program_exclusions,vacationable)
      values(${beforeId},${f.orgId},${componentId},'2026-01-01','2026-02-28',array['wcb'],false),
        (${afterId},${f.orgId},${componentId},'2026-03-01',null,array['wcb'],true)`);
      const planId = randomUUID(),
        enrollmentId = randomUUID(),
        ruleId = randomUUID();
      await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${planId},${f.orgId},'PREMIUM_PLAN','Hourly premium','retirement','CAD',${f.subsidiaryId},'2026-01-01')`);
      await db.execute(sql`insert into hrm_benefit_contribution_rules
      (id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,proration,effective_from,run_applicability)
      values(${ruleId},${f.orgId},${planId},'PREMIUM','Hourly premium','cash_earning',${componentId},'per_hour','5',
        'elected_rate','all_paid','none','2026-01-01','all_pay_runs')`);
      await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${f.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
      await db.execute(sql`insert into hrm_benefit_enrollment_terms
      (id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
      values(${randomUUID()},${f.orgId},${enrollmentId},${ruleId},'fixed','5','2026-01-01','5',
        '{"source":"approved hourly premium election"}'::jsonb)`);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,hrm}','true'::jsonb,true) where id=${f.orgId}`,
      );
      await submitBenefitEnrollmentFixture(f.orgId, f.actorId, enrollmentId);
      const baseId = (
        await db.execute<{ id: string }>(
          sql`select id from pay_components
      where org_id=${f.orgId} and system_key='base_pay' and kind='earning'`,
          "objects",
        )
      )[0]!.id;
      const vacationPlan = (
        await db.execute<{ payout_component_id: string }>(
          sql`select payout_component_id from entitlement_plans
      where org_id=${f.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      const periodStart = "2026-02-15",
        periodEnd = "2026-02-21";
      for (const [payDate, treatmentId, included, vacation] of [
        ["2026-02-28", beforeId, false, "40.0000"],
        ["2026-03-07", afterId, true, "44.0000"],
      ] as const) {
        // Identical earning dates demonstrate that pay date owns the policy.
        const run = await createPayRun({
          orgId: f.orgId,
          actorId: f.actorId,
          payScheduleId: f.scheduleId,
          periodStart,
          periodEnd,
          payDate,
          runType: "supplemental",
          employeePartyIds: [partyId],
        });
        const command = { orgId: f.orgId, actorId: f.actorId, documentId: run.documentId };
        await mutatePayRunAdjustment({
          ...command,
          mutation: {
            action: "add",
            employeePartyId: partyId,
            componentId: baseId,
            amount: "1000",
            hours: "20",
            replaceComponent: true,
          },
        });
        for (let pass = 0; pass < 2; pass++) {
          assert.deepEqual((await calculatePayRun(command)).errors, []);
          const stub = (
            await db.execute<{
              gross: string;
              vacation: string;
              source: PayRunCalculationSourceSnapshot;
            }>(
              sql`
          select s.gross::text,s.vacation_accrued::text as vacation,r.calculation_source_snapshot as source
          from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
          where s.org_id=${f.orgId} and s.pay_run_document_id=${run.documentId}`,
              "objects",
            )
          )[0]!;
          assert.equal(stub.gross, "1100.0000");
          assert.equal(stub.vacation, vacation);
          const consumed = stub.source.payComponentStatutoryTreatments!.find(
            (row) => row.componentId === componentId,
          )!;
          assert.equal(consumed.id, treatmentId);
          assert.equal(consumed.vacationable, included);
          assert.deepEqual(consumed.programExclusions, ["wcb"]);
          const allocations = await db.execute<{
            amount: string;
            snapshot: {
              basis: { hours: string };
              statutoryTreatment: { id: string; vacationable: boolean };
            };
          }>(
            sql`
          select amount::text,source_snapshot as snapshot from pay_run_benefit_allocations
          where org_id=${f.orgId} and pay_run_document_id=${run.documentId} and rule_id=${ruleId}`,
            "objects",
          );
          assert.equal(allocations.length, 1);
          assert.equal(allocations[0]!.amount, "100.0000");
          assert.equal(allocations[0]!.snapshot.basis.hours, "20.0000");
          assert.equal(allocations[0]!.snapshot.statutoryTreatment.id, treatmentId);
        }
        // Cash payment uses the same policy and exact earning base as accrual.
        await db.execute(sql`update payroll_vacation_terms set method='pay_each_period',updated_by=${f.actorId},updated_at=now()
        where org_id=${f.orgId} and employment_id=${employmentId}`);
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        const cash = await db.execute<{ amount: string }>(
          sql`select l.amount::text from pay_stub_lines l
        join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id where s.org_id=${f.orgId}
          and s.pay_run_document_id=${run.documentId} and l.component_id=${vacationPlan.payout_component_id}`,
          "objects",
        );
        assert.deepEqual(cash, [{ amount: vacation }]);
        await db.execute(sql`update payroll_vacation_terms set method='accrue',updated_by=${f.actorId},updated_at=now()
        where org_id=${f.orgId} and employment_id=${employmentId}`);
        assert.deepEqual((await calculatePayRun(command)).errors, []);
        if (included) {
          await db.execute(sql`update pay_component_statutory_treatments set vacationable=false
          where org_id=${f.orgId} and id=${treatmentId}`);
          await assert.rejects(commitPayRun(command), /recalculate|changed|stale/i);
        } else {
          await discardPayRun({
            ...command,
            reason: "Complete the earlier pay-date calculation comparison",
          });
        }
      }
    } finally {
      await dropScratchOrgReporting(f.orgId);
    }
  },
);
