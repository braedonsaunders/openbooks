import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
} from "./remittance.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The remittance bill's due date follows the CRA calendar its payroll is on.
 *
 * `remittanceDueDate` has always accepted `{ quebec: true }` for the CRA's
 * Québec holiday schedule (CA-CRA-QC: Saint-Jean-Baptiste Day observed, the
 * Civic Holiday not), but no production caller ever passed it — every bill
 * stamped the federal calendar. For a Québec-only accelerated-threshold-2
 * payroll closing July 2026 that stamps August 6, a full day AFTER the true
 * August 5 deadline: a late remittance at 3–10% penalty. This pins the bill's
 * own due_date through `createRemittanceBill`.
 */

async function seedQuebecAccelerated2(): Promise<{ orgId: string; actorId: string; accountId: string; vendorId: string }> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

  const accountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         remitter_type, is_default)
    values (${accountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0002', 'Quebec division',
            'accelerated_2', true)`);

  const liabilityAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${liabilityAccountId}, ${org.orgId}, '2310', 'CRA payable', 'liability_current',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${org.vendorId}, true, ${actorId}, ${actorId})
    on conflict do nothing`);
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, system_key, liability_account_id,
       remittance_party_id, sequence, country, created_by, updated_by)
    values (${componentId}, ${org.orgId}, 'QCTAX-1', 'Quebec withholding', 'deduction', 'income_tax',
            ${liabilityAccountId}, ${org.vendorId}, 10, 'CA', ${actorId}, ${actorId})`);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Quebec weekly', 'weekly', 52,
            '2026-07-31', 0, true, ${actorId}, ${actorId})`);

  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${employeeId}, ${org.orgId}, 'person', 'Quebec Employee',
            ${org.subsidiaryId}, true, '{}'::jsonb, ${actorId}, ${actorId})`);
  const documentId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, posting_period_id, currency, status, memo, created_by, updated_by)
    values (${documentId}, ${org.orgId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${org.subsidiaryId}, '2026-07-31', '2026-07-31', ${org.periodId},
            'CAD', 'draft', 'Quebec July source', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values (${documentId}, ${org.orgId}, ${scheduleId}, '2026-07-25', '2026-07-31', '2026-07-31',
            2026, 'committed', 'regular', ${actorId}, ${actorId})`);
  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, filing_account_id, filing_account_source,
       created_by, updated_by)
    values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, 'QC', 52,
            '2026-07-31', 2026, 'CAD', '2000.0000', '2000.0000', '2000.0000', '1600.0000',
            '2000.0000', '0', '{}'::jsonb, ${accountId}, 'calculation', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${stubId}, ${componentId}, 'deduction',
            'Quebec withholding', '400.0000', 10, ${liabilityAccountId}, 'commit',
            ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, accountId, vendorId: org.vendorId };
}

test(
  "a Quebec-only accelerated-2 bill is due on the Quebec calendar, not the federal one",
  { skip: !DB },
  async () => {
    const fx = await seedQuebecAccelerated2();
    try {
      const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0]!.provinces, ["QC"]);

      const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: fx.vendorId,
        from: "2026-07-01",
        to: "2026-07-31",
        filingAccountId: fx.accountId,
      });
      const billDoc = ((await db.execute<Record<string, unknown>>(sql`
        select due_date from documents where id = ${bill.documentId}`))).rows[0]!;
      // The July 22-to-31 quarter-month ends Friday July 31 2026. Three
      // working days is August 6 nationally but August 5 in Quebec — the
      // Civic Holiday (Aug 3) is not observed there. A bill stamping the 6th
      // pays a Quebec remittance a day late.
      assert.equal(String(billDoc.due_date).slice(0, 10), "2026-08-05");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
