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
 * Remittance bills whose destination is Revenu Québec are dated from the RQ
 * schedule the CA pack declares — never from the filing account's CRA
 * remitter type.
 *
 * The load-bearing case is a Québec payroll on a CRA accelerated-threshold-2
 * account: the old code stamped the CRA's working-day-counted threshold-2
 * date (August 5 for a July 2026 close on the Québec calendar), a schedule
 * Revenu Québec never set. The RQ schedule has no threshold 2 — the same
 * close at the default monthly frequency is due August 17 — and the CRA
 * registration must not leak across agencies.
 */

interface RqFixture {
  orgId: string;
  actorId: string;
  accountId: string;
  craVendorId: string;
  rqVendorId: string;
}

async function seedRqPayroll(options: {
  frequency?: string;
  stubProvince?: string;
  systemKey?: string;
  componentCode?: string;
  componentName?: string;
  externalParty?: boolean;
}): Promise<RqFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const province = options.stubProvince ?? "QC";
  const systemKey = options.systemKey ?? "qpip";

  const accountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         remitter_type, is_default)
    values (${accountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0009', 'Quebec division',
            'accelerated_2', true)`);

  // The org's Revenu Québec vendor: a second payee alongside the CRA vendor
  // the scratch org ships with.
  const rqVendorId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${rqVendorId}, ${org.orgId}, 'business', 'Revenu Quebec fixture vendor',
            ${org.subsidiaryId}, true, '{}'::jsonb, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, is_active, created_by, updated_by)
    values (${org.orgId}, ${rqVendorId}, true, ${actorId}, ${actorId})
    on conflict do nothing`);
  // NB: jsonb_set does not create intermediate objects — ensure the payroll
  // subtree exists before setting nested keys, or the update is a silent no-op.
  // The frequency key is written only when the caller names one: an absent
  // key is the genuine unconfigured path (the schedule default applies).
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', coalesce(settings->'payroll', '{}'::jsonb)),
         '{payroll,rqRemittancePartyId}', to_jsonb(${rqVendorId}::text))
     where id = ${org.orgId}`);
  if (options.frequency !== undefined) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
           '{payroll,rqRemittanceFrequency}', to_jsonb(${options.frequency}::text))
       where id = ${org.orgId}`);
  }

  const liabilityAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${liabilityAccountId}, ${org.orgId}, '2320', 'RQ payable', 'liability_current',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  const componentId = randomUUID();
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, system_key, liability_account_id,
       remittance_party_id, sequence, country, created_by, updated_by)
    values (${componentId}, ${org.orgId}, ${options.componentCode ?? 'QPIP-1'}, ${options.componentName ?? 'QPIP'},
            'deduction', ${systemKey}, ${liabilityAccountId},
            ${options.externalParty === true ? rqVendorId : null}, 10, 'CA', ${actorId}, ${actorId})`);

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
    values (${stubId}, ${org.orgId}, ${documentId}, ${employeeId}, ${province}, 52,
            '2026-07-31', 2026, 'CAD', '2000.0000', '2000.0000', '2000.0000', '1600.0000',
            '2000.0000', '0', '{}'::jsonb, ${accountId}, 'calculation', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${stubId}, ${componentId}, 'deduction',
            ${options.componentName ?? 'QPIP'}, '400.0000', 10, ${liabilityAccountId}, 'commit',
            ${actorId}, ${actorId})`);
  return { orgId: org.orgId, actorId, accountId, craVendorId: org.vendorId, rqVendorId };
}

async function billDueDate(documentId: string): Promise<{ dueDate: string; custom: Record<string, unknown> }> {
  const row = ((await db.execute<Record<string, unknown>>(sql`
    select due_date, custom from documents where id = ${documentId}`))).rows[0]!;
  return { dueDate: String(row.due_date).slice(0, 10), custom: row.custom as Record<string, unknown> };
}

test(
  "an RQ bill on an accelerated-2 CRA account is due on the RQ schedule, not threshold 2",
  { skip: !DB },
  async () => {
    const fx = await seedRqPayroll({});
    try {
      const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(groups.length, 1);
      const group = groups[0]!;
      assert.equal(group.partyId, fx.rqVendorId);
      // The group is governed by the declared RQ schedule at the default
      // monthly frequency — the account's accelerated_2 CRA registration does
      // not cross agencies.
      assert.deepEqual(group.schedule, {
        vendorSettingsKey: "rqRemittancePartyId",
        authority: "Revenu Québec",
        frequency: "monthly",
        frequencySource: "default",
        dueDate: "2026-08-17",
        rule: group.schedule!.rule,
      });
      assert.match(group.schedule!.rule, /Revenu Québec monthly remitter/);

      const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: fx.rqVendorId,
        from: "2026-07-01",
        to: "2026-07-31",
        filingAccountId: fx.accountId,
      });
      const { dueDate, custom } = await billDueDate(bill.documentId);
      // The CRA threshold-2 date for this close is August 5 on the Québec
      // calendar; the RQ monthly date is August 17 (the 15th is a Saturday).
      // Stamping the 5th would remit twelve days early under the wrong
      // agency's rule — and for other closes the error points the other way.
      assert.equal(dueDate, "2026-08-17");
      const marker = (custom.payrollRemittance as Record<string, unknown>);
      assert.deepEqual(marker.schedule, {
        vendorSettingsKey: "rqRemittancePartyId",
        authority: "Revenu Québec",
        frequency: "monthly",
      });
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a configured twice-monthly RQ frequency dates the bill's halves",
  { skip: !DB },
  async () => {
    const fx = await seedRqPayroll({ frequency: "twice_monthly" });
    try {
      const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(groups[0]!.schedule?.frequency, "twice_monthly");
      assert.equal(groups[0]!.schedule?.frequencySource, "configured");
      const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: fx.rqVendorId,
        from: "2026-07-01",
        to: "2026-07-31",
        filingAccountId: fx.accountId,
      });
      const { dueDate } = await billDueDate(bill.documentId);
      // Second-half July: due the 10th of the following month (a Monday).
      assert.equal(dueDate, "2026-08-10");
      assert.match(groups[0]!.schedule!.rule, /16th to month end, due the 10th/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an external component pointed at the RQ vendor is RQ-scheduled by party",
  { skip: !DB },
  async () => {
    // Québec income tax (`external`) carries its destination on the component,
    // not through a regional key — and the stub need not be Québec employment
    // for the DESTINATION's schedule to govern. (Ontario employment whose
    // Québec tax points at the RQ vendor is contrived, but the resolution path
    // — by party, not by province — is exactly what production relies on.)
    const fx = await seedRqPayroll({
      stubProvince: "ON",
      systemKey: "qc_income_tax",
      componentCode: "QCTAX-1",
      componentName: "Quebec income tax",
      externalParty: true,
    });
    try {
      const groups = await payrollRemittanceSummary(fx.orgId, { from: "2026-07-01", to: "2026-07-31" });
      assert.equal(groups.length, 1);
      assert.deepEqual(groups[0]!.vendorKeys, []);
      assert.equal(groups[0]!.schedule?.authority, "Revenu Québec");
      const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: fx.rqVendorId,
        from: "2026-07-01",
        to: "2026-07-31",
        filingAccountId: fx.accountId,
      });
      const { dueDate } = await billDueDate(bill.documentId);
      assert.equal(dueDate, "2026-08-17");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
