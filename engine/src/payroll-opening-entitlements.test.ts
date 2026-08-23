import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp } from "./money.ts";
import {
  entitlementBalances,
  EntitlementOpeningSaveError,
  entitlementOpenings,
  saveEntitlementOpenings,
} from "./payroll-entitlements.ts";
import { saveOpeningBalances } from "./payroll-opening-balances.ts";
import { payRunReadiness } from "./payroll-readiness.ts";
import { calculatePayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Mid-year adoption, third dimension: the bank balances an employee arrives
 * holding.
 *
 * Vacation moved onto the entitlement ledger, which left
 * `payroll_opening_balances.vacation_balance` dead to the engine and NO load
 * path in its place. Every bank therefore started at zero on adoption: the
 * balance sheet understated a real liability, and a termination in the first
 * year paid out only what had accrued since. For a ten-year employee that is
 * most of their entitlement, and nothing anywhere said so.
 *
 * Each test names the money failure it prevents, and every one of them fails
 * against the code as it stood before this change (there was no
 * `saveEntitlementOpenings`, no readiness signal, and the append-only trigger
 * made a correctable typo permanent).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface BankFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
  vacationPlanId: string;
  bankedPlanId: string;
  recoupPlanId: string;
  payoutComponentId: string;
}

async function seedBanks(): Promise<BankFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

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
  const netPayable = await account("2300", "Wages payable", "liability_current_other");
  const craPayable = await account("2310", "CRA remittances payable", "liability_current_other");
  const vacationPayable = await account("2320", "Vacation payable", "liability_current_other");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
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

  const components = (await db.execute<{ accrual_id: string; payout_id: string }>(sql`
    select (array_agg(id order by created_at, id)
              filter (where system_key = 'vacation_accrual'))[1] as accrual_id,
           (array_agg(id order by created_at, id)
              filter (where system_key = 'vacation_payout'))[1] as payout_id
      from pay_components where org_id = ${org.orgId}
  `));
  const accrualComponentId = components.rows[0]!.accrual_id;
  const payoutComponentId = components.rows[0]!.payout_id;

  const plan = async (
    code: string,
    name: string,
    extra: { systemKey?: string; direction?: string; method?: string; value?: string } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into entitlement_plans (id, org_id, code, name, unit, direction, accrual_method,
                                     accrual_value, accrual_component_id, payout_component_id,
                                     liability_account_id, system_key, cap_behavior, is_active,
                                     created_by, updated_by)
      values (${id}, ${org.orgId}, ${code}, ${name}, 'money', ${extra.direction ?? "accrue"},
              ${extra.method ?? "manual"}, ${extra.value ?? null}, ${accrualComponentId},
              ${payoutComponentId}, ${vacationPayable}, ${extra.systemKey ?? null}, 'warn', true,
              ${actorId}, ${actorId})`);
    return id;
  };
  // seedPayrollComponents already provisions the pack's VAC plan on its ENGINE
  // BINDING (payroll-run.ts `ensureVacationPlan`). Reuse it rather than seeding a
  // second one: `entitlement_plans_org_system` allows only one plan per org to
  // claim a system key, and inventing a parallel vacation plan here would test a
  // shape no tenant has.
  const vacation = (await db.execute<{ id: string }>(sql`
    select id from entitlement_plans
     where org_id = ${org.orgId} and system_key = 'vacation'
  `));
  const vacationPlanId = vacation.rows[0]!.id;
  const bankedPlanId = await plan("BANK", "Banked overtime");
  const recoupPlanId = await plan("RECOUP", "Benefit recoup", {
    direction: "owe", method: "fixed_per_period", value: "100.0000",
  });

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeName = "Terry Worker";
  const employeeId = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId }, { name: employeeName },
  );

  return {
    orgId: org.orgId, actorId, subsidiaryId: org.subsidiaryId, scheduleId,
    employeeId, employeeName, vacationPlanId, bankedPlanId, recoupPlanId, payoutComponentId,
  };
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string },
  options: { name: string; hiredOn?: string; terminatedOn?: string },
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, terminated_on, is_active,
                               created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2016-01-06"},
            ${options.terminatedOn ?? null}, true, ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2016-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${fx.scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${fx.actorId}, ${fx.actorId})`);
  return employeeId;
}

async function seedRun(
  fx: BankFixture,
  options: {
    periodStart?: string; periodEnd?: string; payDate?: string;
    runStatus?: string; runType?: string;
  } = {},
): Promise<string> {
  const documentId = randomUUID();
  const payDate = options.payDate ?? "2026-07-21";
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${fx.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${fx.subsidiaryId}, ${payDate}, 'CAD', 'draft', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, run_type, calculated_at, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, ${fx.scheduleId}, ${options.periodStart ?? "2026-07-05"},
            ${options.periodEnd ?? "2026-07-18"}, ${payDate}, 2026,
            ${options.runStatus ?? "calculated"}, ${options.runType ?? "regular"}, now(),
            ${fx.actorId}, ${fx.actorId})`);
  return documentId;
}

/** A committed stub, which is what freezes a carry-in dated on or before it. */
async function seedCommittedStub(fx: BankFixture, payDate: string): Promise<string> {
  const documentId = await seedRun(fx, {
    periodStart: payDate, periodEnd: payDate, payDate, runStatus: "committed",
  });
  await db.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                           factors, created_by, updated_by)
    values (${fx.orgId}, ${documentId}, ${fx.employeeId}, 'ON', 26, ${payDate}, 2026, 'CAD',
            '2400', '1900', '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);
  return documentId;
}

/** The PostgreSQL message behind Drizzle's wrapper, which carries only the SQL. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return String((cause as { message?: unknown })?.message ?? (error as Error)?.message ?? error);
}

const bankItem = (readiness: Awaited<ReturnType<typeof payRunReadiness>>) =>
  readiness.items.filter((item) => item.code === "employee.noOpeningEntitlement");

/* ------------------------------------------------------------------ */
/* A carry-in becomes a balance, and a final pay pays it out           */
/* ------------------------------------------------------------------ */

test(
  "a carried-in vacation bank is the employee's balance and is paid out on a termination run",
  { skip: !DB },
  async () => {
    // The whole defect: with no load path a ten-year employee's accrued vacation
    // was zero on adoption, so their final cheque paid out only the weeks
    // accrued since — and the liability quietly left the books.
    const fx = await seedBanks();
    try {
      const saved = await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { VAC: "6200.00", BANK: "1450.50" },
        }],
      });
      assert.equal(saved.created, 2);
      assert.deepEqual(saved.errors, []);

      // Balance = SUM(ledger). Nothing else is ever the balance.
      const balances = await entitlementBalances(fx.orgId, fx.employeeId, "2026-07-21");
      const byCode = new Map(balances.map((b) => [b.plan.code, b]));
      assert.equal(byCode.get("VAC")!.balance, "6200.0000");
      assert.equal(byCode.get("BANK")!.balance, "1450.5000");
      // The movement is an `opening`, written through the ledger, not a column.
      const kinds = (await db.execute<{ kind: string; n: number }>(sql`
        select kind, count(*)::int as n from entitlement_ledger
         where org_id = ${fx.orgId} group by kind`));
      assert.deepEqual(kinds.rows, [{ kind: "opening", n: 2 }]);

      // A final pay must clear every accrued bank — with the carry-in in it.
      await db.execute(sql`
        update employee_roles set terminated_on = '2026-07-18'
         where org_id = ${fx.orgId} and party_id = ${fx.employeeId}`);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
        runType: "termination", employeePartyIds: [fx.employeeId],
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);

      const payouts = (await db.execute<{ description: string; amount: string }>(sql`
        select l.description, l.amount::text as amount
          from pay_stub_lines l
          join pay_stubs s on s.id = l.stub_id
         where s.org_id = ${fx.orgId} and s.pay_run_document_id = ${run.documentId}
           and l.component_id = ${fx.payoutComponentId} and l.description like '%payout%'
         order by l.description`));
      const paid = new Map(payouts.rows.map((r) => [r.description, r.amount]));
      assert.equal(
        paid.get("Banked overtime payout (accrued balance)"), "1450.5000",
        `expected the carried-in bank on the final cheque, got ${[...paid].join(", ")}`,
      );
      assert.equal(paid.get("Vacation payout (accrued balance)"), "6200.0000");

      // And the bank is left at exactly zero, not at the carry-in.
      const after = await entitlementBalances(fx.orgId, fx.employeeId, "2026-07-21");
      for (const balance of after) {
        if (balance.plan.direction !== "accrue") continue;
        assert.equal(
          cmp(balance.balance, "0"), 0,
          `${balance.plan.code} still carries ${balance.balance} after a final pay`,
        );
      }
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "zero clears a carry-in, and a sign that contradicts the plan's direction is refused",
  { skip: !DB },
  async () => {
    const fx = await seedBanks();
    try {
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6200" } }],
      });
      const cleared = await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "0" } }],
      });
      assert.equal(cleared.deleted, 1);
      assert.equal((await entitlementOpenings(fx.orgId)).entered, 0);

      // An 'owe' balance entered positive would be a CREDIT the employee never
      // had. Refused with the number to enter instead, never silently negated.
      await assert.rejects(
        saveEntitlementOpenings({
          orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
          rows: [{ employeePartyId: fx.employeeId, amounts: { RECOUP: "1200" } }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof EntitlementOpeningSaveError);
          assert.match(error.message, /must be negative \(enter -1200/);
          return true;
        },
      );
      await assert.rejects(
        saveEntitlementOpenings({
          orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
          rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "-100" } }],
        }),
        /cannot be negative/,
      );
      // Nothing partial: the refused load wrote nothing.
      assert.equal((await entitlementOpenings(fx.orgId)).entered, 0);

      // An owe balance with the right sign is accepted and IS the balance.
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { RECOUP: "-1200" } }],
      });
      const recoup = (await entitlementBalances(fx.orgId, fx.employeeId, "2026-07-21"))
        .find((b) => b.plan.code === "RECOUP")!;
      assert.equal(recoup.balance, "-1200.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* Immutability, in the service AND in the database                    */
/* ------------------------------------------------------------------ */

test(
  "a carry-in a committed run has read is frozen — refused by the service and by the trigger",
  { skip: !DB },
  async () => {
    // A carry-in inside a committed run's balance is inside a cheque. Editing it
    // restates money that has already been paid, so correcting it is a
    // void-and-restate exercise. The control is enforced twice on purpose: a
    // service-only rule is not a rule, because the ledger has other writers.
    const fx = await seedBanks();
    try {
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6200" } }],
      });
      const before = await entitlementOpenings(fx.orgId);
      assert.equal(before.rows[0]!.amounts[fx.vacationPlanId], "6200.0000");
      assert.equal(before.rows[0]!.locked[fx.vacationPlanId], undefined);

      // Until a run reads it, a typo is correctable — no void required.
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6250" } }],
      });
      assert.equal(
        (await entitlementOpenings(fx.orgId)).rows[0]!.amounts[fx.vacationPlanId], "6250.0000",
      );

      await seedCommittedStub(fx, "2026-07-21");

      const locked = await entitlementOpenings(fx.orgId);
      assert.equal(locked.rows[0]!.locked[fx.vacationPlanId]?.payDate, "2026-07-21");

      await assert.rejects(
        saveEntitlementOpenings({
          orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
          rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "1" } }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof EntitlementOpeningSaveError);
          assert.match(error.message, /already used the VAC carry-in/);
          return true;
        },
      );
      assert.equal(
        (await entitlementOpenings(fx.orgId)).rows[0]!.amounts[fx.vacationPlanId], "6250.0000",
        "a refused save must leave the carry-in exactly as it was",
      );

      // The database refuses the same thing, so a script cannot walk around it.
      // Drizzle wraps the driver error and puts the QUERY in `message`, so the
      // assertion has to read the cause — matching on `message` passes for any
      // failure at all, which is a test that cannot fail for the right reason.
      await assert.rejects(
        db.execute(sql`
          delete from entitlement_ledger
           where org_id = ${fx.orgId} and plan_id = ${fx.vacationPlanId} and kind = 'opening'`),
        (error: unknown) => {
          assert.match(pgMessage(error), /already been consumed by a committed pay run/);
          return true;
        },
      );
      // And an UPDATE is refused unconditionally — a movement is never rewritten.
      await assert.rejects(
        db.execute(sql`
          update entitlement_ledger set amount = '1'
           where org_id = ${fx.orgId} and kind = 'opening'`),
        (error: unknown) => {
          assert.match(pgMessage(error), /append-only/);
          return true;
        },
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a NEW carry-in dated on or before a committed pay run is refused, not silently backdated",
  { skip: !DB },
  async () => {
    // The other half of the same rule. Inserting a carry-in behind a committed
    // run changes the balance that run's stub was computed from, and no
    // recalculation can put it back — the stub is history.
    const fx = await seedBanks();
    try {
      await seedCommittedStub(fx, "2026-07-21");
      const view = await entitlementOpenings(fx.orgId, { asOf: "2026-07-01" });
      assert.equal(view.blocked[fx.employeeId]?.payDate, "2026-07-21");

      await assert.rejects(
        saveEntitlementOpenings({
          orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
          rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6200" } }],
        }),
        /already paid this employee on or after 2026-07-01/,
      );

      // Dated after the run, the same carry-in is legitimate and accepted.
      const ok = await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-22",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6200" } }],
      });
      assert.equal(ok.created, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* The readiness warning fires exactly when it should                  */
/* ------------------------------------------------------------------ */

test(
  "the run that first moves a plan warns about employees who carried in elsewhere",
  { skip: !DB },
  async () => {
    const fx = await seedBanks();
    try {
      const documentId = await seedRun(fx);

      // A brand-new employer has no carry-in anywhere, so there is nothing to
      // have forgotten and NOTHING is flagged. This is the same doctrine the
      // statutory warning follows.
      assert.deepEqual(bankItem(await payRunReadiness(fx.orgId, documentId)), []);

      // A statutory carry-in is the evidence that this employer was paying this
      // person before OpenBooks — so a zero vacation bank is almost certainly
      // wrong, and now is the only cheap moment to say so.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "84000" } }],
      });
      const warned = bankItem(await payRunReadiness(fx.orgId, documentId));
      assert.equal(warned.length, 3, `one per plan, got ${warned.map((w) => w.detail).join(", ")}`);
      for (const item of warned) {
        assert.equal(item.severity, "warning", "never a blocker — zero can be correct");
        assert.deepEqual(item.employees.map((e) => e.name), [fx.employeeName]);
        assert.equal(item.href, "/payroll/opening-balances?section=entitlements");
      }
      assert.deepEqual(
        warned.map((w) => w.detail).sort(),
        ["Banked overtime", "Benefit recoup", "Vacation"],
      );

      // Loading the carry-in settles that plan, and only that plan.
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-07-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "6200" } }],
      });
      assert.deepEqual(
        bankItem(await payRunReadiness(fx.orgId, documentId)).map((w) => w.detail).sort(),
        ["Banked overtime", "Benefit recoup"],
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "once a committed run has moved a plan, its carry-in question is settled forever",
  { skip: !DB },
  async () => {
    // Asking again on every payday is noise the operator learns to click past,
    // and by then the answer cannot be changed anyway: the accrual is already
    // sitting on top of whatever opening exists.
    const fx = await seedBanks();
    try {
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "84000" } }],
      });
      const documentId = await seedRun(fx);
      assert.ok(bankItem(await payRunReadiness(fx.orgId, documentId)).length > 0);

      const earlier = await seedCommittedStub(fx, "2026-06-23");
      await db.execute(sql`
        insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date, amount,
                                        kind, pay_run_document_id, created_by, updated_by)
        values (${fx.orgId}, ${fx.vacationPlanId}, ${fx.employeeId}, '2026-06-23', '96.00',
                'accrual', ${earlier}, ${fx.actorId}, ${fx.actorId})`);

      assert.deepEqual(
        bankItem(await payRunReadiness(fx.orgId, documentId)).map((w) => w.detail).sort(),
        ["Banked overtime", "Benefit recoup"],
        "only the plan a committed run has moved goes quiet",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an employee with no carry-in anywhere is not named — they are simply a new hire",
  { skip: !DB },
  async () => {
    const fx = await seedBanks();
    try {
      const newHire = await seedEmployee(fx, { name: "Newly Hired", hiredOn: "2026-07-06" });
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "84000" } }],
      });
      const documentId = await seedRun(fx);
      const warned = bankItem(await payRunReadiness(fx.orgId, documentId));
      assert.ok(warned.length > 0);
      for (const item of warned) {
        assert.deepEqual(
          item.employees.map((e) => e.partyId), [fx.employeeId],
          "the new hire has no carry-in anywhere, so there is no evidence to act on",
        );
        assert.ok(!item.employees.some((e) => e.partyId === newHire));
      }
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* The deprecated column is surfaced, not silently dropped             */
/* ------------------------------------------------------------------ */

test(
  "an unmigrated legacy vacation_balance is surfaced as a liability nobody is tracking",
  { skip: !DB },
  async () => {
    // `payroll_opening_balances.vacation_balance` is retained (it is the input to
    // and the left-hand side of the vacation migration's penny-exact tie-out) but
    // no engine reads it. A non-zero value with no matching opening movement is
    // therefore real money that no balance shows — so it is reported here rather
    // than left to rot behind a deprecation comment.
    const fx = await seedBanks();
    try {
      await db.execute(sql`
        insert into payroll_opening_balances (org_id, employee_party_id, tax_year, vacation_balance,
                                              created_by, updated_by)
        values (${fx.orgId}, ${fx.employeeId}, 2025, '1250.5500', ${fx.actorId}, ${fx.actorId})`);
      const flagged = await entitlementOpenings(fx.orgId);
      assert.equal(flagged.rows[0]!.legacyVacationBalance, "1250.5500");

      // Once it HAS been carried in against the vacation plan, it is dealt with.
      await saveEntitlementOpenings({
        orgId: fx.orgId, actorId: fx.actorId, movementDate: "2026-01-01",
        rows: [{ employeePartyId: fx.employeeId, amounts: { VAC: "1250.55" } }],
      });
      const settled = await entitlementOpenings(fx.orgId);
      assert.equal(settled.rows[0]!.legacyVacationBalance, null);
      assert.equal(settled.rows[0]!.amounts[fx.vacationPlanId], "1250.5500");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
