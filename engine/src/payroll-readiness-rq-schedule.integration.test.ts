import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { payrollSetupState } from "./payroll-readiness.ts";
import { scheduledFrequencyAdvisory } from "./payroll-remittance.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Readiness for scheduled remittance destinations: the RQ frequency check
 * names what applies when the org has not confirmed it, and the prior-year
 * advisory catches a large employer left on the monthly default.
 *
 * The advisory measures the destination's committed prior-year total over 12
 * calendar months and compares bands — it can only warn, never re-date a bill.
 */

interface RqOrg {
  orgId: string;
  actorId: string;
  accountId: string;
  rqVendorId: string;
  employeeId: string;
  scheduleId: string;
  componentId: string;
  liabilityAccountId: string;
}

async function seedRqOrg(frequency: string | null): Promise<RqOrg> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;

  const accountId = randomUUID();
  await db.execute(sql`
    insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name,
                                         remitter_type, is_default)
    values (${accountId}, ${org.orgId}, 'CA', 'ca_rp', '123456789RP0007', 'Quebec division',
            'regular', true)`);

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
  // jsonb_set creates no intermediate objects: ensure the payroll subtree first.
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(coalesce(settings, '{}'::jsonb), '{payroll}', coalesce(settings->'payroll', '{}'::jsonb)),
         '{payroll,rqRemittancePartyId}', to_jsonb(${rqVendorId}::text))
     where id = ${org.orgId}`);
  if (frequency !== null) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb),
           '{payroll,rqRemittanceFrequency}', to_jsonb(${frequency}::text))
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
    values (${componentId}, ${org.orgId}, 'QPIP-7', 'QPIP', 'deduction', 'qpip',
            ${liabilityAccountId}, null, 10, 'CA', ${actorId}, ${actorId})`);

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
  return {
    orgId: org.orgId, actorId, accountId, rqVendorId, employeeId, scheduleId,
    componentId, liabilityAccountId,
  };
}

async function seedCommittedRun(
  fx: RqOrg,
  periodId: string,
  payDate: string,
  taxYear: number,
  amount: string,
  line?: { liabilityAccountId?: string | null; liabilityAccountSource?: string },
): Promise<void> {
  const documentId = randomUUID();
  const subsidiaryId = await subsidiaryOf(fx.orgId);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, posting_period_id, currency, status, memo, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, 'pay_run', ${`PAY-${documentId.slice(0, 8)}`},
            ${subsidiaryId},
            ${payDate}, ${payDate}, ${periodId},
            'CAD', 'draft', 'RQ source', ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values (${documentId}, ${fx.orgId}, ${fx.scheduleId}, ${payDate}, ${payDate}, ${payDate},
            ${taxYear}, 'committed', 'regular', ${fx.actorId}, ${fx.actorId})`);
  const stubId = randomUUID();
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, filing_account_id, filing_account_source,
       created_by, updated_by)
    values (${stubId}, ${fx.orgId}, ${documentId}, ${fx.employeeId}, 'QC', 52,
            ${payDate}, ${taxYear}, 'CAD', ${amount}, ${amount}, ${amount}, ${amount},
            ${amount}, '0', '{}'::jsonb, ${fx.accountId},
            'calculation', ${fx.actorId}, ${fx.actorId})`);
  // An unknown historical liability account is the legacy state the summary
  // refuses to read (migration 0093's trigger rewrites unknown filing
  // attribution at insert, so the line account is the insertable refusal).
  const liabilityAccountId = line?.liabilityAccountId === undefined ? fx.liabilityAccountId : line.liabilityAccountId;
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, created_by, updated_by)
    values (${randomUUID()}, ${fx.orgId}, ${stubId}, ${fx.componentId}, 'deduction',
            'QPIP', ${amount}, 10, ${liabilityAccountId},
            ${line?.liabilityAccountSource ?? 'commit'},
            ${fx.actorId}, ${fx.actorId})`);
}

async function subsidiaryOf(orgId: string): Promise<string> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null and is_active
     order by created_at limit 1`)).rows[0]!;
  return row.id;
}

async function period2025(orgId: string): Promise<string> {
  const calendar = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} order by created_at limit 1`)).rows[0]!;
  const periodId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on,
                                    is_adjustment, fiscal_calendar_id)
    values (${periodId}, ${orgId}, 2025, 12, '2025-12', '2025-12-01', '2025-12-31', false, ${calendar.id})`);
  return periodId;
}

async function payrollBlob(orgId: string): Promise<Record<string, unknown>> {
  const row = (await db.execute<{ p: Record<string, unknown> | null }>(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}`)).rows[0]!;
  return row.p ?? {};
}

function frequencyChecks(state: Awaited<ReturnType<typeof payrollSetupState>>): { ok: boolean; detail?: string }[] {
  return state.checks.filter((check) => check.code === "setup.remittanceFrequency");
}

test(
  "an unset RQ frequency warns and names the default that applies",
  { skip: !DB },
  async () => {
    const fx = await seedRqOrg(null);
    try {
      const failed = frequencyChecks(await payrollSetupState(fx.orgId));
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.ok, false);
      assert.match(failed[0]!.detail ?? "", /Revenu Québec remittance frequency is not set/);
      assert.match(failed[0]!.detail ?? "", /the monthly frequency applies/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "an undeclared RQ frequency warns instead of silently dating from the default",
  { skip: !DB },
  async () => {
    const fx = await seedRqOrg("weekly");
    try {
      const failed = frequencyChecks(await payrollSetupState(fx.orgId));
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.ok, false);
      assert.match(failed[0]!.detail ?? "", /"weekly" is not declared/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a confirmed RQ frequency with agreeing history is quiet",
  { skip: !DB },
  async () => {
    const fx = await seedRqOrg("monthly");
    try {
      // A small 2026 run only: the advisory measures the prior year, which is
      // empty, so nothing fires.
      const period = (await db.execute<{ id: string }>(sql`
        select id from accounting_periods where org_id = ${fx.orgId} limit 1`)).rows[0]!.id;
      await seedCommittedRun(fx, period, "2026-07-31", 2026, "400.0000");
      const passed = frequencyChecks(await payrollSetupState(fx.orgId));
      assert.equal(passed.length, 1);
      assert.equal(passed[0]!.ok, true);
      assert.equal(passed[0]!.detail, "Revenu Québec · monthly");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "a large prior year on the monthly default raises the band advisory",
  { skip: !DB },
  async () => {
    const fx = await seedRqOrg("monthly");
    try {
      await seedCommittedRun(fx, await period2025(fx.orgId), "2025-12-31", 2025, "400000.0000");
      const found = frequencyChecks(await payrollSetupState(fx.orgId));
      // The confirmation itself is quiet; the advisory names the mismatch.
      assert.ok(found.some((check) => check.ok === true));
      const advisory = found.find((check) => check.ok === false);
      assert.ok(advisory, "expected the twice-monthly advisory");
      assert.match(advisory!.detail ?? "", /averaged \$33333\.33\/month across 2025/);
      assert.match(advisory!.detail ?? "", /the twice monthly band/);
      assert.match(advisory!.detail ?? "", /bills date at the monthly frequency/);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "the advisory is silent when the bands agree, empty, or unreadable",
  { skip: !DB },
  async () => {
    const fx = await seedRqOrg("monthly");
    try {
      const blob = await payrollBlob(fx.orgId);
      const { RQ_REMITTANCE_SCHEDULE } = await import("./payroll/canada/quebec/remittance.ts");
      // No history at all: nothing to compare.
      assert.equal(
        await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
        null,
      );
      const period = (await db.execute<{ id: string }>(sql`
        select id from accounting_periods where org_id = ${fx.orgId} limit 1`)).rows[0]!.id;
      // History in the monthly band ($60,000/year = $5,000/month): agrees with
      // the configured frequency.
      await seedCommittedRun(fx, period, "2026-07-31", 2026, "60000.0000");
      assert.equal(
        await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
        null,
      );
      // Large history in the twice-monthly band: warns, naming the figures.
      const fx2 = await seedRqOrg("monthly");
      try {
        const period2 = (await db.execute<{ id: string }>(sql`
          select id from accounting_periods where org_id = ${fx2.orgId} limit 1`)).rows[0]!.id;
        await seedCommittedRun(fx2, period2, "2026-07-31", 2026, "400.0000");
        const period25 = await period2025(fx2.orgId);
        await seedCommittedRun(fx2, period25, "2025-12-31", 2025, "400000.0000");
        const warning = await scheduledFrequencyAdvisory(
          fx2.orgId, RQ_REMITTANCE_SCHEDULE, fx2.rqVendorId, await payrollBlob(fx2.orgId), 2025,
        );
        assert.match(warning ?? "", /twice monthly band/);
      } finally {
        await dropScratchOrgReporting(fx2.orgId);
      }
      // Committed payroll the summary refuses to read (an unknown historical
      // liability account) never breaks the advisory: it stays silent instead
      // of throwing.
      await seedCommittedRun(fx, period, "2026-08-31", 2026, "400.0000", {
        liabilityAccountId: null, liabilityAccountSource: "unknown",
      });
      assert.equal(
        await scheduledFrequencyAdvisory(fx.orgId, RQ_REMITTANCE_SCHEDULE, fx.rqVendorId, blob, 2026),
        null,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
