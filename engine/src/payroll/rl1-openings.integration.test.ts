import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { rl1Slips, rl1Summary } from "./canada/quebec/rl1.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The RL-1's opening-balance carry-in, end to end.
 *
 * A mid-year adopter's Québec employees carry pre-adoption YTD on
 * `payroll_opening_balances`. The T4 folds it into boxes 14/16/16A/18/22/24/26
 * and the W-2 into 1/2/3/5; the RL-1 used to read committed stubs only, so
 * the same employee's RL-1 understated boxes A/B.A/B.B/C/H/G against their
 * own T4 and against the prior provider's YTD report. These tests pin the
 * carry-in (and its deliberate exclusions: boxes E/F/I have no opening
 * source, exactly as the T4 refuses 44/56) through `rl1Slips` itself.
 */

type QcFixture = {
  orgId: string;
  actorId: string;
  qcStubEmployee: string;
  qcOpeningOnlyEmployee: string;
  onOpeningOnlyEmployee: string;
};

async function seedQcYear(): Promise<QcFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

  const earningId = randomUUID();
  const qcTaxId = randomUUID();
  const unionId = randomUUID();
  await db.execute(sql`
    insert into pay_components (id, org_id, code, name, kind, country, taxable, created_by, updated_by)
    values (${earningId}, ${org.orgId}, 'SAL', 'Salary', 'earning', 'CA', true, ${actorId}, ${actorId}),
           (${qcTaxId}, ${org.orgId}, 'QCTAX', 'Quebec tax', 'deduction', 'CA', false, ${actorId}, ${actorId}),
           (${unionId}, ${org.orgId}, 'DUES', 'Union dues', 'deduction', 'CA', false, ${actorId}, ${actorId})`);
  await db.execute(sql`
    update pay_components set system_key = 'qc_income_tax' where id = ${qcTaxId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    update pay_components set tax_treatment = 'union_dues' where id = ${unionId} and org_id = ${org.orgId}`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  const qcStubEmployee = randomUUID();
  const qcOpeningOnlyEmployee = randomUUID();
  const onOpeningOnlyEmployee = randomUUID();
  for (const [id, name, province] of [
    [qcStubEmployee, "Marie Tremblay", "QC"],
    [qcOpeningOnlyEmployee, "Jean Lapointe", "QC"],
    [onOpeningOnlyEmployee, "Oliver Twist", "ON"],
  ] as const) {
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, is_active, subsidiary_id, custom)
      values (${id}, ${org.orgId}, 'person', ${name}, true, ${org.subsidiaryId}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                             pay_basis, country, federal_claim_code,
                                             provincial_claim_code, vacation_percent, vacation_method,
                                             is_active, created_by, updated_by)
      values (${org.orgId}, ${id}, ${scheduleId}, ${province}, 'hourly', 'CA', 1, 1, '4', 'accrue',
              true, ${actorId}, ${actorId})`);
  }

  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${org.orgId}, ${documentId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-21', 'CAD', 'draft', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
                          tax_year, run_status, calculated_at, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-05', '2026-07-18', '2026-07-21',
            2026, 'committed', now(), ${actorId}, ${actorId})`);

  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, currency_code, gross, net_pay,
                           pensionable_earnings, insurable_earnings, factors, created_by, updated_by)
    values (${stubId}, ${org.orgId}, ${documentId}, ${qcStubEmployee}, 'QC', 26, '2026-07-21',
            2026, 'CAD', '30000.0000', '24000.0000', '30000.0000', '30000.0000',
            ${JSON.stringify({ C: "1500.00", EI: "390.00", QPIP: "129.00" })}::jsonb,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount,
                                created_by, updated_by)
    values (${org.orgId}, ${stubId}, ${earningId}, 'earning', 'Salary', '30000.0000',
            ${actorId}, ${actorId}),
           (${org.orgId}, ${stubId}, ${qcTaxId}, 'deduction', 'Quebec tax', '2000.0000',
            ${actorId}, ${actorId}),
           (${org.orgId}, ${stubId}, ${unionId}, 'deduction', 'Union dues', '300.0000',
            ${actorId}, ${actorId})`);

  // Prior-provider YTD for all three employees. The ON employee's row proves
  // the RL-1 does not conjure a Québec slip from an opening alone.
  for (const [id, taxable, pensionable] of [
    [qcStubEmployee, "10000.0000", "10000.0000"],
    [qcOpeningOnlyEmployee, "5000.0000", "5000.0000"],
    [onOpeningOnlyEmployee, "7000.0000", "7000.0000"],
  ] as const) {
    await db.execute(sql`
      insert into payroll_opening_balances (org_id, employee_party_id, tax_year, pensionable_ytd,
                                            insurable_ytd, cpp_ytd, cpp2_ytd, ei_ytd, qpip_ytd,
                                            taxable_ytd, tax_ytd, created_by, updated_by)
      values (${org.orgId}, ${id}, 2026, ${pensionable}, '9000.0000', '500.0000', '50.0000',
              '100.0000', '40.0000', ${taxable}, '1500.0000', ${actorId}, ${actorId})`);
  }

  return { orgId: org.orgId, actorId, qcStubEmployee, qcOpeningOnlyEmployee, onOpeningOnlyEmployee };
}

test(
  "RL-1 folds pre-adoption YTD into boxes A/B.A/B.B/C/H/G, before the caps",
  { skip: !DB },
  async () => {
    const fx = await seedQcYear();
    try {
      const slips = await rl1Slips(fx.orgId, 2026);
      const stub = slips.find((slip) => slip.employeePartyId === fx.qcStubEmployee);
      assert.ok(stub, "the QC employee with committed stubs has an RL-1 slip");
      assert.equal(stub.boxA, "40000.0000", "30000 stubs + 10000 opening");
      assert.equal(stub.boxBA, "2000.0000", "1500 QPP + 500 opening");
      assert.equal(stub.boxBB, "50.0000", "0 + 50 opening");
      assert.equal(stub.boxC, "490.0000", "390 EI + 100 opening");
      assert.equal(stub.boxH, "169.0000", "129 QPIP + 40 opening");
      assert.equal(stub.boxG, "40000.0000", "30000 + 10000 pensionable, under the YMPE");
      assert.equal(stub.boxI, "30000.0000", "stub insurable only: no QPIP-salary opening source");
      assert.equal(stub.boxE, "2000.0000", "stub QC tax only: tax_ytd is federal money");
      assert.equal(stub.boxF, "300.0000", "stub dues only: no union-dues YTD column");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "RL-1 seeds a slip for an opening-only Québec employee, and none for an Ontario one",
  { skip: !DB },
  async () => {
    const fx = await seedQcYear();
    try {
      const slips = await rl1Slips(fx.orgId, 2026);
      const seeded = slips.find((slip) => slip.employeePartyId === fx.qcOpeningOnlyEmployee);
      assert.ok(seeded, "an opening-only QC employee appears on the RL-1");
      assert.equal(seeded.stubCount, 0);
      assert.equal(seeded.boxA, "5000.0000");
      assert.equal(seeded.boxBA, "500.0000");
      assert.equal(seeded.boxBB, "50.0000");
      assert.equal(seeded.boxC, "100.0000");
      assert.equal(seeded.boxH, "40.0000");
      assert.equal(seeded.boxG, "5000.0000");
      assert.equal(seeded.boxI, "0");
      assert.ok(
        !slips.some((slip) => slip.employeePartyId === fx.onOpeningOnlyEmployee),
        "an opening-only ON employee gets no RL-1 slip",
      );
      const summary = await rl1Summary(fx.orgId, 2026);
      assert.equal(summary.slips, 2);
      assert.equal(summary.boxA, "45000.0000");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
