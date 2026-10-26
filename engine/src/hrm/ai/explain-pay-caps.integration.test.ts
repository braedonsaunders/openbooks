import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../../testing/fixtures.ts";
import { explainPay } from "./explain-pay.ts";

/**
 * Payslip Explain capped-share evidence: per deduction line the trace
 * carries the year-to-date (carry-ins plus committed prior stubs plus
 * this stub), the pack's annual maximum, the remaining room before this
 * stub, and a capped flag where the stub reaches the maximum — all read
 * from stored calculation evidence, never recomputed. Employer shares
 * carry the same evidence; lines with no declared maximum stay empty.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedEmployment(orgId: string): Promise<{ employmentId: string; partyId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', 'Capped Worker', true, '{}'::jsonb)`);
  const subsidiary = (
    await db.execute<{ id: string }>(
      sql`
    select id::text as id from subsidiaries where org_id = ${orgId} limit 1`,
      "objects",
    )
  )[0]?.id;
  assert.ok(subsidiary, "scratch org needs a subsidiary");
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiary}, 1)`);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2026-01-05', now())`);
  return { employmentId, partyId };
}

async function seedRun(
  orgId: string,
  adminId: string,
  subsidiary: string,
  opts: {
    stubId: string;
    partyId: string;
    employmentId: string;
    payDate: string;
    factors: Record<string, string>;
    country?: string | null;
  },
): Promise<void> {
  const runId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active)
    values (${randomUUID()}, ${orgId}, ${`Sched ${runId.slice(0, 8)}`}, 'biweekly', 26,
            '2026-09-30', 3, true)`);
  const scheduleId = (
    await db.execute<{ id: string }>(
      sql`
    select id::text as id from pay_schedules where org_id = ${orgId} order by id desc limit 1`,
      "objects",
    )
  )[0]!.id;
  await db.execute(sql`
    insert into documents (org_id, id, kind, document_number, subsidiary_id, document_date,
                           currency, status, created_by, updated_by)
    values (${orgId}, ${runId}, 'pay_run', ${`PAY-${runId.slice(0, 8)}`},
            ${subsidiary}, ${opts.payDate}, 'CAD', 'draft', ${adminId}, ${adminId})`);
  await db.execute(sql`
    insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                          pay_date, tax_year, run_status)
    values (${runId}, ${orgId}, ${scheduleId}, ${opts.payDate}, ${opts.payDate},
            ${opts.payDate}, 2026, 'committed')`);
  await db.execute(sql`
    insert into pay_stubs (id, org_id, pay_run_document_id, employee_party_id, employment_id,
      country, country_source, province, periods_per_year, pay_date, tax_year, currency_code, gross, net_pay, employer_cost, factors)
    values (${opts.stubId}, ${orgId}, ${runId}, ${opts.partyId}, ${opts.employmentId},
      ${opts.country === undefined ? "CA" : opts.country}, 'calculation', 'ON', 26, ${opts.payDate}, 2026, 'CAD', 6000, 4200, 900,
      ${JSON.stringify(opts.factors)}::jsonb)`);
}

test(
  "a capped EI line shows YTD, the annual maximum, remaining room, and the capped flag",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const adminId = await createScratchUser(org.orgId, "Explain Admin", "explain_admin");
    await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${adminId}, 'payroll.manage', 'grant')`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,payroll}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,aiGovernanceLedger}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    try {
      const { employmentId, partyId } = await seedEmployment(org.orgId);
      const subsidiary = (
        await db.execute<{ id: string }>(
          sql`
      select id::text as id from subsidiaries where org_id = ${org.orgId} limit 1`,
          "objects",
        )
      )[0]!.id;
      // Components the trace matches by system key: EI on both sides of the
      // stub plus an uncapped tax line that must stay empty.
      const eiDeduction = randomUUID();
      const eiEmployer = randomUUID();
      const incomeTax = randomUUID();
      await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, country, system_key, basis, is_active, created_by, updated_by)
      values (${eiDeduction}, ${org.orgId}, 'EI', 'EI', 'deduction', 'CA', 'ei', 'fixed_amount', true, ${adminId}, ${adminId}),
             (${eiEmployer}, ${org.orgId}, 'EI_ER', 'EI employer', 'employer_contribution', 'CA', 'ei', 'fixed_amount', true, ${adminId}, ${adminId}),
             (${incomeTax}, ${org.orgId}, 'TAX', 'Income tax', 'deduction', 'CA', 'income_tax', 'fixed_amount', true, ${adminId}, ${adminId})`);
      // Prior-provider carry-ins: EI premiums and employer EI already paid.
      await db.execute(sql`
      insert into payroll_opening_balances (org_id, employee_party_id, tax_year, ei_ytd, employer_ei_ytd, created_by, updated_by)
      values (${org.orgId}, ${partyId}, 2026, 200, 100, ${adminId}, ${adminId})`);
      // A prior committed stub inside the same tax year.
      const stubPrev = randomUUID();
      await seedRun(org.orgId, adminId, subsidiary, {
        stubId: stubPrev,
        partyId,
        employmentId,
        payDate: "2026-10-31",
        factors: { EI: "800.00", EI_ER: "1120.00" },
      });
      // The explained stub: 200 carry-in + 800 prior + 123.07 here reaches
      // the 2026 EI annual maximum of 1123.07 exactly.
      const stubCur = randomUUID();
      await seedRun(org.orgId, adminId, subsidiary, {
        stubId: stubCur,
        partyId,
        employmentId,
        payDate: "2026-11-30",
        factors: { EI: "123.07", EI_ER: "172.30" },
      });
      await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
      values (${org.orgId}, ${stubCur}, ${eiDeduction}, 'deduction', 'EI', 123.07, 140),
             (${org.orgId}, ${stubCur}, ${eiEmployer}, 'employer_contribution', 'EI (employer)', 172.30, 220),
             (${org.orgId}, ${stubCur}, ${incomeTax}, 'deduction', 'Income tax', 500, 110)`);

      const trace = await explainPay(db, {
        orgId: org.orgId,
        actorId: adminId,
        employmentId,
        stubId: stubCur,
      });
      const ei = trace.deductions.find((line) => line.description === "EI");
      assert.ok(ei, "the EI deduction line must be in the trace");
      assert.equal(ei.ytd, "1123.0700");
      assert.equal(ei.annualMaximum, "1123.07");
      assert.equal(ei.remainingBeforeMax, "123.0700");
      assert.equal(ei.capped, true);

      const eiEr = trace.employerContributions.find((line) => line.description === "EI (employer)");
      assert.ok(eiEr, "the employer EI line must be in the trace");
      assert.equal(eiEr.ytd, "1392.3000");
      assert.equal(eiEr.annualMaximum, null);
      assert.equal(eiEr.remainingBeforeMax, null);
      assert.equal(eiEr.capped, false);

      const tax = trace.deductions.find((line) => line.description === "Income tax");
      assert.ok(tax, "the tax line must be in the trace");
      assert.equal(tax.ytd, null);
      assert.equal(tax.annualMaximum, null);
      assert.equal(tax.remainingBeforeMax, null);
      assert.equal(tax.capped, false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an uncapped EI line shows history with room left and no capped flag",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const adminId = await createScratchUser(org.orgId, "Explain Admin", "explain_admin2");
    await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${org.orgId}, ${adminId}, 'payroll.manage', 'grant')`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,payroll}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,aiGovernanceLedger}', 'true'::jsonb, true)
    where id = ${org.orgId}`);
    try {
      const { employmentId, partyId } = await seedEmployment(org.orgId);
      const subsidiary = (
        await db.execute<{ id: string }>(
          sql`
      select id::text as id from subsidiaries where org_id = ${org.orgId} limit 1`,
          "objects",
        )
      )[0]!.id;
      const eiDeduction = randomUUID();
      await db.execute(sql`
      insert into pay_components (id, org_id, code, name, kind, country, system_key, basis, is_active, created_by, updated_by)
      values (${eiDeduction}, ${org.orgId}, 'EI', 'EI', 'deduction', 'CA', 'ei', 'fixed_amount', true, ${adminId}, ${adminId})`);
      const stubCur = randomUUID();
      await seedRun(org.orgId, adminId, subsidiary, {
        stubId: stubCur,
        partyId,
        employmentId,
        payDate: "2026-03-31",
        factors: { EI: "50.00" },
      });
      await db.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, amount, sequence)
      values (${org.orgId}, ${stubCur}, ${eiDeduction}, 'deduction', 'EI', 50, 140)`);

      const trace = await explainPay(db, {
        orgId: org.orgId,
        actorId: adminId,
        employmentId,
        stubId: stubCur,
      });
      const ei = trace.deductions.find((line) => line.description === "EI");
      assert.ok(ei, "the EI deduction line must be in the trace");
      assert.equal(ei.ytd, "50.0000");
      assert.equal(ei.annualMaximum, "1123.07");
      assert.equal(ei.remainingBeforeMax, "1123.0700");
      assert.equal(ei.capped, false);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
