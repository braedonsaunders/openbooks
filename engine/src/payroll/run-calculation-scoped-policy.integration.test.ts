import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { seedGbLevyAllowanceFixture, seedHiredEmployee } from "./filing-test-fixtures.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import {
  payrollCalculationPolicyForPayRun,
  payrollSettings,
  seedPayrollComponents,
  statutoryHolidayPayEnabled,
} from "./run-setup.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedScopedPayroll(country: "GB" | "IE") {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const childId = randomUUID();
  const currency = country === "GB" ? "GBP" : "EUR";
  const deductionsId = await seedPostingAccount(
    org.orgId,
    "2110",
    "Payroll deductions",
    "liability_current_other",
  );
  const wageId = await seedPostingAccount(org.orgId, "6000", "Wages", "expense");
  const netId = await seedPostingAccount(
    org.orgId,
    "2300",
    "Employee payable",
    "liability_current_other",
  );
  assert.equal(
    (
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
    values(${childId},${org.orgId},${org.subsidiaryId},'Payroll entity',${currency},${country}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await db.execute(
        sql`update orgs set settings=settings || ${JSON.stringify({
          features: { payroll: true },
          payroll: {
            wageExpenseAccountId: wageId,
            netPayAccountId: netId,
            countries: [country],
            supplementalTaxMethod: "per_run",
          },
          controlAccounts: { payrollDeductions: deductionsId },
        })}::jsonb where id=${org.orgId} returning id`,
        "objects",
      )
    ).length,
    1,
  );
  await seedPayrollComponents(org.orgId, actorId, country);
  if (country === "GB") {
    await seedGbLevyAllowanceFixture(org.orgId, actorId, childId);
    assert.equal(
      (
        await db.execute(
          sql`update pay_components set liability_account_id=null
      where org_id=${org.orgId} and country='GB' and system_key in ('student_loan','postgraduate_loan') returning id`,
          "objects",
        )
      ).length,
      2,
    );
  }
  const scheduleId = randomUUID();
  assert.equal(
    (
      await db.execute(
        sql`insert into pay_schedules
    (id,org_id,name,frequency,periods_per_year,anchor_period_end,pay_date_offset_days,subsidiary_id,is_active,created_by,updated_by)
    values(${scheduleId},${org.orgId},'Monthly payroll','monthly',12,'2026-07-31',0,${childId},true,${actorId},${actorId}) returning id`,
        "objects",
      )
    ).length,
    1,
  );
  const { employeeId } = await seedHiredEmployee(org.orgId, actorId, {
    scheduleId,
    subsidiaryId: childId,
    partySubsidiaryId: childId,
    country,
    name: "Child employee",
    province: country === "GB" ? "ENG" : "IE",
    payBasis: "salary",
    currency,
    rate: "60000",
    rateBasis: "year",
    annualHours: "2080",
  });
  const certificates: Record<string, Record<string, string>> = country === "GB"
    ? {
        gb_nic_category: { category_letter: "A", director_status: "not_director" },
        gb_tax_code_notice: { tax_code: "1257L" },
        gb_starter_checklist: {
          starter_declaration: "A",
          student_loan_plan: "none",
          student_loan_postgraduate: "false",
        },
        gb_workplace_pension: {
          age_band: "22_to_state_pension_age",
          worker_status: "noneligible_jobholder",
          enrolment_status: "not_enrolled",
        },
        gb_workplace_pension_assessment: {
          age_band: "22_to_state_pension_age",
          membership_status: "not_eligible",
          scheme_basis: "not_applicable",
          deduction_method: "not_applicable",
        },
      }
    : {
        ie_rpn: {
          tax_credits_total: "4000",
          rate_band_total: "44000",
          usc_cutoff_total: "70044",
          pay_basis: "week1",
        },
        ie_prsi_class: { prsi_class: "A" },
      };
  for (const [key, answers] of Object.entries(certificates)) {
    assert.equal(
      (
        await db.execute(
          sql`insert into employee_tax_certificates
      (org_id,employee_party_id,country,certificate_key,region,sub_region,answers,effective_from,created_by,updated_by)
      values(${org.orgId},${employeeId},${country},${key},null,null,${JSON.stringify(answers)}::jsonb,
        ${country === "GB" ? "2026-04-06" : "2026-01-01"}::date,${actorId},${actorId}) returning id`,
          "objects",
        )
      ).length,
      1,
    );
  }
  return { ...org, actorId, childId, scheduleId, employeeId, deductionsId, country };
}

async function configurationSnapshot(orgId: string) {
  return (
    await db.execute<{ state: unknown }>(
      sql`select jsonb_build_object(
    'org',(select to_jsonb(o) from orgs o where id=${orgId}),
    'components',(select jsonb_agg(to_jsonb(c) order by id) from pay_components c where org_id=${orgId}),
    'treatments',(select jsonb_agg(to_jsonb(t) order by id) from pay_component_statutory_treatments t where org_id=${orgId})
  ) as state`,
      "objects",
    )
  )[0]!.state;
}

async function calculationSnapshot(orgId: string, documentId: string) {
  return (
    await db.execute<{ state: unknown }>(
      sql`select jsonb_build_object(
    'run',(select to_jsonb(r) from pay_runs r where org_id=${orgId} and document_id=${documentId}),
    'document',(select to_jsonb(d) from documents d where org_id=${orgId} and id=${documentId}),
    'stubs',(select jsonb_agg(to_jsonb(s) order by id) from pay_stubs s where org_id=${orgId} and pay_run_document_id=${documentId}),
    'lines',(select jsonb_agg(to_jsonb(l) order by l.id) from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
      where s.org_id=${orgId} and s.pay_run_document_id=${documentId}),
    'entitlements',(select jsonb_agg(to_jsonb(e) order by id) from entitlement_ledger e where org_id=${orgId} and pay_run_document_id=${documentId})
  ) as state`,
      "objects",
    )
  )[0]!.state;
}

for (const country of ["GB", "IE"] as const) {
  test(
    `${country} child payroll consumes native policy and configured slots without setup authority`,
    { skip: !DB },
    async () => {
      const fx = await withBypassContext(() => seedScopedPayroll(country));
      try {
        await withOrgContext(fx.orgId, async () => {
          const allowed = new Set([fx.childId]);
          const run = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: "2026-07-01",
            periodEnd: "2026-07-31",
            allowedSubsidiaryIds: allowed,
          });
          const input = {
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: run.documentId,
            allowedSubsidiaryIds: allowed,
          };
          await assert.rejects(
            () => payrollSettings(fx.orgId, allowed),
            /payroll settings not found/,
          );
          await assert.rejects(
            () => statutoryHolidayPayEnabled(fx.orgId, db, allowed),
            /payroll settings not found/,
          );
          await assert.rejects(
            () => seedPayrollComponents(fx.orgId, fx.actorId, country, allowed),
            /payroll settings not found/,
          );
          const policy = await payrollCalculationPolicyForPayRun(fx.orgId, run.documentId, allowed);
          assert.equal(
            policy.statutoryHolidayPay,
            false,
            "an undecided holiday policy remains off",
          );
          assert.equal(policy.settings.supplementalTaxMethod, "per_run");
          assert.deepEqual(policy.settings, await payrollSettings(fx.orgId));
          const configuration = await configurationSnapshot(fx.orgId);
          const calculated = await calculatePayRun(input);
          assert.equal(calculated.employees, 1);
          assert.deepEqual(calculated.errors, []);
          assert.deepEqual(await configurationSnapshot(fx.orgId), configuration);
          const valuedTax = (
            await db.execute<{ n: number }>(
              sql`select count(*)::int as n from pay_stub_lines l
          join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
          where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.kind='deduction' and l.amount<>0`,
              "objects",
            )
          )[0]!.n;
          assert.ok(
            valuedTax > 0,
            "configured slot admission must exercise valued native liabilities",
          );
          for (const scope of [new Set<string>(), new Set([fx.subsidiaryId])]) {
            const before = await calculationSnapshot(fx.orgId, run.documentId);
            await assert.rejects(
              () => calculatePayRun({ ...input, allowedSubsidiaryIds: scope }),
              /pay run not found/,
            );
            await assert.rejects(
              () => payrollCalculationPolicyForPayRun(fx.orgId, run.documentId, scope),
              /pay run not found/,
            );
            assert.deepEqual(await calculationSnapshot(fx.orgId, run.documentId), before);
          }
          await assert.rejects(
            () => payrollCalculationPolicyForPayRun(randomUUID(), run.documentId, allowed),
            /pay run not found/,
          );
          await assert.rejects(
            () => payrollCalculationPolicyForPayRun(fx.orgId, randomUUID(), allowed),
            /pay run not found/,
          );
          assert.equal(
            (
              await db.execute(
                sql`update orgs set settings=jsonb_set(settings,'{payroll,statutoryHolidayPay}','true'::jsonb)
          where id=${fx.orgId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          assert.equal(
            (await payrollCalculationPolicyForPayRun(fx.orgId, run.documentId, allowed))
              .statutoryHolidayPay,
            true,
          );
          assert.equal(
            (
              await db.execute(
                sql`update pay_components set is_active=false
          where org_id=${fx.orgId} and system_key='stat_holiday_premium' and country is null returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const missingComponentState = await calculationSnapshot(fx.orgId, run.documentId);
          const missingComponentConfiguration = await configurationSnapshot(fx.orgId);
          await assert.rejects(
            () => calculatePayRun(input),
            /missing system pay component stat_holiday_premium\/earning.*Payroll setup → Accounts & posting/,
          );
          assert.deepEqual(
            await calculationSnapshot(fx.orgId, run.documentId),
            missingComponentState,
          );
          assert.deepEqual(await configurationSnapshot(fx.orgId), missingComponentConfiguration);
          assert.equal(
            (
              await db.execute(
                sql`update pay_components set is_active=true
          where org_id=${fx.orgId} and system_key='stat_holiday_premium' and country is null returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const enabledConfiguration = await configurationSnapshot(fx.orgId);
          const beforePreview = await calculationSnapshot(fx.orgId, run.documentId);
          assert.deepEqual((await calculatePayRun({ ...input, dryRun: true })).errors, []);
          assert.deepEqual(await configurationSnapshot(fx.orgId), enabledConfiguration);
          assert.deepEqual(await calculationSnapshot(fx.orgId, run.documentId), beforePreview);
          assert.equal(
            (
              await db.execute(
                sql`update orgs set settings=jsonb_set(settings,'{payroll,statutoryHolidayPay}','false'::jsonb)
          where id=${fx.orgId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const payeSystemKey = country === "GB" ? "paye" : "ie_paye";
          assert.equal(
            (
              await db.execute(
                sql`update pay_components set liability_account_id=null
          where org_id=${fx.orgId} and country=${country} and system_key=${payeSystemKey} and kind='deduction' returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const missingAccountState = await calculationSnapshot(fx.orgId, run.documentId);
          const missingAccountConfiguration = await configurationSnapshot(fx.orgId);
          await assert.rejects(
            () => calculatePayRun(input),
            /payroll setup incomplete: .*paye liability account.*Payroll setup → Accounts & posting/,
          );
          assert.deepEqual(
            await calculationSnapshot(fx.orgId, run.documentId),
            missingAccountState,
          );
          assert.deepEqual(await configurationSnapshot(fx.orgId), missingAccountConfiguration);
          const maintained = await calculatePayRun({ ...input, allowedSubsidiaryIds: null });
          assert.deepEqual(maintained.errors, []);
          assert.equal(
            (
              await db.execute<{ account: string }>(
                sql`select liability_account_id as account from pay_components
          where org_id=${fx.orgId} and country=${country} and system_key=${payeSystemKey} and kind='deduction'`,
                "objects",
              )
            )[0]!.account,
            fx.deductionsId,
          );
          assert.equal(
            (
              await db.execute(
                sql`update parties set subsidiary_id=${fx.subsidiaryId}
          where org_id=${fx.orgId} and id=${fx.employeeId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const movedPopulation = await calculationSnapshot(fx.orgId, run.documentId);
          await assert.rejects(() => calculatePayRun(input), /pay run not found/);
          await assert.rejects(
            () => payrollCalculationPolicyForPayRun(fx.orgId, run.documentId, allowed),
            /pay run not found/,
          );
          assert.deepEqual(await calculationSnapshot(fx.orgId, run.documentId), movedPopulation);
          assert.equal(
            (
              await db.execute(
                sql`update pay_schedules set subsidiary_id=null
          where org_id=${fx.orgId} and id=${fx.scheduleId} returning id`,
                "objects",
              )
            ).length,
            1,
          );
          const defaultRun = await createPayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            payScheduleId: fx.scheduleId,
            periodStart: "2026-08-01",
            periodEnd: "2026-08-31",
          });
          assert.equal(
            (
              await db.execute<{ subsidiary: string }>(
                sql`select subsidiary_id as subsidiary from documents
          where org_id=${fx.orgId} and id=${defaultRun.documentId}`,
                "objects",
              )
            )[0]!.subsidiary,
            fx.subsidiaryId,
          );
          await assert.rejects(
            () => calculatePayRun({ ...input, documentId: defaultRun.documentId }),
            /pay run not found/,
          );
        });
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}
