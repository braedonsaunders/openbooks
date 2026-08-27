import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { openingBalancesForYear } from "./payroll-opening-balances.ts";
import { payrollSubsidiaryInScope } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrgReporting, seedFlowActors } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const source = (file: string) =>
  readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

test("payroll engine scope policy fails closed for a restricted direct caller", () => {
  const allowed = new Set(["11111111-1111-4111-8111-111111111111"]);
  assert.equal(payrollSubsidiaryInScope(allowed, allowed.values().next().value), true);
  assert.equal(
    payrollSubsidiaryInScope(allowed, "22222222-2222-4222-8222-222222222222"),
    false,
  );
  assert.equal(payrollSubsidiaryInScope(allowed, null), false);
  assert.equal(payrollSubsidiaryInScope(new Set(), allowed.values().next().value), false);
  assert.equal(payrollSubsidiaryInScope(null, null), true);
});

test("every shared payroll engine entry point carries the caller scope to its boundary", () => {
  const files = [
    "payroll-cheques.ts",
    "payroll-bank-file-artifact.ts",
    "payroll-remittance.ts",
    "payroll-opening-balances.ts",
    "payroll-parallel-run-store.ts",
    "payroll-retro-store.ts",
    "payroll-run.ts",
  ];
  for (const file of files) {
    const text = source(file);
    assert.match(text, /allowedSubsidiaryIds/, `${file} must accept a scope policy`);
    assert.match(
      text,
      /payrollSubsidiaryScopeFilter|openingSubsidiaryScopeFilter|payrollSubsidiaryInScope/,
      `${file} must enforce the scope policy at the engine boundary`,
    );
  }
});

test(
  "direct engine callers cannot read opening balances from another subsidiary",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const childSubsidiaryId = randomUUID();
    const scheduleId = randomUUID();
    const rootEmployeeId = randomUUID();
    const childEmployeeId = randomUUID();
    try {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country,
                                  tax_ids, is_elimination, is_active, custom)
        values (${childSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Child Co', 'CAD', 'CA',
                '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into pay_schedules (id, org_id, name, frequency, periods_per_year,
                                   anchor_period_end, pay_date_offset_days, is_active,
                                   created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3,
                true, ${actorId}, ${actorId})`);
      for (const [employeeId, subsidiaryId, name] of [
        [rootEmployeeId, org.subsidiaryId, "Root Worker"],
        [childEmployeeId, childSubsidiaryId, "Child Worker"],
      ] as const) {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, is_active, custom, subsidiary_id)
          values (${employeeId}, ${org.orgId}, 'person', ${name}, true, '{}'::jsonb, ${subsidiaryId})`);
        await db.execute(sql`
          insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id,
                                                 province, pay_basis, country, federal_claim_code,
                                                 provincial_claim_code, vacation_percent,
                                                 vacation_method, is_active, created_by, updated_by)
          values (${org.orgId}, ${employeeId}, ${scheduleId}, 'ON', 'hourly', 'CA', 1, 1, '4',
                  'accrue', true, ${actorId}, ${actorId})`);
      }

      const scoped = await openingBalancesForYear(
        org.orgId,
        2026,
        new Set([org.subsidiaryId]),
      );
      assert.deepEqual(
        scoped.rows.map((row) => row.employeePartyId),
        [rootEmployeeId],
      );
      const unrestricted = await openingBalancesForYear(org.orgId, 2026, null);
      assert.deepEqual(
        new Set(unrestricted.rows.map((row) => row.employeePartyId)),
        new Set([rootEmployeeId, childEmployeeId]),
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
