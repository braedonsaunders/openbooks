import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, mulPercent } from "./money.ts";
import { calculateT4127 } from "./payroll/canada/t4127.ts";
import { applyBasisCaps } from "./payroll-limits.ts";
import {
  componentYearToDate,
  isEmptyOpeningBalance,
  normalizeOpeningBalance,
  normalizeOpeningComponents,
  openingBalancesForYear,
  openingComponentFields,
  OpeningBalanceSaveError,
  saveOpeningBalances,
  type OpeningComponentField,
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
const openingBalancesSource = readFileSync(new URL("./payroll-opening-balances.ts", import.meta.url), "utf8");

test("opening-balance component upserts pin the known tenant on the opening_balance_id/component_id conflict write", () => {
  assert.match(
    openingBalancesSource,
    /insert into payroll_opening_balance_components[\s\S]*?on conflict \(opening_balance_id, component_id\) do update[\s\S]*?where payroll_opening_balance_components\.org_id = \$\{input\.orgId\}/,
  );
});

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
/* Component openings: validation (no database)                        */
/* ------------------------------------------------------------------ */

const RRSP: OpeningComponentField = {
  componentId: "11111111-1111-1111-1111-111111111111",
  code: "RRSP",
  name: "RRSP employee contribution",
  kind: "deduction",
  basisCapAmountPerYear: "23500.0000",
  capped: true,
};

const RETIRED: OpeningComponentField = {
  componentId: "22222222-2222-2222-2222-222222222222",
  code: "OLDRRSP",
  name: "Retired RRSP plan",
  kind: "deduction",
  basisCapAmountPerYear: null,
  capped: false,
};

test("a component opening is exact money, keyed by id or code, and bounded by its own cap", () => {
  // Both keyings resolve to the component id, because the API sends uuids and a
  // spreadsheet header carries the code, and neither caller should own a
  // second resolver.
  assert.deepEqual(normalizeOpeningComponents({ RRSP: "23,000.00" }, [RRSP]), {
    [RRSP.componentId]: "23000.0000",
  });
  assert.deepEqual(normalizeOpeningComponents({ [RRSP.componentId]: "$1,000" }, [RRSP]), {
    [RRSP.componentId]: "1000.0000",
  });
  assert.deepEqual(normalizeOpeningComponents({ rrsp: "10" }, [RRSP]), {
    [RRSP.componentId]: "10.0000",
  });

  // Zero and blank are "no carry-in", not a row of zero.
  assert.deepEqual(normalizeOpeningComponents({ RRSP: "0" }, [RRSP]), {});
  assert.deepEqual(normalizeOpeningComponents({ RRSP: "" }, [RRSP]), {});

  assert.throws(() => normalizeOpeningComponents({ RRSP: "-1" }, [RRSP]), /cannot be negative/);
  assert.throws(() => normalizeOpeningComponents({ RRSP: "some" }, [RRSP]), /is not an amount/);
  // A stale template naming a component this org does not have.
  assert.throws(
    () => normalizeOpeningComponents({ TFSA: "100" }, [RRSP]),
    /not an annually-capped pay component/,
  );
  // Above the annual ceiling is arithmetically impossible — the realistic cause
  // is a transposed spreadsheet column, exactly like the statutory checks.
  assert.throws(
    () => normalizeOpeningComponents({ RRSP: "23500.01" }, [RRSP]),
    /exceeds its annual cap/,
  );
  // A component with no annual cap: entering a number that changes nothing is
  // the setting this codebase refuses to offer.
  assert.throws(
    () => normalizeOpeningComponents({ OLDRRSP: "500" }, [RETIRED]),
    /has no annual basis cap/,
  );
});

test("an employee whose ONLY carry-in is a component year-to-date is not an empty row", () => {
  // The caller DELETES a row this returns true for. Judged on the statutory
  // columns alone, a pure 402(g) carry-in would be deleted on sight and the
  // employee would silently regain a full annual deferral limit.
  const zeroes = normalizeOpeningBalance({});
  assert.equal(isEmptyOpeningBalance(zeroes), true);
  assert.equal(isEmptyOpeningBalance(zeroes, {}), true);
  assert.equal(isEmptyOpeningBalance(zeroes, { [RRSP.componentId]: "23000.0000" }), false);
  assert.equal(isEmptyOpeningBalance(zeroes, { [RRSP.componentId]: "0.0000" }), true);
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

      const stub = ((await db.execute<{ gross: string; net_pay: string; factors: Record<string, string> }>(sql`
        select gross, net_pay, factors from pay_stubs
         where org_id = ${fx.orgId} and pay_run_document_id = ${run.documentId}
      `)))
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
/* The component dimension: an annual cap that does not restart        */
/* ------------------------------------------------------------------ */

/** An annually-capped percent-of-gross deduction, assigned to the employee. */
async function seedCappedComponent(
  fx: AdoptionFixture,
  options: { code?: string; capPerYear?: string; percent?: string; assign?: boolean } = {},
): Promise<string> {
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, basis, value,
                                basis_cap_amount_per_year, tax_treatment, is_active,
                                created_by, updated_by)
    values (${componentId}, ${fx.orgId}, ${options.code ?? "RRSP"}, 'RRSP employee contribution',
            'deduction', 'percent_of_gross', ${options.percent ?? "5"},
            ${options.capPerYear ?? "23500"}, 'pension_f', true, ${fx.actorId}, ${fx.actorId})`);
  if (options.assign !== false) {
    await db.execute(sql`
      insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                           effective_from, is_active, created_by, updated_by)
      values (${fx.orgId}, ${fx.employeeId}, ${componentId}, null, '2020-01-01', true,
              ${fx.actorId}, ${fx.actorId})`);
  }
  return componentId;
}

test(
  "an employee near the annual deferral limit contributes only the remaining room",
  { skip: !DB },
  async () => {
    // The whole defect. `basis_cap_amount_per_year` is the CRA money-purchase /
    // US 402(g) ceiling, enforced against the component's year-to-date — and
    // that year-to-date had no carry-in dimension, so it restarted at zero on
    // the adoption date and the employee could defer a SECOND full annual limit.
    const fx = await seedAdoption();
    try {
      const componentId = await seedCappedComponent(fx, { capPerYear: "23500", percent: "5" });

      // What the prior provider already deferred this year.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "84000", taxableYtd: "84000" },
          components: { RRSP: "23000.00" },
        }],
      });

      const ytd = await componentYearToDate(db, {
        orgId: fx.orgId, employeePartyId: fx.employeeId, taxYear: 2026, componentId,
      });
      assert.equal(ytd, "23000.0000");

      // 5% of a $40,000 period would be $2,000. Only $500 of room is left, so
      // the CAPPED basis is $10,000 and the deduction is exactly $500.
      const capped = {
        basis: "percent_of_gross" as const,
        value: "5",
        basisCapHoursPerPeriod: null,
        basisCapAmountPerPeriod: null,
        basisCapAmountPerYear: "23500",
      };
      const basis = applyBasisCaps(capped, "40000.00", { lines: [], yearToDate: ytd });
      assert.equal(basis, "10000.0000");
      assert.equal(mulPercent(basis, "5", 2), "500.0000");

      // And it must actually BITE: with no carry-in the same period takes the
      // full 5%, which is the second annual limit this exists to prevent.
      const fresh = applyBasisCaps(capped, "40000.00", { lines: [], yearToDate: "0" });
      assert.equal(mulPercent(fresh, "5", 2), "2000.0000");
      assert.ok(cmp(mulPercent(fresh, "5", 2), mulPercent(basis, "5", 2)) > 0);

      // Committed stub lines and the opening are ONE year-to-date, summed.
      const documentId = await seedRun(fx, {
        periodStart: "2026-08-02", periodEnd: "2026-08-15", payDate: "2026-08-18",
        runStatus: "committed",
      });
      const stubId = randomUUID();
      await db.execute(sql`
        insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                               factors, created_by, updated_by)
        values (${stubId}, ${fx.orgId}, ${documentId}, ${fx.employeeId}, 'ON', 26, '2026-08-18',
                2026, 'CAD', '2400', '1900', '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);
      await db.execute(sql`
        insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                    created_by, updated_by)
        values (${fx.orgId}, ${stubId}, ${componentId}, 'deduction', 'RRSP', '120',
                ${fx.actorId}, ${fx.actorId})`);
      assert.equal(
        await componentYearToDate(db, {
          orgId: fx.orgId, employeePartyId: fx.employeeId, taxYear: 2026, componentId,
        }),
        "23120.0000",
      );
      // A run must not count its own lines, or recalculating ratchets the cap
      // down on every pass.
      assert.equal(
        await componentYearToDate(db, {
          orgId: fx.orgId, employeePartyId: fx.employeeId, taxYear: 2026, componentId,
          excludeRunDocumentId: documentId,
        }),
        "23000.0000",
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a carry-in whose only content is a component year-to-date survives, and clearing takes both",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const componentId = await seedCappedComponent(fx);
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: {}, components: { RRSP: "1000" } }],
      });
      const stored = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(stored.entered, 1, "an all-zero statutory row must not delete the components");
      assert.equal(stored.rows[0]!.componentAmounts[componentId], "1000.0000");
      assert.deepEqual(stored.components.map((c) => c.code), ["RRSP"]);

      // A caller that says nothing about components keeps them: silence is not
      // an instruction to delete a deferral year-to-date.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "50" } }],
      });
      const kept = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(kept.rows[0]!.componentAmounts[componentId], "1000.0000");

      // Clearing everything is a delete, and takes the children with it.
      const cleared = await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: {}, components: {} }],
      });
      assert.equal(cleared.deleted, 1);
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.entered, 0);
      assert.deepEqual(after.rows[0]!.componentAmounts, {});
      const orphans = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from payroll_opening_balance_components
         where org_id = ${fx.orgId}`));
      assert.equal(orphans.rows[0]!.n, 0, "the child rows must cascade with their parent");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an opening for a component whose annual cap was removed is kept, shown, and never re-entered",
  { skip: !DB },
  async () => {
    // Data somebody entered is not deleted because configuration changed. It is
    // inert until a cap comes back, read-only, and immune to being cleared by a
    // caller that simply cannot see it any more.
    const fx = await seedAdoption();
    try {
      const componentId = await seedCappedComponent(fx);
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: {}, components: { RRSP: "1000" } }],
      });
      await db.execute(sql`
        update pay_components set basis_cap_amount_per_year = null where id = ${componentId}`);

      const fields = await openingComponentFields(fx.orgId, 2026);
      assert.deepEqual(fields.map((f) => [f.code, f.capped]), [["RRSP", false]]);

      // A save that names nothing must not clear it.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "50" }, components: {} }],
      });
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.rows[0]!.componentAmounts[componentId], "1000.0000");

      // And it cannot be re-entered while the cap is gone.
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
          rows: [{ employeePartyId: fx.employeeId, amounts: {}, components: { RRSP: "2000" } }],
        }),
        /has no annual basis cap/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a component carry-in is refused once a run has committed, and is left exactly as it was",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const componentId = await seedCappedComponent(fx);
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "84000", taxableYtd: "84000" },
          components: { RRSP: "23000" },
        }],
      });

      const documentId = await seedRun(fx, { runStatus: "committed" });
      await db.execute(sql`
        insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                               periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                               factors, created_by, updated_by)
        values (${fx.orgId}, ${documentId}, ${fx.employeeId}, 'ON', 26, '2026-07-21', 2026, 'CAD',
                '2400', '1900', '{}'::jsonb, ${fx.actorId}, ${fx.actorId})`);

      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
          rows: [{
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "84000", taxableYtd: "84000" },
            components: { RRSP: "1" },
          }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof OpeningBalanceSaveError);
          assert.match(error.message, /already used this carry-in for 2026/);
          return true;
        },
      );
      const after = await openingBalancesForYear(fx.orgId, 2026);
      assert.equal(after.rows[0]!.componentAmounts[componentId], "23000.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the first mid-year run warns about a capped component with no carry-in, and only then",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      await seedCappedComponent(fx);
      const documentId = await seedRun(fx);
      const item = (r: Awaited<ReturnType<typeof payRunReadiness>>) =>
        r.items.find((i) => i.code === "employee.noOpeningComponentYtd");

      const warned = item(await payRunReadiness(fx.orgId, documentId));
      assert.ok(warned, "expected a component carry-in warning");
      assert.equal(warned.severity, "warning");
      assert.equal(warned.detail, "RRSP");
      assert.deepEqual(warned.employees.map((e) => e.name), [fx.employeeName]);

      // A statutory row alone does NOT answer the component question — this is
      // exactly the hole: the row warning goes quiet and the cap still restarts.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "84000" } }],
      });
      assert.equal(openingItem(await payRunReadiness(fx.orgId, documentId)), undefined);
      assert.ok(item(await payRunReadiness(fx.orgId, documentId)));

      // Entering the component year-to-date settles it.
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "84000" },
          components: { RRSP: "23000" },
        }],
      });
      assert.equal(item(await payRunReadiness(fx.orgId, documentId)), undefined);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an unassigned capped component, and a hire inside the period, are not warned about",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      // Configured but assigned to nobody: nothing will be deducted, so there is
      // no limit to have consumed.
      await seedCappedComponent(fx, { assign: false });
      const documentId = await seedRun(fx);
      const item = (r: Awaited<ReturnType<typeof payRunReadiness>>) =>
        r.items.find((i) => i.code === "employee.noOpeningComponentYtd");
      assert.equal(item(await payRunReadiness(fx.orgId, documentId)), undefined);

      // Assigned to somebody this employer first hired inside the period: they
      // cannot have consumed any of the limit HERE earlier in the year.
      const newHire = await seedEmployee(fx, { name: "Newly Hired", hiredOn: "2026-07-06" });
      const componentId = await seedCappedComponent(fx, { code: "RRSP2" });
      await db.execute(sql`
        insert into employee_pay_components (org_id, employee_party_id, component_id, value,
                                             effective_from, is_active, created_by, updated_by)
        values (${fx.orgId}, ${newHire}, ${componentId}, null, '2026-07-06', true,
                ${fx.actorId}, ${fx.actorId})`);
      const warned = item(await payRunReadiness(fx.orgId, documentId));
      assert.ok(warned, "the assigned long-tenured employee is still warned about");
      assert.deepEqual(warned.employees.map((e) => e.name), [fx.employeeName]);
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
      const columns = (await db.execute<{ column_name: string }>(sql`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'worker_comp_groups'
      `));
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

test(
  "a calculated stub takes only the remaining annual room, not a second full limit",
  { skip: !DB },
  async () => {
    // The composition test above proves the SERVICE and `applyBasisCaps` agree.
    // This one proves the pay run actually reaches them: `calculateStub`'s own
    // year-to-date closure used to sum committed stub lines only, while its
    // comment claimed openings arrived "via the opening-balance sweep the
    // year-end module owns" — a sweep that has never existed. Against that
    // code this test fails by deducting the full period percentage.
    const fx = await seedAdoption();
    try {
      const componentId = await seedCappedComponent(fx, { capPerYear: "23500", percent: "5" });
      await saveOpeningBalances({
        orgId: fx.orgId, actorId: fx.actorId, taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "84000.00", taxableYtd: "84000.00" },
          // $100 of room left against the $23,500 ceiling.
          components: { RRSP: "23400.00" },
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
      assert.deepEqual(
        (await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId }))
          .errors,
        [],
      );

      const deduction = async (documentId: string) =>
        ((await db.execute<{ amount: string }>(sql`
          select l.amount from pay_stub_lines l
            join pay_stubs s on s.id = l.stub_id
           where l.org_id = ${fx.orgId} and s.pay_run_document_id = ${documentId}
             and l.component_id = ${componentId}
        `))).rows[0]?.amount ?? null;

      // 5% of $2,400 is $120; only $100 of annual room remains.
      assert.equal(await deduction(run.documentId), "100.0000");

      // And it must BITE: the identical run with the carry-in removed takes the
      // uncapped $120, which over the rest of the year is the second limit.
      await db.execute(sql`
        delete from payroll_opening_balance_components oc
          using payroll_opening_balances b
         where b.id = oc.opening_balance_id and oc.org_id = ${fx.orgId}
           and b.employee_party_id = ${fx.employeeId}`);
      assert.equal(
        await componentYearToDate(db, {
          orgId: fx.orgId, employeePartyId: fx.employeeId, taxYear: 2026, componentId,
        }),
        "0.0000",
      );
      assert.deepEqual(
        (await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId }))
          .errors,
        [],
      );
      assert.equal(await deduction(run.documentId), "120.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
