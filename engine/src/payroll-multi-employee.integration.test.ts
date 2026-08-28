import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp, sum } from "./money.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { upsertUnionFringe } from "./payroll-union.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

/**
 * Pay runs that pay MORE THAN ONE PERSON, and the money rules that only a
 * second employee, a second currency, or a second job can expose.
 *
 * Every payroll integration test in this repository paid exactly one employee,
 * which is precisely why a bug that deleted every employee's entitlement
 * ledger rows except the last one's was invisible: with a roster of one, "keep
 * only the last employee's movements" and "keep every employee's movements"
 * are the same sentence.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  subsidiaryId: string;
  actorId: string;
  scheduleId: string;
  accounts: Record<string, string>;
}

const account = async (
  orgId: string, number: string, name: string, type: string,
): Promise<string> => {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
};

/** A CA org with payroll accounts wired and one biweekly schedule. */
async function payrollOrg(opts: { eht?: { rate: string; annualExemption: string } } = {}): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const accounts = {
    wageExpense: await account(org.orgId, "6000", "Wages expense", "expense"),
    burdenExpense: await account(org.orgId, "6010", "Payroll burden", "expense"),
    netPayable: await account(org.orgId, "2300", "Wages payable", "liability_current"),
    craPayable: await account(org.orgId, "2310", "CRA payable", "liability_current"),
    vacationPayable: await account(org.orgId, "2320", "Vacation payable", "liability_current"),
    otherPayable: await account(org.orgId, "2330", "Other payable", "liability_current"),
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
        ...(opts.eht ? { ca: { eht: { enabled: true, ...opts.eht } } } : {}),
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);
  return {
    orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, accounts,
  };
}

interface EmployeeOptions {
  currency?: string;
  rate?: string;
  basis?: "hour" | "year";
  annualHours?: string;
  payBasis?: "hourly" | "salary";
  vacationPercent?: string | null;
  scheduleId?: string;
  workerCompGroupId?: string | null;
  terminatedOn?: string | null;
}

async function employee(fx: Fixture, name: string, opts: EmployeeOptions = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, worker_comp_group_id, terminated_on)
    values (${randomUUID()}, ${fx.orgId}, ${id}, ${opts.workerCompGroupId ?? null},
            ${opts.terminatedOn ?? null})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${opts.currency ?? "CAD"}, ${opts.rate ?? "30"},
            ${opts.basis ?? "hour"}, ${opts.annualHours ?? "2080"}, '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, is_active,
                                           created_by, updated_by)
    values (${fx.orgId}, ${id}, ${opts.scheduleId ?? fx.scheduleId}, 'ON',
            ${opts.payBasis ?? "hourly"}, 1, 1,
            ${opts.vacationPercent === undefined ? "4" : opts.vacationPercent}, 'accrue', true,
            ${fx.actorId}, ${fx.actorId})`);
  return id;
}

async function hours(
  fx: Fixture, employeeId: string, workedOn: string, qty: string, projectId?: string,
): Promise<void> {
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, project_id, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${workedOn}, ${qty}, ${projectId ?? null}, 'approved',
            false, 'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
}

const ledgerRows = async (orgId: string) => ((await db.execute<{ employee_party_id: string; kind: string; amount: string; pay_run_document_id: string | null }>(sql`
  select employee_party_id, kind, amount::text as amount, pay_run_document_id
    from entitlement_ledger where org_id = ${orgId}
   order by employee_party_id, kind`))).rows;

const stubRows = async (orgId: string, documentId: string) => ((await db.execute<{
    employee_party_id: string; gross: string; vacation_accrued: string;
    factors: Record<string, string>; id: string;
  }>(sql`
  select employee_party_id, gross::text as gross, vacation_accrued::text as vacation_accrued,
         factors, id
    from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`))).rows;

/* ------------------------------------------------------------------ */
/* D1 + D2 — three employees, three banks                              */
/* ------------------------------------------------------------------ */

test(
  "a three-employee run accrues and banks vacation for EVERY employee, and recalculating is idempotent",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const names = ["Ada Bricklayer", "Bo Framer", "Cy Welder"];
      const ids: string[] = [];
      for (const name of names) {
        const id = await employee(fx, name);
        ids.push(id);
        // 80 hours each at $30 → $2,400 gross → 4% = $96.00 vacation.
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 3);

      // D1: the accrual happens at all — the plan is provisioned beside the
      // components, and is matched on its system key, not its editable code.
      const stubs = await stubRows(fx.orgId, run.documentId);
      assert.equal(stubs.length, 3);
      for (const stub of stubs) assert.equal(stub.vacation_accrued, "96.0000");

      // D2: EVERY employee keeps their ledger movement. The per-employee call
      // used to delete the whole run's rows, so only the last employee had any.
      const banked = await ledgerRows(fx.orgId);
      assert.equal(banked.length, 3, "one accrual per employee, not one per run");
      assert.deepEqual([...new Set(banked.map((r) => r.employee_party_id))].sort(), [...ids].sort());
      for (const row of banked) {
        assert.equal(row.kind, "accrual");
        assert.equal(row.amount, "96.0000");
        assert.equal(row.pay_run_document_id, run.documentId);
      }

      // Recalculation converges: still exactly one movement each, same amount.
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const again = await ledgerRows(fx.orgId);
      assert.equal(again.length, 3);
      assert.equal(sum(again.map((r) => r.amount)), "288.0000");

      // Excluding one employee removes THEIR movement and nobody else's.
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, created_by, updated_by)
        values (${fx.orgId}, ${run.documentId}, ${ids[0]}, 'exclude', ${fx.actorId}, ${fx.actorId})`);
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const afterExclude = await ledgerRows(fx.orgId);
      assert.equal(afterExclude.length, 2);
      assert.ok(!afterExclude.some((r) => r.employee_party_id === ids[0]));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D3 + D4 — a final pay run is scoped, and pays the whole bank twice   */
/* ------------------------------------------------------------------ */

test(
  "a final pay run must name who it pays, and recalculating it keeps the whole banked balance",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const stayA = await employee(fx, "Ada Stays");
      const stayB = await employee(fx, "Bo Stays");
      const leaver = await employee(fx, "Cy Leaves", { terminatedOn: "2026-07-25" });
      for (const id of [stayA, stayB, leaver]) {
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }
      const regular = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });

      // D4: an unscoped final pay run cannot be created at all. Without this
      // the run pays every employee a second full period AND drains every bank.
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
        }),
        /must name the employees it pays/,
      );
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
          employeePartyIds: [randomUUID()],
        }),
        /not on this pay schedule/,
      );

      const final = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19", periodEnd: "2026-08-01", runType: "termination",
        employeePartyIds: [leaver],
      });
      const firstPass = await calculatePayRun({
        orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(firstPass.errors, []);
      assert.equal(firstPass.employees, 1, "only the named employee is on a final pay run");

      const payoutOf = async () => ((await db.execute<{ amount: string }>(sql`
        select l.amount::text as amount
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${final.documentId}
           and l.description like '%payout (accrued balance)'`))).rows.map((r) => r.amount);
      assert.deepEqual(await payoutOf(), ["96.0000"]);

      // D3: the SECOND Calculate used to read the balance net of its own
      // payout, see zero, and quietly drop the departing employee's whole bank.
      await calculatePayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });
      assert.deepEqual(await payoutOf(), ["96.0000"], "the bank is paid out on every recalculation");
      await calculatePayRun({ orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId });
      assert.deepEqual(await payoutOf(), ["96.0000"]);

      // Everyone else is untouched: no stub, and their bank is intact.
      const finalStubs = await stubRows(fx.orgId, final.documentId);
      assert.deepEqual(finalStubs.map((s) => s.employee_party_id), [leaver]);
      const balances = new Map<string, string>();
      for (const row of await ledgerRows(fx.orgId)) {
        balances.set(row.employee_party_id, sum([balances.get(row.employee_party_id) ?? "0", row.amount]));
      }
      assert.equal(balances.get(stayA), "96.0000");
      assert.equal(balances.get(stayB), "96.0000");
      assert.equal(balances.get(leaver), "0.0000", "the leaver's bank is cleared, exactly once");

      // A roster that GROWS after creation cannot sneak onto the run: someone
      // whose employment has not ended is refused by name, never paid.
      const newHire = await employee(fx, "Dee Newhire");
      const grown = await calculatePayRun({
        orgId: fx.orgId, documentId: final.documentId, actorId: fx.actorId,
      });
      assert.equal(grown.employees, 1);
      assert.ok(
        grown.errors.some((e) => e.employee === "Dee Newhire" && /employment has ended/.test(e.message)),
        "an unterminated stranger on a final pay run is refused, loudly",
      );
      assert.ok(!(await stubRows(fx.orgId, final.documentId)).some((s) => s.employee_party_id === newHire));
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D5 — commit claims only the time the run actually priced             */
/* ------------------------------------------------------------------ */

test(
  "an off-cycle bonus run claims no time, so the regular run still pays the period's hours",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const id = await employee(fx, "Bonnie Bonus");
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(fx, id, day, "20");
      }
      const bonus = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18", runType: "bonus",
      });
      const bonusComponent = ((await db.execute<{ id: string }>(sql`
        select id from pay_components where org_id = ${fx.orgId} and code = 'BONUS'
      `))).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, note,
                                         created_by, updated_by)
        values (${fx.orgId}, ${bonus.documentId}, ${id}, 'line', ${bonusComponent.id},
                '500', 'Spot bonus', ${fx.actorId}, ${fx.actorId})`);
      await calculatePayRun({ orgId: fx.orgId, documentId: bonus.documentId, actorId: fx.actorId });
      await commitPayRun({ orgId: fx.orgId, documentId: bonus.documentId, actorId: fx.actorId });

      // The bonus run priced no hours, so it may not claim any. Claiming them
      // made every hourly employee calculate at $0 on the regular run while
      // readiness still reported the hours as present.
      const claimed = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from time_entries
         where org_id = ${fx.orgId} and payroll_batch_ref is not null`))).rows[0]!.n;
      assert.equal(claimed, 0, "a bonus run prices no time and therefore claims none");

      const regular = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      assert.equal((await stubRows(fx.orgId, regular.documentId))[0]!.gross, "2400.0000");
      await commitPayRun({ orgId: fx.orgId, documentId: regular.documentId, actorId: fx.actorId });
      const nowClaimed = ((await db.execute<{ n: number }>(sql`
        select count(*)::int as n from time_entries
         where org_id = ${fx.orgId} and payroll_batch_ref = ${regular.documentId}`))).rows[0]!.n;
      assert.equal(nowClaimed, 4, "the run that priced the hours is the run that claims them");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D6 — a finite annual allowance is consumed by CALCULATED runs too    */
/* ------------------------------------------------------------------ */

test(
  "two schedules calculated before either commits cannot both claim the Ontario EHT exemption",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg({ eht: { rate: "1.95", annualExemption: "1000" } });
    try {
      const secondSchedule = randomUUID();
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                                   pay_date_offset_days, is_active, created_by, updated_by)
        values (${secondSchedule}, ${fx.orgId}, 'Biweekly two', 'biweekly', 26, '2026-07-18', 3,
                true, ${fx.actorId}, ${fx.actorId})`);
      const first = await employee(fx, "Ada First");
      const second = await employee(fx, "Bo Second", { scheduleId: secondSchedule });
      for (const id of [first, second]) {
        for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
          await hours(fx, id, day, "20");
        }
      }

      const runA = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: runA.documentId, actorId: fx.actorId });
      // Deliberately NOT committed — the second schedule is calculated while
      // the first is still sitting in the wizard, which is the normal Friday.
      const runB = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: secondSchedule,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: runB.documentId, actorId: fx.actorId });

      // (2,400 − 1,000) × 1.95% = 27.30 for the first; the exemption is gone
      // by the second, so 2,400 × 1.95% = 46.80. Consuming only against
      // COMMITTED runs gave both of them the full exemption and under-remitted.
      assert.equal((await stubRows(fx.orgId, runA.documentId))[0]!.factors.EHT, "27.3000");
      assert.equal((await stubRows(fx.orgId, runB.documentId))[0]!.factors.EHT, "46.8000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* D7 — 'voided', not 'void'                                            */
/* ------------------------------------------------------------------ */

test(
  "a voided regular run does not block its own replacement for the same period",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      await employee(fx, "Vic Void");
      const first = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      // A live run blocks any OVERLAPPING regular run, which is the point.
      await assert.rejects(
        createPayRun({
          orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
          periodStart: "2026-07-12", periodEnd: "2026-07-25",
        }),
        /already covers/,
      );
      // The documents status enum is 'voided'; the guard compared to 'void',
      // so a voided run went on blocking its own period forever.
      await db.execute(sql`
        update documents
           set status = 'voided', voided_at = now(), voided_by = ${fx.actorId},
               void_reason = 'Opened against the wrong schedule'
         where id = ${first.documentId}`);
      // Voiding releases the storage key while retaining the original run and
      // its reversal evidence. An exact-period replacement is therefore
      // allowed, but it receives a new document identity.
      const replacement = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      assert.ok(replacement.documentId);
      assert.notEqual(replacement.documentId, first.documentId);

      const statuses = await db.execute<{ document_id: string; run_status: string }>(sql`
        select document_id, run_status from pay_runs
         where org_id = ${fx.orgId}
           and document_id in (${first.documentId}, ${replacement.documentId})
         order by document_id
      `);
      assert.equal(statuses.rows.find((row) => row.document_id === first.documentId)?.run_status, "voided");
      assert.equal(statuses.rows.find((row) => row.document_id === replacement.documentId)?.run_status, "draft");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-1 — a wage is converted to the currency the run pays in            */
/* ------------------------------------------------------------------ */

test(
  "a foreign-currency wage is converted before it is paid, and refuses to be paid without a rate",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      // The scratch org's entity reports in CAD; this wage row is USD.
      const id = await employee(fx, "Uma Crossborder", { currency: "USD", rate: "60" });
      await hours(fx, id, "2026-07-06", "10");
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const unconverted = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.equal(unconverted.employees, 0);
      assert.match(unconverted.errors[0]!.message, /no spot rate for the wage USD→CAD/);

      await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${fx.orgId}, 'USD', 'CAD', '2026-01-01', 'spot', '1.3700000000', 'manual')`);
      const converted = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(converted.errors, []);
      // USD 60.00 × 1.37 = CAD 82.20 an hour, not the raw 60.00 that used to
      // be paid — a 37% overpayment that balanced perfectly in the GL.
      assert.equal((await stubRows(fx.orgId, run.documentId))[0]!.gross, "822.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-5 / M-6 — division stays exact                                     */
/* ------------------------------------------------------------------ */

test(
  "an annual rate divided by annual hours is exact, not a float reciprocal",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      // 125,000 ÷ 1,800 = 69.444444…; the stored 4dp wage is 69.4444, and a
      // float reciprocal rounds it up to 69.4445 — which is then multiplied by
      // every hour on every stub, always in the same direction.
      const id = await employee(fx, "Hank Hourly", {
        basis: "year", rate: "125000", annualHours: "1800", payBasis: "hourly",
      });
      for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
        await hours(fx, id, day, "20");
      }
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      await calculatePayRun({ orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId });
      const line = ((await db.execute<{ rate: string; amount: string }>(sql`
        select l.rate::text as rate, l.amount::text as amount
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} and l.hours is not null`))).rows[0]!;
      assert.equal(line.rate, "69.4444");
      assert.equal(line.amount, "5555.5500"); // 69.4444 × 80, not 69.4445 × 80
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-3 — the job split of a levy sums to the levy, in both directions   */
/* ------------------------------------------------------------------ */

test(
  "a WCB split that over-allocates by rounding still sums to exactly the premium",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const groupId = randomUUID();
      await db.execute(sql`
        insert into worker_comp_groups (id, org_id, code, name, rate_percent, is_active)
        values (${groupId}, ${fx.orgId}, 'CLASS-B', 'Class B', '5', true)`);
      const id = await employee(fx, "Rae Rounding", {
        rate: "33.3330", workerCompGroupId: groupId, vacationPercent: null,
      });
      const jobs: string[] = [];
      for (const name of ["Job A", "Job B", "Job C"]) {
        const projectId = randomUUID();
        jobs.push(projectId);
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${projectId}, ${fx.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      // Three jobs at 333.33 each, plus one untagged cent: gross 1,000.00, so
      // each independently rounded 5% share is 16.67 and the three of them
      // over-allocate the 50.00 premium by a cent.
      for (const projectId of jobs) await hours(fx, id, "2026-07-06", "10", projectId);
      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const bonusComponent = ((await db.execute<{ id: string }>(sql`
        select id from pay_components where org_id = ${fx.orgId} and code = 'BONUS'
      `))).rows[0]!;
      await db.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, component_id, amount, note,
                                         created_by, updated_by)
        values (${fx.orgId}, ${run.documentId}, ${id}, 'line', ${bonusComponent.id},
                '0.01', 'Untagged cent', ${fx.actorId}, ${fx.actorId})`);
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      const stub = (await stubRows(fx.orgId, run.documentId))[0]!;
      assert.equal(stub.gross, "1000.0000");
      assert.equal(stub.factors.WCB, "50.0000");
      const wcbLines = ((await db.execute<{ amount: string }>(sql`
        select amount::text as amount from pay_stub_lines
         where stub_id = ${stub.id} and description = 'WCB/WSIB'`))).rows;
      // The stub lines and factors.WCB must agree: the remittance summary sums
      // the lines and the annual-cap tracker reads the factor, so a dropped
      // negative remainder puts the two permanently at odds.
      assert.equal(sum(wcbLines.map((l) => l.amount)), stub.factors.WCB);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* M-10 — job_costed is a property of the fringe, not of its formula    */
/* ------------------------------------------------------------------ */

test(
  "a percent-of-gross union fringe marked job-costed lands on the jobs",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    try {
      const agreementId = randomUUID();
      await db.execute(sql`
        insert into union_agreements (id, org_id, name, union_name, local_number, is_active,
                                      created_by, updated_by)
        values (${agreementId}, ${fx.orgId}, 'Local 1', 'IBEW', '1', true,
                ${fx.actorId}, ${fx.actorId})`);
      await upsertUnionFringe(fx.orgId, fx.actorId, {
        agreementId, code: "WELF", name: "Welfare fund", calc: "percent_of_gross",
        value: "10", paidBy: "employer", jobCosted: true,
        expenseAccountId: fx.accounts.burdenExpense,
        liabilityAccountId: fx.accounts.otherPayable!,
      });

      const id = await employee(fx, "Jo Jobcost", { vacationPercent: null });
      await db.execute(sql`
        update employee_payroll_profiles set union_agreement_id = ${agreementId}
         where org_id = ${fx.orgId} and employee_party_id = ${id}`);
      const jobA = randomUUID();
      const jobB = randomUUID();
      for (const [projectId, name] of [[jobA, "Job A"], [jobB, "Job B"]] as const) {
        await db.execute(sql`
          insert into projects (id, org_id, name, code, is_active, custom)
          values (${projectId}, ${fx.orgId}, ${name}, ${name}, true, '{}'::jsonb)`);
      }
      await hours(fx, id, "2026-07-06", "20", jobA); // $600
      await hours(fx, id, "2026-07-08", "20", jobB); // $600

      const run = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-05", periodEnd: "2026-07-18",
      });
      const result = await calculatePayRun({
        orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(result.errors, []);
      const fringeLines = ((await db.execute<{ amount: string; project_id: string | null }>(sql`
        select l.amount::text as amount, l.project_id
          from pay_stub_lines l join pay_stubs s on s.id = l.stub_id
         where s.pay_run_document_id = ${run.documentId} and l.description = 'Welfare fund'
         order by l.project_id`))).rows;
      // 10% of 1,200 = 120.00, split by the earnings it is a percent OF.
      assert.equal(fringeLines.length, 2, "the flag's whole purpose is job costing");
      assert.ok(fringeLines.every((l) => l.project_id !== null));
      assert.equal(sum(fringeLines.map((l) => l.amount)), "120.0000");
      assert.equal(cmp(fringeLines[0]!.amount, "60.0000"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
