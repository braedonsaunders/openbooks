import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { describe } from "node:test";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { db } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { setPackSlotAccount } from "./packs.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { createPayRun } from "./run-lifecycle.ts";
import { seedPayrollComponents } from "./run-setup.ts";
import { US_PACK_RATES } from "./us/rates.ts";
import { upsertStatutoryRate } from "./statutory-rates.ts";
import {
  createScratchOrg, dropScratchOrgReporting, seedFlowActors, seedWorkerEmployment,
} from "../testing/fixtures.ts";
import { seedUsSuiAccount } from "./filing-test-fixtures.ts";

/**
 * A pay-run calculation must never hold a number_sequences row lock.
 *
 * The calculation runs one long transaction; the pay run's own number is
 * allocated in the short creation step before it, and no other number is
 * allocated inside it. These tests pin both contention directions with real
 * locks held open on a second connection (the admin test URL is superuser,
 * so the holder sees the same rows outside any transaction):
 *
 *   - a locked number_sequences row does not block the calculation (the
 *     calculation takes no sequence lock, early or late);
 *   - a locked pay_runs row (the calculation's own claim) does not block
 *     another document's number allocation in the same org.
 *
 * Either direction regressing means numbered documents — or schema
 * maintenance — queue behind a minutes-long payroll transaction again.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const PAY_DATE = "2026-07-21";
const PERIOD_START = "2026-07-05";
const PERIOD_END = "2026-07-18";

async function holdOpen(): Promise<{ query: (text: string, values?: unknown[]) => Promise<unknown>; done: () => Promise<void> }> {
  const pool = new Pool({ connectionString: process.env.OPENBOOKS_DB_URL!, max: 1 });
  const client = await pool.connect();
  await client.query("BEGIN");
  return {
    query: (text: string, values?: unknown[]) => client.query(text, values),
    done: async () => {
      try { await client.query("COMMIT"); } finally { client.release(); await pool.end(); }
    },
  };
}

async function withHangGuard<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} is blocked behind a held lock`)), 60_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface Fixture { orgId: string; actorId: string; documentId: string }

async function calculableOrg(): Promise<Fixture> {
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
  const netPayable = await account("2300", "Wages payable", "liability_current");
  const payrollPayable = await account("2330", "Payroll taxes payable", "liability_current");
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: wageExpense,
        burdenExpenseAccountId: burdenExpense,
        netPayAccountId: netPayable,
        wagesTo: "expense",
        countries: ["US"],
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "US");
  for (const slot of ["fit", "fica", "futa", "suta", "state_income_tax"]) {
    await setPackSlotAccount(org.orgId, actorId, "US", slot, payrollPayable);
  }
  const filingAccountId = await seedUsSuiAccount(org.orgId, actorId, "CA");
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_sui",
    region: "CA", filingAccountId, taxYear: 2026, values: { rate: "0.03", wageBase: "7000" },
  });
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_futa",
    region: "CA", filingAccountId: null, taxYear: 2026, values: { rate: "0.006" },
  });
  // A deficit UI reserve balance is ETT-exempt: no leg posts, and these
  // tests (numbering contention, never ETT) assert none of it.
  await upsertStatutoryRate({
    orgId: org.orgId, actorId, rates: US_PACK_RATES, rateKey: "us_ca_ett",
    region: "CA", filingAccountId: null, taxYear: 2026,
    values: { reserveBalance: "-100.00" },
  });
  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids,
                              is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'US Entity', 'USD', 'US',
            '{}'::jsonb, false, true, '{}'::jsonb)`);
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, subsidiary_id, is_active,
                               created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly US', 'biweekly', 26, ${PERIOD_END}, 3,
            ${subsidiaryId}, true, ${actorId}, ${actorId})`);
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${partyId}, ${org.orgId}, 'person', 'Cally CA', ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${partyId})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${partyId}, 'USD', '52000', 'year', 2080, '2026-01-01', true,
            ${actorId}, ${actorId})`);
  const employmentId = await seedWorkerEmployment(org.orgId, partyId, subsidiaryId);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, employment_id, pay_schedule_id,
                                           country, province, pay_basis,
                                           filing_status, filing_account_id, is_active,
                                           created_by, updated_by)
    values (${org.orgId}, ${partyId}, ${employmentId}, ${scheduleId}, 'US', 'CA',
            'salary', 'single', ${filingAccountId}, true,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into employee_tax_certificates (org_id, employee_party_id, country, certificate_key,
                                           region, sub_region, answers, effective_from,
                                           created_by, updated_by)
    values (${org.orgId}, ${partyId}, 'US', 'us_w4_tax_residency', null, null,
            '{"alien_status": "us_person_or_resident_alien"}'::jsonb, '2026-01-01',
            ${actorId}, ${actorId})`);
  const run = await createPayRun({
    orgId: org.orgId, actorId, payScheduleId: scheduleId,
    periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE,
  });
  return { orgId: org.orgId, actorId, documentId: run.documentId };
}

describe("calculation-holds-no-sequence-lock", { skip: !DB }, () => {
  test("locked number_sequences rows do not block the calculation", async () => {
    const fx = await calculableOrg();
    const holder = await holdOpen();
    try {
      // The locks concurrent documents' allocations would take — the run's
      // own series row (allocated in the short creation step) and a vendor
      // payment row — both held open for the whole calculation below. The
      // calculation allocates no number, so it needs neither.
      await holder.query(
        `insert into number_sequences as s (org_id, document_kind, prefix, next_number, padding, allocated_through) ` +
        `values ($1, 'vendor_payment', 'AP-', 1, 5, 0) ` +
        `on conflict on constraint sequences_org_kind_sub do update set next_number = s.next_number + 1 ` +
        `where s.org_id = $1 returning prefix`,
        [fx.orgId],
      );
      await holder.query(
        `update number_sequences set next_number = next_number where org_id = $1 and document_kind = 'pay_run'`,
        [fx.orgId],
      );
      const result = await withHangGuard("pay-run calculation",
        calculatePayRun({ orgId: fx.orgId, documentId: fx.documentId, actorId: fx.actorId }));
      assert.deepEqual(result.errors, []);
      assert.equal(result.employees, 1);
    } finally {
      await holder.done();
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("the calculation's own row lock does not block another document's numbering", async () => {
    const fx = await calculableOrg();
    const holder = await holdOpen();
    try {
      // The calculation's claim on its run row, held open while another
      // document allocates — the report's blocked party proceeds.
      await holder.query(
        `select document_id from pay_runs where org_id = $1 and document_id = $2 for update`,
        [fx.orgId, fx.documentId],
      );
      const number = await withHangGuard("concurrent document numbering",
        allocateDocumentNumber(db, fx.orgId, "vendor_payment", "AP-"));
      assert.match(number, /^AP-\d+$/);
    } finally {
      await holder.done();
      await dropScratchOrgReporting(fx.orgId);
    }
  });

  test("new pay runs mint PR- numbers while vendor payments keep PAY-", async () => {
    const fx = await calculableOrg();
    try {
      // The defaults that end the shared-prefix ambiguity: the run created
      // above numbers PR-00001, and the only sequence row in the org is the
      // run's own — the calculation allocates nothing further.
      const rows = (await db.execute<{ document_kind: string; prefix: string; document_number: string }>(sql`
        select s.document_kind, s.prefix, d.document_number
          from number_sequences s
          join pay_runs r on r.org_id = s.org_id and r.document_id = ${fx.documentId}
          join documents d on d.org_id = r.org_id and d.id = r.document_id
         where s.org_id = ${fx.orgId}`)).rows;
      assert.deepEqual(rows, [{ document_kind: "pay_run", prefix: "PR-", document_number: "PR-00001" }]);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  });
});
