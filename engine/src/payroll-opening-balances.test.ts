import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp } from "./money.ts";
import { calculateT4127 } from "./payroll/canada/t4127.ts";
import {
  normalizeOpeningBalance,
  openingBalancesForYear,
  OpeningBalanceSaveError,
  saveOpeningBalances,
} from "./payroll-opening-balances.ts";
import { payRunReadiness, payRunStaleness } from "./payroll-readiness.ts";
import { calculatePayRun, createPayRun, seedPayrollComponents } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Mid-year adoption controls.
 *
 * Each test names the money failure it prevents. Every one of them fails
 * against the code as it stood before this change: there was no write path for
 * `payroll_opening_balances` at all, no readiness signal that anybody had
 * forgotten to load one, and `worker_comp_groups` had no audit columns for
 * staleness to read.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* Validation (no database)                                            */
/* ------------------------------------------------------------------ */

test("opening balance amounts are exact money, never negative, never a transposed column", () => {
  const clean = normalizeOpeningBalance({
    pensionableYtd: "40,000.00", insurableYtd: "$40,000", cppYtd: "2380.50",
    taxableYtd: "40000", taxYtd: "6000",
  });
  assert.equal(clean.pensionableYtd, "40000.0000");
  assert.equal(clean.insurableYtd, "40000.0000");
  assert.equal(clean.cppYtd, "2380.5000");
  // Omitted amounts are an explicit zero, not undefined: the engine sums them.
  assert.equal(clean.qpipYtd, "0.0000");
  assert.equal(clean.nonPeriodicYtd, "0.0000");

  assert.throws(() => normalizeOpeningBalance({ cppYtd: "-1" }), /cannot be negative/);
  assert.throws(() => normalizeOpeningBalance({ cppYtd: "lots" }), /is not an amount/);
  // The realistic import error: CPP dollars pasted into pensionable earnings.
  assert.throws(
    () => normalizeOpeningBalance({ pensionableYtd: "2380.50", cppYtd: "40000" }),
    /exceed pensionable earnings/,
  );
  assert.throws(
    () => normalizeOpeningBalance({ insurableYtd: "100", eiYtd: "40000" }),
    /exceeds insurable earnings/,
  );
  assert.throws(
    () => normalizeOpeningBalance({ taxableYtd: "100", taxYtd: "40000" }),
    /exceeds taxable earnings/,
  );
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface AdoptionFixture {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  scheduleId: string;
  employeeId: string;
  employeeName: string;
}

async function seedEmployee(
  fx: { orgId: string; actorId: string; scheduleId: string },
  options: { name: string; hiredOn?: string } = { name: "Terry Worker" },
): Promise<string> {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${fx.orgId}, 'person', ${options.name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${options.hiredOn ?? "2020-01-06"}, true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
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

/** A Canadian org with payroll accounts, components, a schedule and one hire. */
async function seedAdoption(options: { hiredOn?: string } = {}): Promise<AdoptionFixture> {
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

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeName = "Terry Worker";
  const employeeId = await seedEmployee(
    { orgId: org.orgId, actorId, scheduleId },
    { name: employeeName, hiredOn: options.hiredOn },
  );

  return {
    orgId: org.orgId, actorId, subsidiaryId: org.subsidiaryId, scheduleId, employeeId, employeeName,
  };
}

/** A pay run on the fixture's schedule, calculated unless told otherwise. */
async function seedRun(
  fx: AdoptionFixture,
  options: {
    periodStart?: string; periodEnd?: string; payDate?: string; taxYear?: number;
    runStatus?: string; calculated?: boolean;
  } = {},
): Promise<string> {
  const documentId = randomUUID();
  const periodStart = options.periodStart ?? "2026-07-05";
  const periodEnd = options.periodEnd ?? "2026-07-18";
  const payDate = options.payDate ?? "2026-07-21";
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${fx.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${fx.subsidiaryId}, ${payDate}, 'CAD', 'draft', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, ${fx.scheduleId}, ${periodStart}, ${periodEnd}, ${payDate},
            ${options.taxYear ?? 2026}, ${options.runStatus ?? "calculated"},
            ${options.calculated === false ? null : sql`now()`}, ${fx.actorId}, ${fx.actorId})`);
  return documentId;
}

const codes = (readiness: Awaited<ReturnType<typeof payRunReadiness>>) =>
  readiness.items.map((item) => item.code);

const openingItem = (readiness: Awaited<ReturnType<typeof payRunReadiness>>) =>
  readiness.items.find((item) => item.code === "employee.noOpeningBalance");

/* ------------------------------------------------------------------ */
/* The engine actually reads what this screen writes                   */
/* ------------------------------------------------------------------ */

test(
  "an opening CPP balance near the maximum caps the first run instead of withholding a second one",
  { skip: !DB },
  async () => {
    // The whole defect: with no carry-in the engine restarts every ceiling at
    // zero, so an employer adopting in July withholds a SECOND full annual CPP
    // and EI maximum from an employee who already paid one.
    const fx = await seedAdoption();
    try {
      // Everything the prior provider withheld to 4 July, one row.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: {
            pensionableYtd: "84000.00", insurableYtd: "68000.00",
            cppYtd: "4400.00", cpp2Ytd: "0", eiYtd: "1050.00",
            taxableYtd: "84000.00", taxYtd: "21000.00",
          },
        }],
      });

      for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${fx.orgId}, ${fx.employeeId}, ${workedOn}, 20, 'approved', false,
                  'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
      }
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);

      const stub = ((await db.execute(sql`
        select gross, net_pay, factors from pay_stubs
         where org_id = ${fx.orgId} and pay_run_document_id = ${run.documentId}
      `)) as unknown as { rows: { gross: string; net_pay: string; factors: Record<string, string> }[] })
        .rows[0]!;
      assert.equal(stub.gross, "2400.0000"); // 80h × $30

      // The T4127 engine, called directly with the SAME carry-in, is the oracle.
      const withCarryIn = calculateT4127({
        payDate: "2026-07-21", province: "ON", periodsPerYear: 26,
        income: "2400.00", pensionable: "2400.00", insurable: "2400.00",
        federalClaimCode: 1, provincialClaimCode: 1,
        ytd: { cpp: "4400.0000", cpp2: "0.0000", ei: "1050.0000", pensionable: "84000.0000" },
      });
      assert.equal(stub.factors.C, withCarryIn.cpp);
      assert.equal(stub.factors.EI, withCarryIn.ei);

      // And the carry-in must actually BITE — the same period with no opening
      // balance withholds strictly more.
      const fresh = calculateT4127({
        payDate: "2026-07-21", province: "ON", periodsPerYear: 26,
        income: "2400.00", pensionable: "2400.00", insurable: "2400.00",
        federalClaimCode: 1, provincialClaimCode: 1,
      });
      assert.ok(
        cmp(add(fresh.cpp, fresh.ei), add(withCarryIn.cpp, withCarryIn.ei)) > 0,
        "an employee already at the ceiling must not be charged the full period amount again",
      );
      // Specifically: the remaining CPP room, not a whole second contribution.
      assert.ok(cmp(withCarryIn.cpp, fresh.cpp) < 0);
      assert.ok(cmp(stub.net_pay, "0") > 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* The post-commit refusal                                             */
/* ------------------------------------------------------------------ */

test(
  "an opening balance is refused once a run has committed for that employee and tax year",
  { skip: !DB },
  async () => {
    // Editing a carry-in after a commit silently restates withholding that has
    // already been taken from a cheque and remitted. Correcting it is a
    // reversal exercise, so this must refuse rather than quietly update.
    const fx = await seedAdoption();
    try {
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "40000", cppYtd: "2000" } }],
      });
      const before = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(before.rows[0]!.locked, false);
      assert.equal(before.rows[0]!.amounts?.cppYtd, "2000.0000");

      // A committed run consumes the carry-in.
      const documentId = await seedRun(fx, { runStatus: "committed" });
      await db.execute(sql`
        insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                               pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
        values (${fx.orgId}, ${documentId}, ${fx.employeeId}, 'ON', 26, '2026-07-21', 2026, 'CAD',
                '2400', '1900', '2400', '2400', '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);

      const locked = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(locked.rows[0]!.locked, true);
      assert.equal(locked.rows[0]!.lockedBy?.payDate, "2026-07-21");

      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
          rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "1", cppYtd: "1" } }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof OpeningBalanceSaveError);
          assert.match(error.message, /already used this carry-in for 2026/);
          return true;
        },
      );

      // Refused means UNCHANGED, not partially applied.
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.rows[0]!.amounts?.pensionableYtd, "40000.0000");
      assert.equal(after.rows[0]!.amounts?.cppYtd, "2000.0000");

      // A different tax year is a different fact and stays editable.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2027,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "10" } }],
      });
      assert.equal(
        (await openingBalancesForYear(fx.orgId, 2027)).rows[0]!.amounts?.pensionableYtd,
        "10.0000",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a rejected bulk load writes nothing at all",
  { skip: !DB },
  async () => {
    // Half a workforce carried in and half restarted at zero is harder to find
    // than an outright failure, so a single bad row aborts the whole load.
    const fx = await seedAdoption();
    try {
      const second = await seedEmployee(fx, { name: "Alex Second" });
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
          rows: [
            { employeePartyId: fx.employeeId, amounts: { pensionableYtd: "40000" } },
            { employeePartyId: second, amounts: { pensionableYtd: "100", cppYtd: "40000" } },
          ],
        }),
        OpeningBalanceSaveError,
      );
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.entered, 0, "the valid row must not survive the rejected load");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an all-zero row clears the carry-in rather than storing a row of zeros",
  { skip: !DB },
  async () => {
    // "No carry-in" and "carry-in of nothing" are the same fact. Two
    // representations would let the readiness warning disagree with the engine.
    const fx = await seedAdoption();
    try {
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "40000" } }],
      });
      assert.equal((await openingBalancesForYear(fx.orgId, 2026)).entered, 1);

      const cleared = await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: {} }],
      });
      assert.equal(cleared.deleted, 1);
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.entered, 0);
      assert.equal(after.rows[0]!.amounts, null);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* The readiness warning fires exactly when it should                  */
/* ------------------------------------------------------------------ */

test(
  "the first mid-year run of a tax year warns, by name, about employees with no carry-in",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const documentId = await seedRun(fx);
      const readiness = await payRunReadiness(fx.orgId, documentId);
      const item = openingItem(readiness);
      assert.ok(item, `expected a mid-year adoption warning, got ${codes(readiness).join(", ")}`);
      assert.equal(item.severity, "warning", "a new employer legitimately has none — never a blocker");
      assert.deepEqual(item.employees.map((e) => e.name), [fx.employeeName]);
      assert.equal(item.detail, "2026");
      assert.equal(item.href, "/payroll/opening-balances?year=2026");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the adoption warning stays silent once the carry-in is entered",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const documentId = await seedRun(fx);
      assert.ok(openingItem(await payRunReadiness(fx.orgId, documentId)));
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "84000", cppYtd: "4400" } }],
      });
      assert.equal(openingItem(await payRunReadiness(fx.orgId, documentId)), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a period that starts in January is the start of the year, so it never warns",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const documentId = await seedRun(fx, {
        periodStart: "2026-01-04", periodEnd: "2026-01-17", payDate: "2026-01-20",
      });
      assert.equal(openingItem(await payRunReadiness(fx.orgId, documentId)), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "only the FIRST committed run of the tax year asks the question",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const documentId = await seedRun(fx);
      assert.ok(openingItem(await payRunReadiness(fx.orgId, documentId)));

      // An earlier run in the same year has already committed: the answer is
      // settled, and repeating the warning on every payday is noise the
      // operator learns to click past.
      await seedRun(fx, {
        periodStart: "2026-06-07", periodEnd: "2026-06-20", payDate: "2026-06-23",
        runStatus: "committed",
      });
      assert.equal(openingItem(await payRunReadiness(fx.orgId, documentId)), undefined);

      // A committed run in a DIFFERENT tax year does not settle this year.
      await db.execute(sql`
        update pay_runs set tax_year = 2025
         where org_id = ${fx.orgId} and document_id <> ${documentId}`);
      assert.ok(openingItem(await payRunReadiness(fx.orgId, documentId)));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "someone hired inside this period has nothing to carry in and is not named",
  { skip: !DB },
  async () => {
    // Statutory room is per-employer: an employee this employer first hired on
    // or after the period start cannot have been paid by them earlier in the
    // year, so an empty carry-in is correct rather than missing.
    const fx = await seedAdoption();
    try {
      await seedEmployee(fx, { name: "Newly Hired", hiredOn: "2026-07-06" });
      const documentId = await seedRun(fx);
      const item = openingItem(await payRunReadiness(fx.orgId, documentId));
      assert.ok(item);
      assert.deepEqual(item.employees.map((e) => e.name), [fx.employeeName]);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* A WCB rate change can never leave a run "fresh"                     */
/* ------------------------------------------------------------------ */

test(
  "changing a WCB class rate makes a calculated run stale",
  { skip: !DB },
  async () => {
    // worker_comp_groups had NO audit columns, so a changed WSIB rate was
    // undetectable: the run reported itself fresh and committed the premium at
    // the old rate. This test fails outright (column does not exist) against
    // the table as it stood.
    const fx = await seedAdoption();
    try {
      const columns = (await db.execute(sql`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'worker_comp_groups'
      `)) as unknown as { rows: { column_name: string }[] };
      const present = new Set(columns.rows.map((r) => r.column_name));
      for (const column of ["created_at", "created_by", "updated_at", "updated_by"]) {
        assert.ok(present.has(column), `worker_comp_groups is missing ${column}`);
      }

      const groupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, is_active,
                                        created_by, updated_by)
        values (${groupId}, ${fx.orgId}, 'WSIB 704', 'Electrical', '3.5000', true,
                ${fx.actorId}, ${fx.actorId})`);
      await db.execute(sql`
        update employee_roles set worker_comp_group_id = ${groupId}
         where org_id = ${fx.orgId} and party_id = ${fx.employeeId}`);

      const documentId = await seedRun(fx);
      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${documentId}`);
      assert.deepEqual((await payRunStaleness(fx.orgId, documentId)).reasons, []);

      // The premium is rate × assessable earnings. Move the rate.
      await db.execute(sql`
        update worker_comp_groups set rate_percent = '5.2000', updated_at = now(),
               updated_by = ${fx.actorId}
         where id = ${groupId}`);
      const stale = await payRunStaleness(fx.orgId, documentId);
      assert.equal(stale.stale, true);
      assert.ok(
        stale.reasons.includes("workerComp"),
        `expected a workerComp reason, got ${stale.reasons.join(", ") || "none"}`,
      );

      // The assessable MAXIMUM moves money too, and is caught the same way.
      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${documentId}`);
      assert.deepEqual((await payRunStaleness(fx.orgId, documentId)).reasons, []);
      await db.execute(sql`
        update worker_comp_groups set max_assessable = '112500.0000', updated_at = now()
         where id = ${groupId}`);
      assert.ok((await payRunStaleness(fx.orgId, documentId)).reasons.includes("workerComp"));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a WCB edit that forgets to stamp updated_at is still caught through the audit trail",
  { skip: !DB },
  async () => {
    // The generic setup writer only stamps `updated_at` for registry entities
    // flagged `actorCols`, and 'worker-comp-groups' is not flagged yet. It
    // always writes the audit row, so the control does not depend on a change
    // this agent cannot make.
    const fx = await seedAdoption();
    try {
      const groupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, is_active,
                                        created_by, updated_by)
        values (${groupId}, ${fx.orgId}, 'WSIB 704', 'Electrical', '3.5000', true,
                ${fx.actorId}, ${fx.actorId})`);
      const documentId = await seedRun(fx);
      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${documentId}`);
      assert.deepEqual((await payRunStaleness(fx.orgId, documentId)).reasons, []);

      await db.execute(sql`
        update worker_comp_groups set rate_percent = '4.1000' where id = ${groupId}`);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${fx.orgId}, 'worker_comp_groups', ${groupId}, 'update',
                ${JSON.stringify({ ratePercent: "4.1000" })}::jsonb, ${fx.actorId})`);
      assert.ok((await payRunStaleness(fx.orgId, documentId)).reasons.includes("workerComp"));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an unrelated org's WCB rate change does not make this run stale",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    const other = await seedAdoption();
    try {
      const documentId = await seedRun(fx);
      await db.execute(sql`
        update pay_runs set calculated_at = now() where document_id = ${documentId}`);
      await db.execute(sql`
        insert into worker_comp_groups (org_id, code, name, rate_percent, is_active,
                                        created_by, updated_by)
        values (${other.orgId}, 'WSIB 704', 'Electrical', '3.5000', true,
                ${other.actorId}, ${other.actorId})`);
      assert.deepEqual((await payRunStaleness(fx.orgId, documentId)).reasons, []);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
      await dropScratchOrgReporting(other.orgId);
    }
  },
);
