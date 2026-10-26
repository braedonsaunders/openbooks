import { seedCanadianFilingAccountForTest } from "./filing-test-fixtures.ts";
import { commitPayRun } from "./run-commit.ts";
import { submitBenefitEnrollmentFixture } from "../testing/benefit-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollOrg,
  seedHourlyPayrollEmployee,
} from "../testing/payroll-hourly-fixture.ts";
import { createPayRun, discardPayRun } from "./run-lifecycle.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { mutatePayRunAdjustment } from "./run-adjustments.ts";
import { withdrawUnusedEnrollment } from "../hrm/benefits/enrollments.ts";
import { enableFeatures, grantPermissions } from "../testing/hrm-harness.ts";

test(
  "regular-only benefit premiums exclude supplemental and one-off runs while all-run premiums remain",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedHourlyPayrollOrg();
    try {
      await enableFeatures(fx.orgId, ["payroll", "hrm"]);
      await grantPermissions(fx.orgId, fx.actorId, ["hrm.benefits.manage"]);
      const { partyId, employmentId } = await seedHourlyPayrollEmployee(
        fx,
        "Benefit Premium Employee",
      );
      const filingAccountId = await seedCanadianFilingAccountForTest(fx.orgId, fx.actorId, {
        subsidiaryId: fx.subsidiaryId,
        accountNumber: "123456789RP0001",
        name: "Benefit-premium employer",
        effectiveFrom: "2026-01-01",
        eiEmployerMultiplier: "1.4",
      });
      assert.equal(
        (
          await db.execute(
            sql`update employee_payroll_profiles set filing_account_id=${filingAccountId}
        where org_id=${fx.orgId} and employee_party_id=${partyId} returning employee_party_id`,
            "objects",
          )
        ).length,
        1,
      );
      const base = (
        await db.execute<{ id: string }>(
          sql`select id from pay_components where org_id=${fx.orgId} and system_key='base_pay' and kind='earning'`,
          "objects",
        )
      )[0]!;
      const prior = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-06-28",
        periodEnd: "2026-07-04",
        runType: "regular",
        employeePartyIds: [partyId],
      });
      const priorCommand = { orgId: fx.orgId, actorId: fx.actorId, documentId: prior.documentId };
      await mutatePayRunAdjustment({
        ...priorCommand,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: base.id,
          amount: "1000",
          replaceComponent: true,
        },
      });
      assert.deepEqual((await calculatePayRun(priorCommand)).errors, []);
      await commitPayRun(priorCommand);

      const planId = randomUUID(),
        enrollmentId = randomUUID();
      await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
        values(${planId},${fx.orgId},'PREMIUM','Employer premiums','other','CAD',${fx.subsidiaryId},'2026-01-01')`);
      await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
        values(${enrollmentId},${fx.orgId},${employmentId},${planId},'elected','2026-01-01','CAD')`);
      const ruleIds: string[] = [];
      for (const [code, applicability] of [
        ["REGULAR_PREMIUM", "regular_only"],
        ["ALL_RUN_PREMIUM", "all_pay_runs"],
      ] as const) {
        const componentId = randomUUID(),
          ruleId = randomUUID();
        ruleIds.push(ruleId);
        await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
          tax_treatment,payment_kind,expense_account_id,liability_account_id)
          values(${componentId},${fx.orgId},${code},${code},'employer_contribution','CA',false,false,false,false,
            'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
        await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,
          basis,rate,rate_formula,proration,effective_from,run_applicability)
          values(${ruleId},${fx.orgId},${planId},${code},${code},'employer_contribution',${componentId},
            'per_period',0,'elected_rate','none','2026-01-01',${applicability})`);
        await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,
          effective_from,source_decimal,provenance)
          values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed','10','2026-01-01','10',
            '{"source":"approved employer premium"}'::jsonb)`);
      }
      await submitBenefitEnrollmentFixture(fx.orgId, fx.actorId, enrollmentId);

      for (const runType of ["regular", "supplemental", "bonus", "retro"] as const) {
        const run = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12",
          periodEnd: "2026-07-18",
          runType,
          employeePartyIds: [partyId],
        });
        await mutatePayRunAdjustment({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
          mutation: {
            action: "add",
            employeePartyId: partyId,
            componentId: base.id,
            amount: "1000",
            replaceComponent: true,
          },
        });
        assert.deepEqual(
          (
            await calculatePayRun({
              orgId: fx.orgId,
              actorId: fx.actorId,
              documentId: run.documentId,
            })
          ).errors,
          [],
        );
        const allocations = await db.execute<{ rule_id: string; amount: string }>(
          sql`select rule_id,amount::text
          from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}
          order by rule_id`,
          "objects",
        );
        assert.deepEqual(
          new Map(allocations.map((row) => [row.rule_id, row.amount])),
          new Map(
            (runType === "regular" ? ruleIds : ruleIds.slice(1)).map((id) => [id, "10.0000"]),
          ),
          runType,
        );
        if (runType === "regular") {
          const premium = (
            await db.execute<{ id: string }>(
              sql`select id from pay_components
            where org_id=${fx.orgId} and code='REGULAR_PREMIUM'`,
              "objects",
            )
          )[0]!;
          for (const amount of ["25", "0"]) {
            const replacement = randomUUID();
            await mutatePayRunAdjustment({
              orgId: fx.orgId,
              actorId: fx.actorId,
              documentId: run.documentId,
              reason: "Approved one-off premium replacement",
              mutation: {
                action: "add",
                employeePartyId: partyId,
                componentId: premium.id,
                amount,
                replaceComponent: true,
                idempotencyKey: replacement,
              },
            });
            assert.deepEqual(
              (
                await calculatePayRun({
                  orgId: fx.orgId,
                  actorId: fx.actorId,
                  documentId: run.documentId,
                })
              ).errors,
              [],
            );
            const replacedAllocations = await db.execute<{ rule_id: string; amount: string }>(
              sql`select rule_id,amount::text
              from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
              "objects",
            );
            assert.deepEqual(
              new Map(replacedAllocations.map((row) => [row.rule_id, row.amount])),
              new Map([[ruleIds[1], "10.0000"]]),
            );
            const premiumTotal = (
              await db.execute<{ amount: string }>(
                sql`select coalesce(sum(l.amount),0)::text as amount
              from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
              where l.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${premium.id}`,
                "objects",
              )
            )[0]!;
            assert.equal(cmp(premiumTotal.amount, amount), 0);
            await mutatePayRunAdjustment({
              orgId: fx.orgId,
              actorId: fx.actorId,
              documentId: run.documentId,
              mutation: { action: "delete", adjustmentId: replacement },
            });
          }
          assert.deepEqual(
            (
              await calculatePayRun({
                orgId: fx.orgId,
                actorId: fx.actorId,
                documentId: run.documentId,
              })
            ).errors,
            [],
          );
          const restoredAllocations = await db.execute<{ rule_id: string; amount: string }>(
            sql`select rule_id,amount::text
            from pay_run_benefit_allocations where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          );
          assert.deepEqual(
            new Map(restoredAllocations.map((row) => [row.rule_id, row.amount])),
            new Map(ruleIds.map((id) => [id, "10.0000"])),
          );
        }
        await assert.rejects(
          withdrawUnusedEnrollment({
            orgId: fx.orgId,
            actorId: fx.actorId,
            enrollmentId,
            reason: "Contribution basis correction",
          }),
          /payroll allocation history/,
        );
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from hrm_benefit_enrollments
          where org_id=${fx.orgId} and id=${enrollmentId}`,
              "objects",
            )
          )[0]!.status,
          "active",
        );
        await discardPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      }
      assert.equal(
        (
          await withdrawUnusedEnrollment({
            orgId: fx.orgId,
            actorId: fx.actorId,
            enrollmentId,
            reason: "Unused contribution basis correction",
          })
        ).status,
        "cancelled",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
