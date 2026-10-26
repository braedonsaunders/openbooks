import { submitBenefitEnrollmentFixture } from "../testing/benefit-fixtures.ts";
import { dropScratchOrgReporting, seedPayrollComponent } from "../testing/fixtures.ts";
import {
  seedHourlyPayrollTime as hours,
  seedHourlyPayrollOrg as payrollOrg,
  seedHourlyPayrollEmployee as employee,
  type HourlyPayrollFixture as Fixture,
} from "../testing/payroll-hourly-fixture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { entitlementBalances } from "./entitlements-db.ts";
import { validateEntitlementPlanConfiguration } from "./entitlement-plan-config.ts";
import { mutatePayRunAdjustment, preflightPayRunAdjustment } from "./run-adjustments.ts";

/**
 * Bank drawdown on ordinary runs: a plan's payout component withdraws from
 * the bank on any non-termination run, an hours bank funds from
 * negative-hours deposit lines, overdraws refuse naming the balance, and the
 * a payout never replenishes its own bank.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function earningComponent(fx: Fixture, code: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
    tax_treatment,payment_kind,expense_account_id,liability_account_id)
    values(${id},${fx.orgId},${code},${code},'earning','CA',true,true,true,true,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
  await db.execute(sql`insert into pay_component_statutory_treatments(org_id,pay_component_id,effective_from,program_exclusions,vacationable)
    values(${fx.orgId},${id},'2026-01-01','{}',true)`);
  return id;
}

async function opening(
  fx: Fixture,
  planId: string,
  partyId: string,
  amount: string,
  hoursValue: string | null,
): Promise<void> {
  await db.execute(sql`insert into entitlement_ledger(org_id,plan_id,employee_party_id,movement_date,amount,hours,kind,note,created_by,updated_by)
    values(${fx.orgId},${planId},${partyId},'2026-06-01',${amount},${hoursValue},'opening','carried-in test balance',${fx.actorId},${fx.actorId})`);
}

async function balanceOf(
  fx: Fixture,
  partyId: string,
  planId: string,
  asOf: string,
): Promise<string> {
  const balances = await entitlementBalances(fx.orgId, partyId, asOf, { executor: db });
  return balances.find((b) => b.plan.id === planId)!.balance;
}

for (const unit of ["money", "hours"] as const) {
  test(
    `an automatic ${unit} cap payout pays and settles the excess once`,
    { skip: !DB },
    async () => {
      const fx = await payrollOrg();
      try {
        const { partyId } = await employee(fx, `Automatic ${unit} cap employee`);
        const payout = await earningComponent(fx, `AUTO-${unit.toUpperCase()}-PAYOUT`);
        const accrual = randomUUID();
        await seedPayrollComponent(fx.orgId, accrual, {
          code: `AUTO-${unit.toUpperCase()}-ACCRUAL`,
          name: `Automatic ${unit} cap accrual`,
          kind: "employer_contribution",
          systemKey: null,
          liabilityAccountId: fx.accounts.vacationPayable,
          country: "CA",
          sequence: 240,
          isActive: true,
          createdBy: fx.actorId,
          updatedBy: fx.actorId,
        });
        const planId = randomUUID();
        const openingBalance = unit === "money" ? "450.0000" : "7.0000";
        const cap = unit === "money" ? "500.0000" : "8.0000";
        const accrualValue = unit === "money" ? "100.0000" : "2.0000";
        await db.execute(sql`insert into entitlement_plans
        (id,org_id,code,name,unit,direction,accrual_method,accrual_value,accrual_component_id,
         payout_component_id,liability_account_id,cap_behavior,is_active,created_by,updated_by)
        values(${planId},${fx.orgId},${`AUTO-${unit.toUpperCase()}`},${`Automatic ${unit} cap`},${unit},
          'accrue','fixed_per_period',${accrualValue},${accrual},${payout},${fx.accounts.vacationPayable},
          'auto_payout',true,${fx.actorId},${fx.actorId})`);
        await db.execute(sql`insert into entitlement_plan_limits
        (org_id,plan_id,employee_party_id,max_balance,effective_from,created_by,updated_by)
        values(${fx.orgId},${planId},${partyId},${cap},'2026-01-01',${fx.actorId},${fx.actorId})`);
        await opening(
          fx,
          planId,
          partyId,
          openingBalance,
          unit === "hours" ? openingBalance : null,
        );
        await hours(fx, partyId, ["2026-07-13"]);
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
        assert.deepEqual(result.errors, []);

        const ledger = await db.execute<{ kind: string; amount: string; hours: string | null }>(
          sql`
        select kind, amount::text as amount, hours::text as hours from entitlement_ledger
         where org_id=${fx.orgId} and plan_id=${planId} and employee_party_id=${partyId}
           and pay_run_document_id=${run.documentId} order by kind`,
          "objects",
        );
        assert.deepEqual(ledger, [
          { kind: "accrual", amount: accrualValue, hours: null },
          {
            kind: "payout",
            amount: unit === "money" ? "-50.0000" : "-1.0000",
            hours: unit === "money" ? null : "1.00",
          },
        ]);
        const balance = (
          await db.execute<{ balance: string }>(
            sql`
        select sum(amount)::text as balance from entitlement_ledger
         where org_id=${fx.orgId} and plan_id=${planId} and employee_party_id=${partyId}`,
            "objects",
          )
        )[0]!.balance;
        assert.equal(balance, cap);
        const payoutLine = await db.execute<{ amount: string; hours: string | null }>(
          sql`
        select line.amount::text as amount, line.hours::text as hours from pay_stub_lines line
          join pay_stubs stub on stub.id=line.stub_id and stub.org_id=line.org_id
         where stub.org_id=${fx.orgId} and stub.pay_run_document_id=${run.documentId}
           and stub.employee_party_id=${partyId} and line.component_id=${payout}`,
          "objects",
        );
        assert.deepEqual(payoutLine, [
          {
            amount: unit === "money" ? "50.0000" : "30.0000",
            hours: unit === "money" ? null : "1.00",
          },
        ]);
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "hours entitlement accrual values a foreign wage in the pay run currency",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Foreign Currency Bank Employee", fx.subsidiaryId);
      await db.execute(sql`update labor_cost_rates set rate='60',currency='USD'
      where org_id=${fx.orgId} and employee_party_id=${partyId}`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${fx.orgId}, 'USD', 'CAD', '2026-01-01', 'spot', '1.5')`);
      const accrual = randomUUID();
      await seedPayrollComponent(fx.orgId, accrual, {
        code: "FX-HOURS-ACCRUAL",
        name: "Foreign wage hours accrual",
        kind: "employer_contribution",
        systemKey: null,
        liabilityAccountId: fx.accounts.vacationPayable,
        country: "CA",
        sequence: 240,
        isActive: true,
        createdBy: fx.actorId,
        updatedBy: fx.actorId,
      });
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,accrual_value,accrual_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'FXHOURS','Foreign wage hours bank','hours','accrue','fixed_per_period','2',
        ${accrual},${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await hours(fx, partyId, ["2026-07-13"]);
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
      assert.deepEqual(result.errors, []);
      const line = (
        await db.execute<{ amount: string }>(
          sql`
      select l.amount::text as amount from pay_stub_lines l
        join pay_stubs s on s.id=l.stub_id and s.org_id=l.org_id
       where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${accrual}
    `,
          "objects",
        )
      )[0];
      assert.equal(line?.amount, "180.0000", "two banked hours at CAD 90 per hour post CAD 180");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

for (const unit of ["hours", "money"] as const) {
  test(
    `an audited keyed-rate payout uses its ${unit} bank and replays exactly once`,
    { skip: !DB },
    async () => {
      const fx = await payrollOrg();
      try {
        const { partyId } = await employee(fx, "Keyed Rate Employee", fx.subsidiaryId);
        const payout = await earningComponent(fx, "KEYED-PAYOUT");
        const planId = randomUUID();
        await db.execute(sql`insert into entitlement_plans
        (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
         liability_account_id,cap_behavior,is_active,created_by,updated_by)
        values(${planId},${fx.orgId},'KEYED','Accrued pay',${unit},'accrue','manual',${payout},
          ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
        await opening(
          fx,
          planId,
          partyId,
          unit === "hours" ? "16" : "1200",
          unit === "hours" ? "16" : null,
        );
        await hours(fx, partyId, ["2026-07-13"]);
        const run = await createPayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12",
          periodEnd: "2026-07-18",
        });
        const input = {
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
          mutation: {
            action: "bank_cash_input" as const,
            employeePartyId: partyId,
            componentId: payout,
            hours: "8.00",
            rate: "143.83",
            amount: "1150.64",
            reason: "Approved withdrawal at the recorded hourly rate",
            sourceReference: "Payroll source document 2",
            idempotencyKey: randomUUID(),
          },
        };
        await mutatePayRunAdjustment(input);
        await mutatePayRunAdjustment(input);
        const saved = await db.execute(
          sql`select amount::text,hours::text from pay_run_adjustments
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and component_id=${payout}`,
          "objects",
        );
        assert.deepEqual(saved, [{ amount: "1150.6400", hours: "8.00" }]);
        const result = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(result.errors, []);
        const paid = await db.execute(
          sql`select line.amount::text,line.hours::text from pay_stub_lines line
        join pay_stubs stub on stub.id=line.stub_id and stub.org_id=line.org_id
        where stub.org_id=${fx.orgId} and stub.pay_run_document_id=${run.documentId}
          and line.component_id=${payout}`,
          "objects",
        );
        assert.deepEqual(
          paid,
          [{ amount: "1150.6400", hours: "8.00" }],
          "the keyed rate prices the bank cash line, independently of the current wage",
        );
        assert.equal(
          await balanceOf(fx, partyId, planId, "2026-07-21"),
          unit === "hours" ? "16.0000" : "1200.0000",
          "a calculated withdrawal does not spend the settled bank",
        );
        await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
        assert.equal(
          await balanceOf(fx, partyId, planId, "2026-07-21"),
          unit === "hours" ? "8.0000" : "49.3600",
        );
      } finally {
        await dropScratchOrgReporting(fx.orgId);
      }
    },
  );
}

test(
  "an audited money-bank input preserves the available-balance refusal",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Limited Bank Employee", fx.subsidiaryId);
      const payout = await earningComponent(fx, "LIMITED-PAYOUT");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'LIMITED','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, partyId, "552", null);
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input",
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          reason: "Approved withdrawal at the recorded hourly rate",
          sourceReference: "Payroll source document 2",
          idempotencyKey: randomUUID(),
        },
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(result.errors.length, 1);
      assert.match(
        result.errors[0]!.message,
        /payout of 1150\.6400 exceeds the available 552\.0000/,
      );
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "552.0000");
      assert.equal(
        (
          await db.execute(
            sql`select id from pay_stubs where org_id=${fx.orgId}
      and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "vacation paid as earned needs no bank balance while additional bank withdrawals still refuse",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId, employmentId } = await employee(fx, "Vacation Cash Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await db.execute(sql`update payroll_vacation_terms set method='pay_each_period',updated_by=${fx.actorId},updated_at=now()
      where org_id=${fx.orgId} and employment_id=${employmentId}`);
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(
          result.errors,
          [],
          "newly earned vacation is payable without a carried bank balance",
        );
        const stubs = await db.execute(
          sql`select gross::text,vacation_accrued::text from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
          "objects",
        );
        assert.deepEqual(stubs, [{ gross: "249.6000", vacation_accrued: "0.0000" }]);
        const movements = await db.execute(
          sql`select id from entitlement_ledger where org_id=${fx.orgId}
        and plan_id=${plan.id} and employee_party_id=${partyId}`,
          "objects",
        );
        assert.equal(
          movements.length,
          0,
          "current-period cash vacation neither accrues nor withdraws a bank",
        );
      }
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'10')`);
      const refused = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(refused.errors.length, 1);
      assert.match(
        refused.errors[0]!.message,
        /Vacation Cash Employee.*payout of 10\.0000 exceeds the available 0\.0000/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a zero vacation replacement preserves supplied cash earnings without regenerating vacation pay",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId, employmentId } = await employee(fx, "Vacation Replacement Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await db.execute(sql`update payroll_vacation_terms set method='pay_each_period',updated_by=${fx.actorId},updated_at=now()
      where org_id=${fx.orgId} and employment_id=${employmentId}`);
      const suppliedVacation = await earningComponent(fx, "EARNED-VACATION");
      await db.execute(
        sql`update pay_component_statutory_treatments set vacationable=false where org_id=${fx.orgId} and pay_component_id=${suppliedVacation}`,
      );
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,replace_component)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'0',true),
      (${fx.orgId},${run.documentId},${partyId},'line',${suppliedVacation},'9.60',false)`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(result.errors, []);
        const stub = (
          await db.execute(
            sql`select gross::text,vacation_accrued::text from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        )[0];
        assert.deepEqual(
          stub,
          { gross: "249.6000", vacation_accrued: "0.0000" },
          "the supplied vacation amount is paid exactly once",
        );
        const generated = await db.execute(
          sql`select l.id from pay_stub_lines l join pay_stubs s on s.id=l.stub_id and s.org_id=l.org_id
        where s.org_id=${fx.orgId} and s.pay_run_document_id=${run.documentId} and l.component_id=${plan.payout_component_id}`,
          "objects",
        );
        assert.equal(
          generated.length,
          0,
          "zero replacement remains authoritative for the later vacation phase",
        );
        const movements = await db.execute(
          sql`select id from entitlement_ledger where org_id=${fx.orgId}
        and plan_id=${plan.id} and employee_party_id=${partyId}`,
          "objects",
        );
        assert.equal(movements.length, 0);
      }
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "banked wages retain their declared vacation eligibility without replenishing their own bank",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Deferred Wage Employee");
      const payoutComponent = await earningComponent(fx, "DEFERREDWAGE");
      const accrualComponent = randomUUID();
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,expense_account_id,liability_account_id)
      values(${accrualComponent},${fx.orgId},'DEFERREDACCR','Deferred wage accrual','employer_contribution','CA',
        ${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
      const bankId = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,accrual_value,accrual_component_id,payout_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${bankId},${fx.orgId},'DEFERRED','Deferred wages','money','accrue','percent_of_earnings','4',${accrualComponent},${payoutComponent},
        ${fx.accounts.otherPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, bankId, partyId, "500", null);
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${payoutComponent},'240')`);
      for (const eligible of [true, false, true]) {
        await db.execute(
          sql`update pay_component_statutory_treatments set vacationable=${eligible} where org_id=${fx.orgId} and pay_component_id=${payoutComponent}`,
        );
        const result = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(result.errors, []);
        const stub = (
          await db.execute<{ gross: string; vacation_accrued: string }>(
            sql`select gross::text,vacation_accrued::text
        from pay_stubs where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        )[0]!;
        assert.equal(stub.gross, "480.0000");
        assert.equal(
          stub.vacation_accrued,
          eligible ? "19.2000" : "9.6000",
          "vacation accrues on deferred wages precisely when their earning component declares eligibility",
        );
        assert.equal(
          await balanceOf(fx, partyId, bankId, "2026-07-21"),
          "500.0000",
          "recalculation leaves the settled bank unchanged",
        );
        const payouts = await db.execute(
          sql`select amount::text from entitlement_ledger
        where org_id=${fx.orgId} and plan_id=${bankId} and pay_run_document_id=${run.documentId} and kind='payout'`,
          "objects",
        );
        assert.deepEqual(
          payouts,
          [{ amount: "-240.0000" }],
          "recalculation preserves one exact withdrawal",
        );
      }
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.equal(
        await balanceOf(fx, partyId, bankId, "2026-07-21"),
        "269.6000",
        "the committed wage bank accrues only on new wages, never on its own withdrawal",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a vacation payout on a regular run withdraws from the bank without accruing on the payout",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Vacation Drawdown Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await db.execute(sql`update pay_components set expense_account_id=${fx.accounts.vacationPayable}
      where org_id=${fx.orgId} and id=${plan.payout_component_id}`);
      await opening(fx, plan.id, partyId, "1000", null);
      await hours(fx, partyId, [
        "2026-07-13",
        "2026-07-14",
        "2026-07-15",
        "2026-07-16",
        "2026-07-17",
      ]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'600')`);
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.deepEqual(result.errors, []);
      // The stub pays 600 in cash and the ledger withdraws it with the stub line linked.
      const payout = await db.execute<{ amount: string; stub_line_id: string | null }>(
        sql`select amount::text as amount,stub_line_id::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${plan.id} and kind='payout'`,
        "objects",
      );
      assert.equal(payout.length, 1);
      assert.equal(payout[0]!.amount, "-600.0000");
      assert.ok(payout[0]!.stub_line_id, "the withdrawal ties to its stub line");
      // 40 regular hours at 4%: the 600 payout accrues nothing further.
      const stub = (
        await db.execute<{ vacation_accrued: string }>(
          sql`select vacation_accrued::text from pay_stubs
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
          "objects",
        )
      )[0]!;
      assert.equal(stub.vacation_accrued, "48.0000");
      assert.equal(await balanceOf(fx, partyId, plan.id, "2026-07-21"), "1000.0000");
      // Recalculation replaces preview bank movements before their stub lines.
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
      const repayout = await db.execute<{ amount: string }>(
        sql`select amount::text as amount
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${plan.id} and kind='payout'`,
        "objects",
      );
      assert.equal(repayout.length, 1);
      assert.equal(repayout[0]!.amount, "-600.0000");
      assert.equal(await balanceOf(fx, partyId, plan.id, "2026-07-21"), "1000.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.equal(await balanceOf(fx, partyId, plan.id, "2026-07-21"), "448.0000");
      const bankDebit = await db.execute<{ amount: string; custom: { payrollExpense: boolean } }>(
        sql`
      select amount::text, custom from document_lines where org_id=${fx.orgId}
        and document_id=${run.documentId} and account_id=${fx.accounts.vacationPayable}
        and amount > 0`,
        "objects",
      );
      assert.equal(bankDebit.length, 1);
      assert.equal(bankDebit[0]!.amount, "600.0000");
      assert.equal(
        bankDebit[0]!.custom.payrollExpense,
        false,
        "withdrawing an accrued liability must not enter payroll expense allocation",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an overdraw refuses naming the balance unless the plan allows negatives",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Overdraw Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await opening(fx, plan.id, partyId, "1000", null);
      await hours(fx, partyId, [
        "2026-07-13",
        "2026-07-14",
        "2026-07-15",
        "2026-07-16",
        "2026-07-17",
      ]);
      const first = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${first.documentId},${partyId},'line',${plan.payout_component_id},'600')`);
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: first.documentId,
          })
        ).errors,
        [],
      );
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId });
      await hours(fx, partyId, [
        "2026-07-20",
        "2026-07-21",
        "2026-07-22",
        "2026-07-23",
        "2026-07-24",
      ]);
      const second = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-07-25",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${second.documentId},${partyId},'line',${plan.payout_component_id},'500')`);
      const refused = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: second.documentId,
      });
      assert.equal(refused.errors.length, 1);
      assert.match(
        refused.errors[0]!.message,
        /Overdraw Employee.*Vacation payout of 500.*exceeds the available 496/,
      );
      // The plan opts into negatives: the same run now calculates, landing below zero.
      await db.execute(
        sql`update entitlement_plans set allow_negative_balance=true where org_id=${fx.orgId} and id=${plan.id}`,
      );
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: second.documentId,
          })
        ).errors,
        [],
      );
      assert.equal(await balanceOf(fx, partyId, plan.id, "2026-07-28"), "448.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId });
      assert.equal(await balanceOf(fx, partyId, plan.id, "2026-07-28"), "-4.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an hours bank funds from negative deposit lines and pays from positive ones",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52,subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Banked Time Employee", fx.subsidiaryId);
      const overtime = await earningComponent(fx, "OTBANK");
      const take = await earningComponent(fx, "BANKTAKE");
      const store = await earningComponent(fx, "BANKSTORE");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,deposit_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'BANKOT','Banked overtime','hours','accrue','manual',${take},${store},${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      // Week one: 8 overtime hours banked instead of paid (cash nets to zero).
      await hours(fx, partyId, [
        "2026-07-13",
        "2026-07-14",
        "2026-07-15",
        "2026-07-16",
        "2026-07-17",
      ]);
      const first = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const input = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: first.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      };
      const depositInput = {
        ...input,
        mutation: {
          action: "add" as const,
          employeePartyId: partyId,
          componentId: store,
          amount: "-240",
          hours: "-8",
          note: "Overtime transferred to the bank",
          idempotencyKey: randomUUID(),
        },
      };
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, componentId: overtime, amount: "240" },
          }),
        /non-negative/,
      );
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, componentId: overtime },
          }),
        /OTBANK.*no active entitlement bank/,
      );
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, componentId: take },
          }),
        /BANKTAKE.*BANKOT.*deposit component/,
      );
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, amount: "-0.001" },
          }),
        /negative cash amount/,
      );
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, note: "" },
          }),
        /supporting reason/,
      );
      await db.execute(
        sql`update entitlement_plans set direction='owe' where org_id=${fx.orgId} and id=${planId}`,
      );
      await assert.rejects(
        () => preflightPayRunAdjustment(depositInput),
        /BANKSTORE.*BANKOT.*accrued bank/,
      );
      await db.execute(
        sql`update entitlement_plans set direction='accrue' where org_id=${fx.orgId} and id=${planId}`,
      );
      await db.execute(
        sql`update pay_runs set run_type='termination' where org_id=${fx.orgId} and document_id=${first.documentId}`,
      );
      await assert.rejects(
        () => preflightPayRunAdjustment(depositInput),
        /BANKSTORE.*termination run.*ordinary editable run/,
      );
      await db.execute(
        sql`update pay_runs set run_type='regular' where org_id=${fx.orgId} and document_id=${first.documentId}`,
      );
      const conflictingPlan = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,deposit_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${conflictingPlan},${fx.orgId},'BANKALT','Alternate overtime bank','hours','accrue','manual',${store},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await assert.rejects(
        () => preflightPayRunAdjustment(depositInput),
        /BANKSTORE.*multiple entitlement banks \(BANKALT, BANKOT\)/,
      );
      await db.execute(
        sql`delete from entitlement_plans where org_id=${fx.orgId} and id=${conflictingPlan}`,
      );
      assert.deepEqual(await preflightPayRunAdjustment(depositInput), { replayed: false });
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from pay_run_adjustments
      where org_id=${fx.orgId} and pay_run_document_id=${first.documentId}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from audit_log
      where org_id=${fx.orgId} and table_name='pay_run_adjustments' and row_id=${depositInput.mutation.idempotencyKey}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      await mutatePayRunAdjustment({
        ...input,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: overtime,
          amount: "240",
          hours: "8",
        },
      });
      assert.deepEqual(await mutatePayRunAdjustment(depositInput), {
        changed: true,
        replayed: false,
      });
      // A money bank retains signed cash and source hours, but its ledger unit is money.
      const cash = await earningComponent(fx, "BANKCASH");
      const cashPlan = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${cashPlan},${fx.orgId},'CASHBANK','Banked cash','money','accrue','manual',${cash},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await mutatePayRunAdjustment({
        ...input,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: cash,
          amount: "-60",
          hours: "-2",
          note: "Cash earnings transferred to the money bank",
        },
      });
      // Replays keep the original input; fresh writes and calculation recheck the bank.
      await db.execute(
        sql`update entitlement_plans set is_active=false where org_id=${fx.orgId} and id=${planId}`,
      );
      assert.deepEqual(await mutatePayRunAdjustment(depositInput), {
        changed: false,
        replayed: true,
      });
      await assert.rejects(
        () =>
          preflightPayRunAdjustment({
            ...depositInput,
            mutation: { ...depositInput.mutation, idempotencyKey: randomUUID() },
          }),
        /BANKSTORE.*no active entitlement bank/,
      );
      const retired = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: first.documentId,
      });
      assert.equal(retired.errors.length, 1);
      assert.match(retired.errors[0]!.message, /BANKSTORE.*no active entitlement bank/);
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from entitlement_ledger
      where org_id=${fx.orgId} and plan_id=${planId}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      await db.execute(
        sql`update entitlement_plans set is_active=true where org_id=${fx.orgId} and id=${planId}`,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from audit_log
      where org_id=${fx.orgId} and table_name='pay_run_adjustments' and row_id=${depositInput.mutation.idempotencyKey}`,
            "objects",
          )
        )[0]!.count,
        1,
      );
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: first.documentId,
          })
        ).errors,
        [],
      );
      // Changing the paid population invalidates derived bank movements before
      // deleting their stub lines, then recalculation recreates each deposit once.
      await mutatePayRunAdjustment({
        ...input,
        mutation: { action: "exclude", employeePartyId: partyId },
      });
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from entitlement_ledger
      where org_id=${fx.orgId} and pay_run_document_id=${first.documentId}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from pay_stubs
      where org_id=${fx.orgId} and pay_run_document_id=${first.documentId}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      assert.equal(
        (
          await db.execute<{ run_status: string }>(
            sql`select run_status from pay_runs
      where org_id=${fx.orgId} and document_id=${first.documentId}`,
            "objects",
          )
        )[0]!.run_status,
        "draft",
      );
      await mutatePayRunAdjustment({
        ...input,
        mutation: { action: "include", employeePartyId: partyId },
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: first.documentId,
          })
        ).errors,
        [],
      );
      const deposit = await db.execute<{ amount: string; hours: string | null }>(
        sql`select amount::text as amount,hours::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${planId} and kind='bank_in'`,
        "objects",
      );
      assert.equal(deposit.length, 1);
      assert.equal(deposit[0]!.amount, "8.0000");
      assert.equal(cmp(deposit[0]!.hours ?? "0", "8"), 0);
      assert.equal(
        await balanceOf(fx, partyId, planId, "2026-07-21"),
        "0.0000",
        "the calculated deposit becomes available only when its run commits",
      );
      const cashDeposit = await db.execute<{ amount: string; hours: string | null }>(
        sql`select amount::text, hours::text
      from entitlement_ledger where org_id=${fx.orgId} and plan_id=${cashPlan} and kind='bank_in'`,
        "objects",
      );
      assert.equal(cashDeposit.length, 1);
      assert.equal(cashDeposit[0]!.amount, "60.0000");
      assert.equal(cashDeposit[0]!.hours, null);
      // Week two: 5 hours taken as cash; a further 5 would overdraw the 3 left.
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId });
      await hours(fx, partyId, [
        "2026-07-20",
        "2026-07-21",
        "2026-07-22",
        "2026-07-23",
        "2026-07-24",
      ]);
      const second = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-07-25",
      });
      await mutatePayRunAdjustment({
        ...input,
        documentId: second.documentId,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: take,
          amount: "150",
          hours: "5",
        },
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: second.documentId,
          })
        ).errors,
        [],
      );
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-28"), "8.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId });
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-28"), "3.0000");
      await hours(fx, partyId, [
        "2026-07-27",
        "2026-07-28",
        "2026-07-29",
        "2026-07-30",
        "2026-07-31",
      ]);
      const third = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-26",
        periodEnd: "2026-08-01",
      });
      await mutatePayRunAdjustment({
        ...input,
        documentId: third.documentId,
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: take,
          amount: "150",
          hours: "5",
        },
      });
      const refused = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: third.documentId,
      });
      assert.equal(refused.errors.length, 1);
      assert.match(
        refused.errors[0]!.message,
        /Banked Time Employee.*Banked overtime payout of 5.*exceeds the available 3/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test("one payout component settling two plans refuses naming both", { skip: !DB }, async () => {
  const fx = await payrollOrg();
  try {
    await db.execute(
      sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
    );
    const { partyId } = await employee(fx, "Shared Component Employee");
    const payout = await earningComponent(fx, "VACPAY3");
    for (const code of ["VACA", "VACB"]) {
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,accrual_value,payout_component_id,deposit_component_id,
        liability_account_id,cap_behavior,is_active,created_by,updated_by)
        values(${randomUUID()},${fx.orgId},${code},${code},'money','accrue','percent_of_earnings','4',${payout},null,${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
    }
    await hours(fx, partyId, [
      "2026-07-13",
      "2026-07-14",
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
    ]);
    const run = await createPayRun({
      orgId: fx.orgId,
      actorId: fx.actorId,
      payScheduleId: fx.scheduleId,
      periodStart: "2026-07-12",
      periodEnd: "2026-07-18",
    });
    await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${payout},'100')`);
    const refused = await calculatePayRun({
      orgId: fx.orgId,
      actorId: fx.actorId,
      documentId: run.documentId,
    });
    assert.equal(refused.errors.length, 1);
    assert.match(refused.errors[0]!.message, /VACPAY3.*VACA, VACB/);
  } finally {
    await dropScratchOrgReporting(fx.orgId);
  }
});

test(
  "plan settlement configuration distinguishes accrued payouts from owed repayments",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const payout = await earningComponent(fx, "VACPAY2");
      const dues = randomUUID();
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${dues},${fx.orgId},'DUES2','Dues','deduction','CA',true,true,true,false,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
      await assert.rejects(
        () =>
          validateEntitlementPlanConfiguration(db, fx.orgId, {
            payoutComponentId: payout,
            depositComponentId: payout,
          }),
        /are the same row — choose distinct components so withdrawals and deposits stay attributable/,
      );
      await assert.rejects(
        () =>
          validateEntitlementPlanConfiguration(db, fx.orgId, {
            payoutComponentId: dues,
            depositComponentId: null,
          }),
        /DUES2 is not an earning component — only earning components carry accrued bank settlements/,
      );
      await validateEntitlementPlanConfiguration(db, fx.orgId, {
        payoutComponentId: payout,
        depositComponentId: null,
      });
      await validateEntitlementPlanConfiguration(db, fx.orgId, {
        direction: "owe",
        payoutComponentId: dues,
        depositComponentId: null,
      });
      await assert.rejects(
        () =>
          validateEntitlementPlanConfiguration(db, fx.orgId, {
            direction: "owe",
            payoutComponentId: payout,
          }),
        /Recovery component VACPAY2 is not a deduction — choose an employee deduction component/,
      );
      await assert.rejects(
        () =>
          validateEntitlementPlanConfiguration(db, fx.orgId, {
            direction: "owe",
            payoutComponentId: dues,
            depositComponentId: payout,
          }),
        /leave the deposit component empty on the recovery plan/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an audited split payout draws only its bank-funded portion at the pay-date wage",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId, employmentId } = await employee(
        fx,
        "Split Payout Employee",
        fx.subsidiaryId,
      );
      await db.execute(
        sql`update labor_cost_rates set rate='46' where org_id=${fx.orgId} and employee_party_id=${partyId}`,
      );
      await db.execute(sql`update payroll_vacation_terms set percent_floor='7',updated_by=${fx.actorId},updated_at=now()
      where org_id=${fx.orgId} and employment_id=${employmentId}`);
      const payout = await earningComponent(fx, "SPLIT-PAYOUT");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLIT','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, partyId, "552", null);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const input = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input" as const,
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
        },
      };
      await mutatePayRunAdjustment(input);
      assert.deepEqual(await mutatePayRunAdjustment(input), { changed: false, replayed: true });
      // The issued total is unchanged and assessed once; only the bank-funded
      // portion withdraws, and the dated vacation treatment governs both
      // portions exactly as it would an unsplit line (7% of the total here).
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await calculatePayRun({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
        });
        assert.deepEqual(result.errors, []);
        const paid = await db.execute(
          sql`select line.amount::text,line.hours::text from pay_stub_lines line
        join pay_stubs stub on stub.id=line.stub_id and stub.org_id=line.org_id
        where stub.org_id=${fx.orgId} and stub.pay_run_document_id=${run.documentId}
          and line.component_id=${payout} order by line.amount desc`,
          "objects",
        );
        assert.deepEqual(
          paid,
          [
            { amount: "782.6400", hours: "0.00" },
            { amount: "368.0000", hours: "8.00" },
          ],
          "the outside portion carries explicit zero hours; the bank-funded portion carries the worked hours",
        );
        const stub = (
          await db.execute(
            sql`select gross::text,vacation_accrued::text from pay_stubs
        where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        )[0];
        assert.deepEqual(stub, { gross: "1150.6400", vacation_accrued: "80.5400" });
        assert.equal(
          await balanceOf(fx, partyId, planId, "2026-07-21"),
          "552.0000",
          "recalculation leaves the settled bank unchanged",
        );
        const payouts = await db.execute(
          sql`select amount::text from entitlement_ledger
        where org_id=${fx.orgId} and plan_id=${planId} and pay_run_document_id=${run.documentId} and kind='payout'`,
          "objects",
        );
        assert.deepEqual(payouts, [{ amount: "-368.0000" }]);
      }
      // An excluded dated treatment excludes both portions alike: funding
      // origin never rewrites the component's statutory policy.
      await db.execute(sql`update pay_component_statutory_treatments set vacationable=false
      where org_id=${fx.orgId} and pay_component_id=${payout}`);
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
      const excluded = (
        await db.execute(
          sql`select gross::text,vacation_accrued::text from pay_stubs
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId}`,
          "objects",
        )
      )[0];
      assert.deepEqual(excluded, { gross: "1150.6400", vacation_accrued: "0.0000" });
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "552.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "184.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an audited split payout draws its bank-funded hours from an hours bank",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Split Hours Employee", fx.subsidiaryId);
      await db.execute(
        sql`update labor_cost_rates set rate='46' where org_id=${fx.orgId} and employee_party_id=${partyId}`,
      );
      const payout = await earningComponent(fx, "SPLIT-HOURS-PAYOUT");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLITHOURS','Accrued time','hours','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, partyId, "16", "16");
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input",
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
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
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "16.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.equal(
        await balanceOf(fx, partyId, planId, "2026-07-21"),
        "8.0000",
        "only the eight bank-funded hours leave the committed bank",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "split bank cash inputs refuse mismatched replays, deposits and malformed outside amounts",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Split Input Employee", fx.subsidiaryId);
      const payout = await earningComponent(fx, "SPLIT-INPUT");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLITINPUT','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      const base = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      };
      const mutation = (patch: Record<string, unknown>) => ({
        ...base,
        mutation: {
          action: "bank_cash_input" as const,
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
          ...patch,
        },
      });
      const saved = mutation({});
      await mutatePayRunAdjustment(saved);
      await assert.rejects(
        () =>
          mutatePayRunAdjustment({
            ...saved,
            mutation: { ...saved.mutation, outsideBankAmount: "782.63" },
          }),
        /already saved with different details/,
      );
      for (const patch of [
        { outsideBankAmount: "782.641" },
        { outsideBankAmount: "not-money" },
        { outsideBankAmount: "0.00" },
        { outsideBankAmount: "-1.00" },
        { outsideBankAmount: "1150.64" },
        { outsideBankAmount: "1150.65" },
      ])
        await assert.rejects(() => mutatePayRunAdjustment(mutation(patch)), /outside the bank/);
      await assert.rejects(
        () =>
          mutatePayRunAdjustment(
            mutation({
              hours: "-8.00",
              amount: "-1150.64",
              rate: null,
            }),
          ),
        /outside the bank must be a positive part of a withdrawal/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a split that disagrees with the native pay-date wage, or has none, refuses by name",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const mismatched = await employee(fx, "Split Wage Mismatch Employee", fx.subsidiaryId);
      const unvalued = await employee(fx, "Split Unvalued Employee", fx.subsidiaryId);
      const payout = await earningComponent(fx, "SPLIT-WAGE");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLITWAGE','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, mismatched.partyId, "552", null);
      await opening(fx, planId, unvalued.partyId, "552", null);
      // The unvalued employee keeps a period-end wage but none on the pay date.
      await db.execute(sql`update labor_cost_rates set effective_to='2026-07-18'
      where org_id=${fx.orgId} and employee_party_id=${unvalued.partyId}`);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      for (const partyId of [mismatched.partyId, unvalued.partyId]) {
        await mutatePayRunAdjustment({
          orgId: fx.orgId,
          actorId: fx.actorId,
          documentId: run.documentId,
          allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
          mutation: {
            action: "bank_cash_input",
            employeePartyId: partyId,
            componentId: payout,
            hours: "8.00",
            rate: "143.83",
            amount: "1150.64",
            outsideBankAmount: "782.64",
            reason: "Approved withdrawal with independently paid cash",
            sourceReference: "Payroll source document 7",
            idempotencyKey: randomUUID(),
          },
        });
      }
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(result.errors.length, 2);
      const messages = result.errors.map((entry) => entry.message).join("\n");
      assert.match(
        messages,
        /assigns 368\.0000 to the bank, but 8\.00 hours value to 240\.0000 at the native wage effective on 2026-07-21/,
      );
      assert.match(messages, /has no native hourly wage for bank valuation/);
      assert.equal(await balanceOf(fx, mismatched.partyId, planId, "2026-07-21"), "552.0000");
      assert.equal(await balanceOf(fx, unvalued.partyId, planId, "2026-07-21"), "552.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a pay-date-only wage version change stales a calculated split before commit",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Split Stale Wage Employee", fx.subsidiaryId);
      await db.execute(
        sql`update labor_cost_rates set rate='46' where org_id=${fx.orgId} and employee_party_id=${partyId}`,
      );
      const payout = await earningComponent(fx, "SPLIT-STALE");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLITSTALE','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, partyId, "552", null);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input",
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
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
      // Effective after the period end (2026-07-18) and on the pay date: the
      // period-end wage the run already retained cannot change, so only the
      // frozen pay-date valuation can stale this calculation.
      await db.execute(sql`update labor_cost_rates set effective_to='2026-07-20'
      where org_id=${fx.orgId} and employee_party_id=${partyId} and is_active`);
      await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
        is_active, created_by, updated_by)
      values (${fx.orgId}, ${partyId}, 'CAD', '50', 'hour', '2026-07-21', true, ${fx.actorId}, ${fx.actorId})`);
      await assert.rejects(
        () => commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId }),
        /inputs changed after it was last calculated/,
      );
      assert.equal(
        await balanceOf(fx, partyId, planId, "2026-07-21"),
        "552.0000",
        "the refused commit moves no bank money",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a per-hour contribution counts bank-funded hours once and outside cash at explicit zero hours",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId, employmentId } = await employee(
        fx,
        "Split Contribution Employee",
        fx.subsidiaryId,
      );
      await db.execute(
        sql`update labor_cost_rates set rate='46' where org_id=${fx.orgId} and employee_party_id=${partyId}`,
      );
      const payout = await earningComponent(fx, "SPLIT-CONTRIB-PAYOUT");
      const regular = await earningComponent(fx, "SPLIT-CONTRIB-REGULAR");
      await db.execute(
        sql`update pay_components set unit_of_measure='hours' where org_id=${fx.orgId} and id in (${payout},${regular})`,
      );
      const bankPlanId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${bankPlanId},${fx.orgId},'SPLITCONTRIB','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, bankPlanId, partyId, "552", null);
      const benefitPlanId = randomUUID(),
        enrollmentId = randomUUID(),
        ruleId = randomUUID();
      await db.execute(sql`insert into hrm_benefit_plans(id,org_id,code,name,kind,currency,employer_subsidiary_id,effective_from)
      values(${benefitPlanId},${fx.orgId},'SPLITPENSION','Pension plan','retirement','CAD',${fx.subsidiaryId},'2026-01-01')`);
      await db.execute(sql`insert into hrm_benefit_enrollments(id,org_id,employment_id,plan_id,status,effective_from,currency)
      values(${enrollmentId},${fx.orgId},${employmentId},${benefitPlanId},'elected','2026-01-01','CAD')`);
      const contribution = randomUUID();
      await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,expense_account_id,liability_account_id)
      values(${contribution},${fx.orgId},'SPLIT-PENSION-ER','Pension employer','employer_contribution','CA',true,true,true,false,'none','cash',${fx.accounts.burdenExpense},${fx.accounts.otherPayable})`);
      await db.execute(sql`insert into hrm_benefit_contribution_rules(id,org_id,plan_id,rule_key,name,kind,pay_component_id,basis,rate,rate_formula,hours_basis,
      proration,effective_from,run_applicability)
      values(${ruleId},${fx.orgId},${benefitPlanId},'SPLIT-PENSION-ER','Pension employer','employer_contribution',${contribution},'per_hour',0,'elected_rate','selected_components','none','2026-01-01','all_pay_runs')`);
      for (const counted of [regular, payout]) {
        await db.execute(sql`insert into hrm_benefit_contribution_rule_components(org_id,plan_id,rule_id,pay_component_id)
        values(${fx.orgId},${benefitPlanId},${ruleId},${counted})`);
      }
      await db.execute(sql`insert into hrm_benefit_enrollment_terms(id,org_id,enrollment_id,rule_id,election_mode,elected_rate,effective_from,source_decimal,provenance)
      values(${randomUUID()},${fx.orgId},${enrollmentId},${ruleId},'fixed','2','2026-01-01','2','{"source":"approved payroll election"}'::jsonb)`);
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features,hrm}','true'::jsonb,true) where id=${fx.orgId}`,
      );
      await submitBenefitEnrollmentFixture(fx.orgId, fx.actorId, enrollmentId);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount,hours)
      values(${fx.orgId},${run.documentId},${partyId},'line',${regular},'46','1')`);
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input",
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
        },
      });
      const result = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.deepEqual(
        result.errors,
        [],
        "the outside portion at explicit zero hours raises no missing-hours refusal",
      );
      const allocation = await db.execute<{ amount: string; hours: string }>(
        sql`select amount::text,
        source_snapshot#>>'{basis,hours}' as hours from pay_run_benefit_allocations
      where org_id=${fx.orgId} and pay_run_document_id=${run.documentId} and rule_id=${ruleId}`,
        "objects",
      );
      assert.deepEqual(
        allocation,
        [{ amount: "18.0000", hours: "9.0000" }],
        "one regular hour plus eight bank-funded hours count once; the outside cash adds zero",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a split valued from a foreign-currency wage refuses until the wage matches the run currency",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const { partyId } = await employee(fx, "Split Currency Employee", fx.subsidiaryId);
      // Numerically the wage is exactly the split's bank valuation; only its
      // currency differs from the CAD run. A spot rate lets the general wage
      // path proceed, so the refusal observed is the split's own binding.
      await db.execute(sql`update labor_cost_rates set rate='46',currency='USD'
      where org_id=${fx.orgId} and employee_party_id=${partyId}`);
      await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${fx.orgId}, 'USD', 'CAD', '2026-01-01', 'spot', '1')`);
      const payout = await earningComponent(fx, "SPLIT-CURRENCY");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans
      (id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
       liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'SPLITCURRENCY','Accrued pay','money','accrue','manual',${payout},
        ${fx.accounts.vacationPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      await opening(fx, planId, partyId, "552", null);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "bank_cash_input",
          employeePartyId: partyId,
          componentId: payout,
          hours: "8.00",
          rate: "143.83",
          amount: "1150.64",
          outsideBankAmount: "782.64",
          reason: "Approved withdrawal with independently paid cash",
          sourceReference: "Payroll source document 7",
          idempotencyKey: randomUUID(),
        },
      });
      const refused = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(refused.errors.length, 1);
      assert.match(refused.errors[0]!.message, /valued from a USD wage, but this pay run pays CAD/);
      assert.equal(
        (
          await db.execute(
            sql`select id from pay_stubs where org_id=${fx.orgId}
      and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
        "the refused split leaves no stub",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from entitlement_ledger where org_id=${fx.orgId}
      and plan_id=${planId} and pay_run_document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
        "the refused split moves no bank money",
      );
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "552.0000");
      await db.execute(sql`update labor_cost_rates set currency='CAD'
      where org_id=${fx.orgId} and employee_party_id=${partyId}`);
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
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-21"), "552.0000");
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId });
      assert.equal(
        await balanceOf(fx, partyId, planId, "2026-07-21"),
        "184.0000",
        "the same split commits once the native wage is denominated in the run currency",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a deposit into a liability-carrying bank credits the plan liability and a later withdrawal relieves it",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52,subsidiary_id=${fx.subsidiaryId} where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Banked Cash Employee", fx.subsidiaryId);
      const cash = await earningComponent(fx, "BANKEDCASH");
      const planId = randomUUID();
      await db.execute(sql`insert into entitlement_plans(id,org_id,code,name,unit,direction,accrual_method,payout_component_id,
      liability_account_id,cap_behavior,is_active,created_by,updated_by)
      values(${planId},${fx.orgId},'BANKEDCASH','Banked cash','money','accrue','manual',${cash},
        ${fx.accounts.otherPayable},'warn',true,${fx.actorId},${fx.actorId})`);
      const settlementLines = async (documentId: string) =>
        await db.execute<{
          amount: string;
          expense_account_id: string;
          expense_account_source: string;
        }>(
          sql`
      select l.amount::text as amount, l.expense_account_id::text as expense_account_id, l.expense_account_source
        from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
       where s.org_id=${fx.orgId} and s.pay_run_document_id=${documentId} and l.component_id=${cash}`,
          "objects",
        );
      const reliefLegs = async (documentId: string) =>
        await db.execute<{ account_id: string; amount: string; payroll_expense: boolean }>(
          sql`
      select account_id::text as account_id, amount::text as amount, (custom->>'payrollExpense')::boolean as payroll_expense
        from document_lines where org_id=${fx.orgId} and document_id=${documentId} and custom->>'legKind'='entitlement_relief'`,
          "objects",
        );

      await hours(fx, partyId, ["2026-07-13", "2026-07-14"]);
      const first = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await mutatePayRunAdjustment({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: first.documentId,
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
        mutation: {
          action: "add",
          employeePartyId: partyId,
          componentId: cash,
          amount: "-60",
          hours: "-2",
          note: "Cash earnings transferred to the money bank",
        },
      });
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: first.documentId,
          })
        ).errors,
        [],
      );
      assert.deepEqual(await settlementLines(first.documentId), [
        {
          amount: "-60.0000",
          expense_account_id: fx.accounts.otherPayable,
          expense_account_source: "entitlement_plan",
        },
      ]);
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: first.documentId });
      assert.deepEqual(
        await reliefLegs(first.documentId),
        [{ account_id: fx.accounts.otherPayable, amount: "-60.0000", payroll_expense: false }],
        "the deposit is carried in the plan liability",
      );

      await hours(fx, partyId, ["2026-07-20"]);
      const second = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19",
        periodEnd: "2026-07-25",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${second.documentId},${partyId},'line',${cash},'60')`);
      assert.deepEqual(
        (
          await calculatePayRun({
            orgId: fx.orgId,
            actorId: fx.actorId,
            documentId: second.documentId,
          })
        ).errors,
        [],
      );
      await commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: second.documentId });
      assert.deepEqual(
        await reliefLegs(second.documentId),
        [{ account_id: fx.accounts.otherPayable, amount: "60.0000", payroll_expense: false }],
        "the withdrawal relieves exactly what was deposited",
      );
      assert.equal(await balanceOf(fx, partyId, planId, "2026-07-28"), "0.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an accruing plan without a liability account refuses to pay from its bank instead of expensing the accrual twice",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Unbound Vacation Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await db.execute(
        sql`update entitlement_plans set liability_account_id=null where org_id=${fx.orgId} and id=${plan.id}`,
      );
      await opening(fx, plan.id, partyId, "500", null);
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'100')`);
      const refused = await calculatePayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        documentId: run.documentId,
      });
      assert.equal(refused.errors.length, 1);
      assert.match(
        refused.errors[0]!.message,
        /accrues a liability but names no liability account/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "re-pointing a settled plan liability after calculation stales the run instead of committing the old account",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await db.execute(
        sql`update pay_schedules set frequency='weekly',periods_per_year=52 where org_id=${fx.orgId} and id=${fx.scheduleId}`,
      );
      const { partyId } = await employee(fx, "Repointed Bank Employee");
      const plan = (
        await db.execute<{ id: string; payout_component_id: string }>(
          sql`select id,payout_component_id
      from entitlement_plans where org_id=${fx.orgId} and system_key='vacation'`,
          "objects",
        )
      )[0]!;
      await opening(fx, plan.id, partyId, "500", null);
      await hours(fx, partyId, ["2026-07-13"]);
      const run = await createPayRun({
        orgId: fx.orgId,
        actorId: fx.actorId,
        payScheduleId: fx.scheduleId,
        periodStart: "2026-07-12",
        periodEnd: "2026-07-18",
      });
      await db.execute(sql`insert into pay_run_adjustments(org_id,pay_run_document_id,employee_party_id,adjustment_type,component_id,amount)
      values(${fx.orgId},${run.documentId},${partyId},'line',${plan.payout_component_id},'100')`);
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
      await db.execute(
        sql`update entitlement_plans set liability_account_id=${fx.accounts.otherPayable} where org_id=${fx.orgId} and id=${plan.id}`,
      );
      await assert.rejects(
        commitPayRun({ orgId: fx.orgId, actorId: fx.actorId, documentId: run.documentId }),
        /changed/,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from document_lines where org_id=${fx.orgId} and document_id=${run.documentId}`,
            "objects",
          )
        ).length,
        0,
        "a stale settlement account writes no projection",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
