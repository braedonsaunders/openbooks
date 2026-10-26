import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { AssetRefusal } from "./asset-refusal.ts";
import {
  cancelMaintenanceRecord,
  createMaintenanceSchedule,
  maintenanceQueue,
  recordMaintenance,
  recordUsageReading,
  runMaintenanceAlertScan,
} from "./asset-maintenance.ts";
import {
  createInsurancePolicy,
  insuredValueComparison,
  renewInsurancePolicy,
  runInsuranceRenewalScan,
  setInsuranceCoverage,
} from "./asset-insurance.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AssetRefusal, `expected AssetRefusal ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function setup(org: Org) {
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["assets.maintain"]);
  return withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"assetMaintenance": true, "assetInsurance": true}'::jsonb)
       where id = ${org.orgId}`);
    const equipment = await seedPostingAccount(org.orgId, "1600", "Equipment", "asset_fixed");
    const accumulated = await seedPostingAccount(
      org.orgId,
      "1690",
      "Accumulated depreciation",
      "asset_fixed",
    );
    const depreciation = await seedPostingAccount(org.orgId, "6100", "Depreciation", "expense");
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         default_method, default_life_months, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Equipment', ${equipment}, ${accumulated}, ${depreciation},
              'straight_line', 60, 'full_month', '{}'::jsonb, true)`);
    const assetId = randomUUID();
    await db.execute(sql`
      insert into fixed_assets
        (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquired_on, in_service_on,
         acquisition_cost, salvage_value, depreciation_method, useful_life_months, depreciation_convention, custom)
      values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, 'GEN-1', 'Generator', 'in_service',
              '2026-07-01', '2026-07-01', 48000, 0, 'straight_line', 60, 'full_month', '{}'::jsonb)`);
    return { actors, assetId };
  });
}

test(
  "maintenance schedules recompute their next due point from work records and meter readings never run backwards",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, assetId } = await setup(org);
      const schedule = await createMaintenanceSchedule(
        org.orgId,
        {
          assetId,
          name: "Oil service",
          intervalMonths: 6,
          intervalUsage: "250",
          usageUnit: "hours",
          startsOn: "2026-01-15",
          leadDays: 14,
        },
        { actorId: actors.adminId },
      );
      assert.deepEqual([schedule.nextDueOn, schedule.nextDueUsage], ["2026-07-15", "250.0000"]);
      await recordUsageReading(
        org.orgId,
        { assetId, readOn: "2026-07-10", reading: "300", unit: "hours" },
        { actorId: actors.adminId },
      );
      await refusedWith("reading_decreases", () =>
        recordUsageReading(
          org.orgId,
          { assetId, readOn: "2026-07-12", reading: "290", unit: "hours" },
          { actorId: actors.adminId },
        ),
      );
      const queue = await withOrgContext(org.orgId, () =>
        maintenanceQueue(db, org.orgId, { today: "2026-07-12" }),
      );
      assert.equal(queue[0]?.standing, "overdue", "300 hours is past the 250-hour due point");

      await refusedWith("betterment_source_required", () =>
        recordMaintenance(
          org.orgId,
          {
            assetId,
            performedOn: "2026-07-14",
            description: "New engine",
            treatment: "betterment",
          },
          { actorId: actors.adminId },
        ),
      );
      const record = await recordMaintenance(
        org.orgId,
        {
          assetId,
          scheduleId: schedule.id,
          performedOn: "2026-07-14",
          usageReading: "305",
          description: "Oil and filters",
          cost: "420.00",
          treatment: "expense",
        },
        { actorId: actors.adminId },
      );
      const after = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ next_due_on: string; next_due_usage: string }>(
            sql`
        select next_due_on::text as next_due_on, next_due_usage::text as next_due_usage
          from asset_maintenance_schedules where org_id = ${org.orgId} and id = ${schedule.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.deepEqual(after, { next_due_on: "2027-01-14", next_due_usage: "555.0000" });

      await cancelMaintenanceRecord(org.orgId, {
        recordId: record.id,
        reason: "Entered against the wrong unit",
        actorId: actors.adminId,
      });
      const reverted = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ next_due_on: string }>(
            sql`
        select next_due_on::text as next_due_on from asset_maintenance_schedules where org_id = ${org.orgId} and id = ${schedule.id}`,
            "objects",
          ),
        )
      )[0]!;
      assert.equal(
        reverted.next_due_on,
        "2026-07-15",
        "cancelling the only record restores the schedule's first due point",
      );
      await refusedWith("permission_required", () =>
        createMaintenanceSchedule(
          org.orgId,
          {
            assetId,
            name: "Inspection",
            intervalMonths: 12,
            startsOn: "2026-01-01",
          },
          { actorId: actors.outsiderId },
        ),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "maintenance and renewal alerts notify once per due point however often the scan runs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, assetId } = await setup(org);
      await createMaintenanceSchedule(
        org.orgId,
        {
          assetId,
          name: "Annual inspection",
          intervalMonths: 12,
          startsOn: "2020-01-01",
        },
        { actorId: actors.adminId },
      );
      const insurerId = org.vendorId;
      await createInsurancePolicy(
        org.orgId,
        {
          subsidiaryId: org.subsidiaryId,
          insurerPartyId: insurerId,
          policyNumber: "NW-1",
          coverageStartsOn: "2020-01-01",
          coverageEndsOn: "2099-12-31",
        },
        { actorId: actors.adminId },
      );
      const expiring = await createInsurancePolicy(
        org.orgId,
        {
          subsidiaryId: org.subsidiaryId,
          insurerPartyId: insurerId,
          policyNumber: "NW-2",
          coverageStartsOn: "2020-01-01",
          // Ends about a month out, inside its 365-day renewal lead.
          coverageEndsOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
          renewalLeadDays: 365,
        },
        { actorId: actors.adminId },
      );
      const count = async (kind: string) =>
        (
          await withOrgContext(org.orgId, () =>
            db.execute<{ n: number }>(
              sql`
        select count(*)::int as n from notifications where org_id = ${org.orgId} and kind = ${kind}`,
              "objects",
            ),
          )
        )[0]!.n;
      await runMaintenanceAlertScan(new Date());
      const firstMaintenance = await count("asset_maintenance_due");
      assert.ok(firstMaintenance >= 1, "the overdue inspection notifies the maintainers");
      await runMaintenanceAlertScan(new Date());
      assert.equal(
        await count("asset_maintenance_due"),
        firstMaintenance,
        "a second scan notifies nobody again",
      );
      await runInsuranceRenewalScan(new Date());
      const renewals = await count("asset_insurance_renewal");
      await runInsuranceRenewalScan(new Date());
      assert.ok(renewals >= 1, "the expiring policy notifies the maintainers");
      assert.equal(await count("asset_insurance_renewal"), renewals);
      assert.ok(expiring.id);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "insurance coverage stays inside the policy's legal entity and compares insured value with net book value",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, assetId } = await setup(org);
      const insurerId = org.vendorId;
      const policy = await createInsurancePolicy(
        org.orgId,
        {
          subsidiaryId: org.subsidiaryId,
          insurerPartyId: insurerId,
          policyNumber: "HB-100",
          coverageStartsOn: "2026-01-01",
          coverageEndsOn: "2026-12-31",
          premium: "1800.00",
          deductible: "2500.00",
        },
        { actorId: actors.adminId },
      );
      await refusedWith("policy_duplicate", () =>
        createInsurancePolicy(
          org.orgId,
          {
            subsidiaryId: org.subsidiaryId,
            insurerPartyId: insurerId,
            policyNumber: "HB-100",
            coverageStartsOn: "2026-01-01",
            coverageEndsOn: "2026-12-31",
          },
          { actorId: actors.adminId },
        ),
      );
      await refusedWith("coverage_period_invalid", () =>
        createInsurancePolicy(
          org.orgId,
          {
            subsidiaryId: org.subsidiaryId,
            insurerPartyId: insurerId,
            policyNumber: "HB-101",
            coverageStartsOn: "2026-12-31",
            coverageEndsOn: "2026-01-01",
          },
          { actorId: actors.adminId },
        ),
      );
      await setInsuranceCoverage(org.orgId, {
        policyId: policy.id,
        assetId,
        insuredValue: "40000.00",
        replacementValue: "52000.00",
        actorId: actors.adminId,
      });
      const rows = await insuredValueComparison(org.orgId, { asOf: "2026-07-15" });
      const policyCurrency = (
        await db.execute<{ currency: string }>(
          sql`
        select currency from asset_insurance_policies where org_id = ${org.orgId} and id = ${policy.id}
      `,
          "objects",
        )
      )[0]?.currency;
      assert.ok(policyCurrency);
      assert.equal(
        rows[0]?.currency,
        policyCurrency,
        "comparison rows carry the policy subsidiary currency",
      );
      assert.deepEqual(
        rows.map((row) => [
          row.policyNumber,
          row.insuredValue,
          row.netBookValue,
          row.gap,
          row.standing,
        ]),
        [["HB-100", "40000.0000", "48000.0000", "-8000.0000", "underinsured"]],
      );

      const otherSubsidiary = randomUUID();
      const foreignAsset = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
          values (${otherSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into fixed_assets (id, org_id, subsidiary_id, category_id, asset_number, name, status, acquisition_cost, salvage_value, custom)
          select ${foreignAsset}, org_id, ${otherSubsidiary}, category_id, 'GEN-2', 'Second generator', 'draft', 1000, 0, '{}'::jsonb
            from fixed_assets where org_id = ${org.orgId} and id = ${assetId}`);
      });
      await refusedWith("coverage_cross_subsidiary", () =>
        setInsuranceCoverage(org.orgId, {
          policyId: policy.id,
          assetId: foreignAsset,
          insuredValue: "1",
          actorId: actors.adminId,
        }),
      );

      const renewal = await renewInsurancePolicy(org.orgId, {
        policyId: policy.id,
        coverageStartsOn: "2027-01-01",
        coverageEndsOn: "2027-12-31",
        actorId: actors.adminId,
      });
      const carried = await withOrgContext(org.orgId, () =>
        db.execute<{ asset_id: string; insured_value: string }>(
          sql`
        select asset_id, insured_value::text as insured_value from asset_insurance_coverages where org_id = ${org.orgId} and policy_id = ${renewal.id}`,
          "objects",
        ),
      );
      assert.deepEqual(
        carried,
        [{ asset_id: assetId, insured_value: "40000.0000" }],
        "a renewal carries the covered assets forward",
      );
      await refusedWith("policy_already_renewed", () =>
        renewInsurancePolicy(org.orgId, {
          policyId: policy.id,
          coverageStartsOn: "2027-01-01",
          coverageEndsOn: "2027-12-31",
          actorId: actors.adminId,
        }),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
