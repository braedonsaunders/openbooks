import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { CA_PACK_RATES } from "./canada/rates.ts";
import {
  buildResolution,
  listStatutoryRates,
  resolveStatutoryRates,
  upsertStatutoryRate,
  type StatutoryRateRow,
} from "./statutory-rates.ts";
import { US_PACK_RATES } from "./us/rates.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Statutory rate HISTORY (0183).
 *
 * The old writer updated `rate_values` in place on the same row id while the
 * remover refused every delete "to protect reproduction" — so the refusal
 * protected nothing and no prior period could be replayed. Now a re-save
 * supersedes the open row and inserts its successor, a remove retires the
 * open row, and the resolver answers the row in force on the PAY DATE.
 *
 * Each test names the money it protects. The committed-run test below is the
 * one that matters: a committed run recalculated after a re-save must answer
 * to the cent what it answered when it committed — a real committed run, not
 * a synthetic row.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const row = (over: Partial<StatutoryRateRow>): StatutoryRateRow => ({
  id: randomUUID(), country: "US", rateKey: "us_futa", region: "MI",
  filingAccountId: null, taxYear: 2026, values: { rate: "0.0060" },
  supersededOn: null,
  ...over,
});

/* ------------------------------------------------------------------ */
/* The as-of ladder, without a database                                */
/* ------------------------------------------------------------------ */

test("as-of resolution answers the row in force on that date, not the current row", () => {
  // One scope point's linear chain: 0.006 until 1 Mar, 0.009 until 1 Jun,
  // 0.012 since. Deliberately NOT in chronological order, so the pick cannot
  // be "whichever row the planner returned first".
  const rows = [
    row({ id: "r3", values: { rate: "0.0120" }, supersededOn: null }),
    row({ id: "r1", values: { rate: "0.0060" }, supersededOn: "2026-03-01" }),
    row({ id: "r2", values: { rate: "0.0090" }, supersededOn: "2026-06-01" }),
  ];
  const at = (asOf: string | null) => buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, rows, legacy: [], asOf,
  }).values("us_futa", { region: "MI" })?.rate;
  assert.equal(at("2026-02-01"), "0.0060");
  assert.equal(at("2026-04-15"), "0.0090");
  assert.equal(at("2026-07-01"), "0.0120");
  // A row superseded ON a date is already history that date: superseded_on
  // is the first date the row is NOT in force.
  assert.equal(at("2026-03-01"), "0.0090");
  assert.equal(at("2026-06-01"), "0.0120");
  // Without a date the live answer is unchanged: the current row.
  assert.equal(at(null), "0.0120");
});

test("a malformed as-of date is refused before any read", async () => {
  await assert.rejects(
    listStatutoryRates(randomUUID(), { asOf: "next Friday" }),
    /takes an ISO date/,
  );
});

/* ------------------------------------------------------------------ */
/* The catalog, read back                                              */
/* ------------------------------------------------------------------ */

test(
  "the point index is partial on superseded_on with its COALESCEs intact",
  { skip: !DB },
  async () => {
    // The DDL I wrote is not the witness — the catalog is. A migration
    // ledger once claimed a migration had applied while the object said
    // otherwise, so this asserts pg_indexes, not the .sql file.
    const found = (await db.execute<{ indexdef: string }>(sql`
      select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'payroll_statutory_rates_org_point'
    `));
    assert.equal(found.rows.length, 1);
    const def = found.rows[0]!.indexdef;
    assert.match(def, /WHERE \(superseded_on IS NULL\)/);
    assert.match(def, /COALESCE\(region/);
    assert.match(def, /COALESCE\(sub_region/);
    assert.match(def, /COALESCE\(filing_account_id/);
    const pred = (await db.execute<{ indpred: string | null }>(sql`
      select pg_get_expr(indpred, indrelid) as indpred from pg_index
       where indexrelid = 'payroll_statutory_rates_org_point'::regclass
    `));
    assert.ok(
      pred.rows[0]?.indpred?.includes("superseded_on"),
      "pg_index.indpred must carry the partial predicate",
    );
  },
);

/* ------------------------------------------------------------------ */
/* The chain, against a real Postgres                                  */
/* ------------------------------------------------------------------ */

test(
  "three saves of one scope point chain three rows, and each date answers its own",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const v1 = await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.006" },
      });
      const v2 = await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.009" },
      });
      const v3 = await upsertStatutoryRate({
        orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
        region: "MI", filingAccountId: null, taxYear: 2026, values: { rate: "0.012" },
      });
      // Three distinct ids: no row was ever rewritten.
      assert.equal(new Set([v1.id, v2.id, v3.id]).size, 3);
      // Pin the chain to fixed dates — the writer stamps CURRENT_DATE, and
      // the resolver is what is under test here, not the clock.
      await db.execute(sql`
        update payroll_statutory_rates set superseded_on = '2026-03-01' where id = ${v1.id}`);
      await db.execute(sql`
        update payroll_statutory_rates set superseded_on = '2026-06-01' where id = ${v2.id}`);
      // The live read answers the successor; the default list shows one row.
      assert.equal(
        (await resolveStatutoryRates(org.orgId, US_PACK_RATES, 2026))
          .values("us_futa", { region: "MI" })?.rate,
        "0.0120",
      );
      assert.equal((await listStatutoryRates(org.orgId, { country: "US" })).length, 1);
      assert.equal(
        (await listStatutoryRates(org.orgId, { country: "US", includeSuperseded: true })).length,
        3,
      );
      // Each date answers its own row, through the real reader.
      const at = async (asOf: string) => (await resolveStatutoryRates(
        org.orgId, US_PACK_RATES, 2026, asOf,
      )).values("us_futa", { region: "MI" })?.rate;
      assert.equal(await at("2026-02-01"), "0.0060");
      assert.equal(await at("2026-04-15"), "0.0090");
      assert.equal(await at("2026-07-01"), "0.0120");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

/* ------------------------------------------------------------------ */
/* A committed run, recalculated after a re-save                       */
/* ------------------------------------------------------------------ */

interface CommittedFixture {
  orgId: string;
  actorId: string;
  scheduleId: string;
  employeeId: string;
  documentId: string;
  payDate: string;
}

async function seedCommittedRun(): Promise<CommittedFixture> {
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
  // A QC employer always owes the HSF at its own rate: a live-but-
  // unconfigured slot refuses by name at calculate, so the fixture carries a
  // rate and a mapping (inert for every ON run).
  await db.execute(sql`
    insert into payroll_statutory_rates (org_id, country, rate_key, region, tax_year,
                                         rate_values, created_by, updated_by)
    values (${org.orgId}, 'CA', 'ca_hsf', 'QC', 2026, '{"rate": "1.65"}',
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    update pay_components set liability_account_id = ${craPayable}
     where org_id = ${org.orgId} and system_key = 'hsf'`);
  // The EHT employer line posts its liability here; without the mapping the
  // run calculates but cannot commit.
  await db.execute(sql`
    update pay_components set liability_account_id = ${craPayable}
     where org_id = ${org.orgId} and system_key = 'eht'`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'person', 'Harriet History', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (org_id, party_id, hired_on, is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, '2020-01-06', true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, effective_from,
                                  is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, 'CAD', '30', 'hour', '2020-01-01', true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, country, federal_claim_code,
                                           provincial_claim_code, vacation_percent, vacation_method,
                                           is_active, created_by, updated_by)
    values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 'CA', 1, 1,
            '4', 'accrue', true, ${actorId}, ${actorId})`);

  // Ontario EHT at 1.95% above a 1,000.00 exemption: 80h × $30 = 2,400.00 of
  // earnings leaves 1,400.00 taxable, so the run accrues 27.30 of employer
  // health tax — the figure the re-save must not move.
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: CA_PACK_RATES, rateKey: "ca_eht",
    region: "ON", filingAccountId: null, taxYear: 2026,
    values: { rate: "1.95", annualExemption: "1000" },
  });

  for (const workedOn of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
    await db.execute(sql`
      insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                billing_status, costing_basis, created_by, updated_by)
      values (${org.orgId}, ${employeeId}, ${workedOn}, 20, 'approved', false,
              'unbilled', 'actual', ${actorId}, ${actorId})`);
  }
  const payDate = "2026-07-21";
  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18", payDate,
  });
  const calc = await calculatePayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
  assert.deepEqual(calc.errors, []);
  await commitPayRun({ orgId: org.orgId, documentId: run.documentId, actorId });
  return { orgId: org.orgId, actorId, scheduleId, employeeId, documentId: run.documentId, payDate };
}

async function ehtLine(
  orgId: string, documentId: string,
): Promise<{ gross: string; netPay: string; employerCost: string; eht: string }> {
  const stub = (await db.execute<{ gross: string; net_pay: string; employer_cost: string }>(sql`
    select gross, net_pay, employer_cost from pay_stubs
     where org_id = ${orgId} and pay_run_document_id = ${documentId}`)).rows[0]!;
  const lines = (await db.execute<{ amount: string }>(sql`
    select l.amount from pay_stub_lines l
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId} and l.stub_id in (
       select id from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
     ) and c.system_key = 'eht'`));
  assert.equal(lines.rows.length, 1, "the committed run carries exactly one EHT line");
  return {
    gross: String(stub.gross), netPay: String(stub.net_pay),
    employerCost: String(stub.employer_cost), eht: String(lines.rows[0]!.amount),
  };
}

test(
  "a committed run recalculated after a rate re-save answers to the cent what it committed",
  { skip: !DB },
  async () => {
    const fx = await seedCommittedRun();
    try {
      const committed = await ehtLine(fx.orgId, fx.documentId);
      assert.equal(committed.gross, "2400.0000");
      // cmp, not string equality: the stored line is numeric(19,4) ("27.3000")
      // while the replay carries the pushed "27.30" — same cents, and cents
      // are what this test is about.
      assert.equal(cmp(committed.eht, "27.30"), 0);

      // Mid-year correction: the province's notice was wrong, or the
      // employer's remuneration crossed into a higher rate. The open row is
      // superseded; the committed period must not move. The correction takes
      // effect 25 July — after the committed run's pay date (21 July) and
      // before the next period's (4 Aug) — pinned explicitly, because the
      // writer stamps the recording date and the test's pay dates are
      // deliberately earlier than today.
      const corrected = await upsertStatutoryRate({
        orgId: fx.orgId, actorId: fx.actorId, rates: CA_PACK_RATES, rateKey: "ca_eht",
        region: "ON", filingAccountId: null, taxYear: 2026,
        values: { rate: "2.95", annualExemption: "1000" },
      });
      await db.execute(sql`
        update payroll_statutory_rates set superseded_on = '2026-07-25'
         where org_id = ${fx.orgId} and country = 'CA' and rate_key = 'ca_eht'
           and region = 'ON' and tax_year = 2026 and id <> ${corrected.id}`);
      assert.equal(
        (await resolveStatutoryRates(fx.orgId, CA_PACK_RATES, 2026))
          .values("ca_eht", { region: "ON" })?.rate,
        "2.9500",
        "the new rate is live for new periods",
      );

      // Recalculate the COMMITTED run as it would calculate today, rolled
      // back: every figure must match the committed one to the cent.
      const replay = await calculatePayRun({
        orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId, simulate: true,
      });
      assert.deepEqual(replay.errors, []);
      assert.ok(replay.stubs && replay.stubs.length === 1);
      const stub = replay.stubs[0]!;
      const replayEht = stub.lines.find((line) => line.systemKey === "eht");
      assert.ok(replayEht, "the replay carries the EHT line");
      assert.equal(stub.gross, committed.gross);
      assert.equal(stub.netPay, committed.netPay);
      assert.equal(stub.employerCost, committed.employerCost);
      assert.equal(cmp(replayEht.amount, committed.eht), 0);

      // Control: a LATER period genuinely reads the new rate. The 1,000.00
      // exemption is consumed by the committed run's 2,400.00 of EHT_EARN, so
      // the new period accrues the full 2,400.00 × 2.95% = 70.80.
      for (const workedOn of ["2026-07-20", "2026-07-22", "2026-07-24", "2026-07-28"]) {
        await db.execute(sql`
          insert into time_entries (org_id, employee_party_id, worked_on, hours, status, is_billable,
                                    billing_status, costing_basis, created_by, updated_by)
          values (${fx.orgId}, ${fx.employeeId}, ${workedOn}, 20, 'approved', false,
                  'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
      }
      const run2 = await createPayRun({
        orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
        periodStart: "2026-07-19", periodEnd: "2026-08-01", payDate: "2026-08-04",
      });
      const calc2 = await calculatePayRun({
        orgId: fx.orgId, documentId: run2.documentId, actorId: fx.actorId,
      });
      assert.deepEqual(calc2.errors, []);
      assert.equal(cmp((await ehtLine(fx.orgId, run2.documentId)).eht, "70.80"), 0);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
