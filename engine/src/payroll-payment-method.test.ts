import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { payRunBankFilePopulation } from "./payroll-bank-file.ts";
import { amountInWords, issuePayRunCheques, payRunCheques } from "./payroll-cheques.ts";
import {
  PAYROLL_PAYMENT_METHODS,
  resolvePayrollPaymentMethod,
  resolvedPaymentMethodSql,
  payrollPaymentMethodSettings,
  stubPaymentMethods,
} from "./payroll-payment-method.ts";
import { payRunFunding, payRunReadiness } from "./payroll-readiness.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { createScratchOrg, seedFlowActors } from "./test-fixtures.ts";

/**
 * How an employee gets paid, end to end.
 *
 * The rule under test is that no employee is ever left without a payment
 * route, and that the two rails PARTITION the run: everyone is on exactly one
 * of the bank file and the cheque batch, never both and never neither. That
 * partition is what stops somebody being paid twice.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* The resolution ladder                                               */
/* ------------------------------------------------------------------ */

const resolve = (input: {
  profileMethod?: string | null;
  partyMethod?: string | null;
  hasApprovedBankDetails?: boolean;
  fallbackToCheque?: boolean;
}) => resolvePayrollPaymentMethod({
  profileMethod: input.profileMethod ?? null,
  partyMethod: input.partyMethod ?? null,
  hasApprovedBankDetails: input.hasApprovedBankDetails ?? false,
  fallbackToCheque: input.fallbackToCheque ?? true,
});

test("nothing configured: bank details decide, and the answer is never nothing", () => {
  assert.deepEqual(resolve({ hasApprovedBankDetails: true }), {
    method: "eft", configured: "eft", source: "default",
    missingBankDetails: false, unpayable: false,
  });
  // THE case this whole module exists for: no bank details is not an error,
  // it is a cheque.
  assert.deepEqual(resolve({ hasApprovedBankDetails: false }), {
    method: "cheque", configured: "cheque", source: "default",
    missingBankDetails: false, unpayable: false,
  });
});

test("the payroll override on the profile wins over the party preference", () => {
  const cheque = resolve({ profileMethod: "cheque", partyMethod: "eft", hasApprovedBankDetails: true });
  assert.equal(cheque.method, "cheque");
  assert.equal(cheque.source, "profile");
  // An employee who holds approved bank details but is paid by cheque must NOT
  // be credited as well — that is the double-pay this override protects.
  assert.equal(cheque.missingBankDetails, false);

  const eft = resolve({ profileMethod: "eft", partyMethod: "cash", hasApprovedBankDetails: true });
  assert.equal(eft.method, "eft");
  assert.equal(eft.source, "profile");
});

test("non-payroll party methods mean paper, and can never promote onto EFT", () => {
  for (const partyMethod of ["cheque", "card", "cash", "other"]) {
    const resolved = resolve({ partyMethod, hasApprovedBankDetails: true });
    assert.equal(resolved.method, "cheque", `${partyMethod} must not become EFT`);
    assert.equal(resolved.source, "party");
  }
  assert.equal(resolve({ partyMethod: "eft", hasApprovedBankDetails: true }).method, "eft");
});

test("configured EFT with no bank details falls back to cheque, and says so", () => {
  const fallback = resolve({ partyMethod: "eft", hasApprovedBankDetails: false });
  assert.equal(fallback.method, "cheque");
  assert.equal(fallback.configured, "eft");
  assert.equal(fallback.source, "eftFallback");
  assert.equal(fallback.missingBankDetails, true);
  // Advisory, not broken: the employee is getting paid.
  assert.equal(fallback.unpayable, false);
});

test("with the fallback turned off the same employee is unpayable, not silently rerouted", () => {
  const blocked = resolve({ partyMethod: "eft", hasApprovedBankDetails: false, fallbackToCheque: false });
  assert.equal(blocked.method, "eft");
  assert.equal(blocked.missingBankDetails, true);
  assert.equal(blocked.unpayable, true);
});

test("every input combination resolves to one of the two rails", () => {
  for (const profileMethod of [null, "eft", "cheque", "nonsense"]) {
    for (const partyMethod of [null, "", "eft", "cheque", "card", "cash", "other"]) {
      for (const hasApprovedBankDetails of [true, false]) {
        for (const fallbackToCheque of [true, false]) {
          const resolved = resolve({
            profileMethod, partyMethod, hasApprovedBankDetails, fallbackToCheque,
          });
          assert.ok(
            (PAYROLL_PAYMENT_METHODS as readonly string[]).includes(resolved.method),
            `no rail for ${profileMethod}/${partyMethod}/${hasApprovedBankDetails}`,
          );
          // An unpayable employee is ALWAYS reported as such; the caller must
          // never have to infer it from the absence of bank details.
          assert.equal(resolved.unpayable, resolved.missingBankDetails && !fallbackToCheque);
        }
      }
    }
  }
});

test("amount in words agrees with the figures to the cent", () => {
  assert.equal(amountInWords("0.00"), "Zero and 00/100");
  assert.equal(amountInWords("1.05"), "One and 05/100");
  assert.equal(amountInWords("1234.56"), "One thousand two hundred thirty-four and 56/100");
  assert.equal(amountInWords("1000000.00"), "One million and 00/100");
  assert.equal(amountInWords("2400.5"), "Two thousand four hundred and 50/100");
  assert.equal(amountInWords("115.0000"), "One hundred fifteen and 00/100");
});

/* ------------------------------------------------------------------ */
/* The SQL fragment must agree with the function                       */
/* ------------------------------------------------------------------ */

test("the SQL ladder gives the same answer as the resolver", { skip: !DB }, async () => {
  for (const fallbackToCheque of [true, false]) {
    for (const profileMethod of [null, "eft", "cheque"]) {
      for (const partyMethod of [null, "eft", "cheque", "card", "cash", "other"]) {
        for (const hasBank of [true, false]) {
          const expression = resolvedPaymentMethodSql({
            profileMethod: sql`${profileMethod}::text`,
            partyMethod: sql`${partyMethod}::text`,
            hasBank: sql`${hasBank}::boolean`,
            fallbackToCheque,
          });
          const row = (await db.execute<{ method: string }>(
            sql`select ${expression} as method`,
          ));
          assert.equal(
            row.rows[0]!.method,
            resolve({ profileMethod, partyMethod, hasApprovedBankDetails: hasBank, fallbackToCheque }).method,
            `SQL disagrees for ${profileMethod}/${partyMethod}/bank=${hasBank}/fallback=${fallbackToCheque}`,
          );
        }
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* The run: a mixed population splits cleanly                          */
/* ------------------------------------------------------------------ */

interface Fixture {
  orgId: string; subsidiaryId: string; actorId: string; scheduleId: string;
  accounts: Record<string, string>;
}

const account = async (orgId: string, number: string, name: string, type: string) => {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
};

async function payrollOrg(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const accounts = {
    wageExpense: await account(org.orgId, "6000", "Wages expense", "expense"),
    burdenExpense: await account(org.orgId, "6010", "Payroll burden", "expense"),
    netPayable: await account(org.orgId, "2300", "Wages payable", "liability_current"),
    craPayable: await account(org.orgId, "2310", "CRA payable", "liability_current"),
    vacationPayable: await account(org.orgId, "2320", "Vacation payable", "liability_current"),
  };
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: accounts.wageExpense,
        burdenExpenseAccountId: accounts.burdenExpense,
        netPayAccountId: accounts.netPayable,
        cppPayableAccountId: accounts.craPayable,
        eiPayableAccountId: accounts.craPayable,
        taxPayableAccountId: accounts.craPayable,
        vacationPayableAccountId: accounts.vacationPayable,
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
  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, accounts };
}

async function employee(fx: Fixture, name: string, opts: {
  partyMethod?: string | null;
  profileMethod?: string | null;
  approvedBank?: boolean;
} = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, payment_method, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, true, ${opts.partyMethod ?? null}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${fx.orgId}, ${id})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, payment_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'ON', 'hourly', 1, 1, '4', 'accrue',
            ${opts.profileMethod ?? null}, true, ${fx.actorId}, ${fx.actorId})`);
  if (opts.approvedBank) {
    await db.execute(sql`
      insert into party_bank_accounts (org_id, party_id, bank_name, country, currency,
                                       account_last_four, approval_status, is_active,
                                       created_by, updated_by)
      values (${fx.orgId}, ${id}, 'Test Bank', 'CA', 'CAD', '1234', 'approved', true,
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

const hours = async (fx: Fixture, employeeId: string, workedOn: string, qty: string) =>
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${workedOn}, ${qty}, 'approved',
            false, 'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);

test(
  "a mixed run puts EFT employees on the bank file and cheque employees on paper — never both",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    // Four rails, on purpose: an explicit EFT, an employee with no preference
    // and no bank details (cheque by default), a payroll override that keeps
    // somebody on paper DESPITE holding approved bank details, and an EFT
    // employee whose void cheque was never keyed (falls back to paper).
    const wired = await employee(fx, "Ada Wired", { partyMethod: "eft", approvedBank: true });
    const paper = await employee(fx, "Bo Paper");
    const overridden = await employee(fx, "Cy Override", {
      partyMethod: "eft", profileMethod: "cheque", approvedBank: true,
    });
    const stranded = await employee(fx, "Di Stranded", { partyMethod: "eft" });
    for (const id of [wired, paper, overridden, stranded]) {
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(fx, id, day, "20");
      }
    }

    const run = await createPayRun({
      orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    const calc = await calculatePayRun({
      orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
    });
    assert.deepEqual(calc.errors, []);
    assert.equal(calc.employees, 4);

    const rails = new Map(
      (await stubPaymentMethods(fx.orgId, run.documentId)).map((s) => [s.employeePartyId, s]),
    );
    assert.equal(rails.get(wired)!.method, "eft");
    assert.equal(rails.get(paper)!.method, "cheque");
    assert.equal(rails.get(overridden)!.method, "cheque");
    assert.equal(rails.get(stranded)!.method, "cheque");

    // The bank file carries the EFT employee and NOBODY else. Crediting the
    // override employee's account as well as handing them a cheque would pay
    // them twice — that is the defect this split exists to prevent.
    const file = await payRunBankFilePopulation(fx.orgId, run.documentId);
    assert.deepEqual(file.entries.map((e) => e.employeePartyId), [wired]);
    assert.deepEqual(
      file.excludedCheque.map((e) => e.employeePartyId).sort(),
      [paper, overridden, stranded].sort(),
    );

    // The two rails partition the run and reconcile to its net pay.
    const funding = await payRunFunding(fx.orgId, run.documentId);
    const eft = funding.rails.find((r) => r.method === "eft")!;
    const cheque = funding.rails.find((r) => r.method === "cheque")!;
    assert.equal(eft.employees, 1);
    assert.equal(cheque.employees, 3);
    assert.equal(
      Number(eft.netPay) + Number(cheque.netPay),
      Number(funding.netPay),
    );
    assert.equal(Number(eft.netPay), Number(file.total));

    // Readiness: three employees have no bank details and exactly ONE of them
    // is worth a word — the one the employer meant to pay by EFT.
    const readiness = await payRunReadiness(fx.orgId, run.documentId);
    const noBank = readiness.items.find((i) => i.code === "employee.noBankDetails");
    assert.equal(noBank?.severity, "warning");
    assert.deepEqual(noBank?.employees.map((e) => e.partyId), [stranded]);
    assert.equal(readiness.items.some((i) => i.code === "employee.eftNoBankDetails"), false);

    // Turning the safety net off makes the same employee a blocker instead.
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{payroll,eftFallbackToCheque}', 'false'::jsonb)
       where id = ${fx.orgId}`);
    assert.equal((await payrollPaymentMethodSettings(fx.orgId)).eftFallbackToCheque, false);
    const strict = await payRunReadiness(fx.orgId, run.documentId);
    const blocker = strict.items.find((i) => i.code === "employee.eftNoBankDetails");
    assert.equal(blocker?.severity, "blocker");
    assert.deepEqual(blocker?.employees.map((e) => e.partyId), [stranded]);
    assert.equal(strict.items.some((i) => i.code === "employee.noBankDetails"), false);
    await db.execute(sql`
      update orgs set settings = settings #- '{payroll,eftFallbackToCheque}' where id = ${fx.orgId}`);

    // Cheques: numbers come off the org's number_sequences, one per cheque
    // employee, and re-issuing reprints rather than burning stock.
    await assert.rejects(
      issuePayRunCheques({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId }),
      /commit the pay run/,
    );
    await commitPayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
    const batch = await issuePayRunCheques({
      orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
    });
    assert.equal(batch.issued, 3);
    assert.deepEqual(batch.cheques.map((c) => c.chequeNumber), ["CHQ-00001", "CHQ-00002", "CHQ-00003"]);
    assert.equal(Number(batch.total), Number(cheque.netPay));
    assert.equal(batch.cheques.some((c) => c.employeePartyId === wired), false);

    const again = await issuePayRunCheques({
      orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
    });
    assert.equal(again.issued, 0);
    assert.deepEqual(again.cheques.map((c) => c.chequeNumber), batch.cheques.map((c) => c.chequeNumber));
    assert.deepEqual(
      (await payRunCheques(fx.orgId, run.documentId)).cheques.map((c) => c.chequeNumber),
      batch.cheques.map((c) => c.chequeNumber),
    );
  },
);
