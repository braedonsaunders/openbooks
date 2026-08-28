import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const migrationPath = fileURLToPath(
  new URL(
    "../../schema/migrations/generated/0069_lease_cancelled_lines_accumulation.sql",
    import.meta.url,
  ),
);
const migration = readFileSync(migrationPath, "utf8");

interface RepairResult {
  windows_closed: number;
  shadows_deleted: number;
  lines_cancelled: number;
}

interface ScheduleSnapshot {
  charge_id: string;
  period_starts_on: string;
  period_ends_on: string;
  amount: string;
  status: string;
  invoice_document_id: string | null;
}

interface ChargeSnapshot {
  id: string;
  lease_id: string;
  effective_from: string;
  effective_to: string | null;
  amount: string;
}

interface AuditSnapshot {
  row_id: string;
  action: string;
  changes: unknown;
  request_id: string | null;
}

async function createLeaseFixture(
  org: ScratchOrg,
  propertyId: string,
  leaseNumber: string,
): Promise<string> {
  const leaseId = randomUUID();
  await db.execute(sql`
    insert into property_leases
      (id, org_id, property_id, tenant_id, lease_number, status, starts_on,
       billing_day, payment_terms_days, late_fee_type, late_fee_value,
       grace_days, auto_invoice, auto_post)
    values (${leaseId}, ${org.orgId}, ${propertyId}, ${org.customerId}, ${leaseNumber},
            'active', '2026-01-01', 1, 0, 'none', 0, 0, false, false)`);
  return leaseId;
}

async function createCharge(
  org: ScratchOrg,
  leaseId: string,
  effectiveFrom: string,
  description: string,
): Promise<string> {
  const chargeId = randomUUID();
  await db.execute(sql`
    insert into lease_charges
      (id, org_id, lease_id, charge_type, description, amount, frequency, effective_from,
       income_account_id)
    values (${chargeId}, ${org.orgId}, ${leaseId}, 'base_rent', ${description},
            1000, 'monthly', ${effectiveFrom}, ${org.accounts.revenue})`);
  return chargeId;
}

async function createScheduleLine(
  org: ScratchOrg,
  leaseId: string,
  chargeId: string,
  startsOn: string,
  endsOn: string,
  status: "scheduled" | "invoiced",
): Promise<void> {
  await db.execute(sql`
    insert into lease_schedule_lines
      (id, org_id, lease_id, charge_id, period_starts_on, period_ends_on,
       due_on, amount, status)
    values (${randomUUID()}, ${org.orgId}, ${leaseId}, ${chargeId}, ${startsOn}, ${endsOn},
            ${startsOn}, 1000, ${status})`);
}

async function scheduleSnapshot(orgId: string): Promise<ScheduleSnapshot[]> {
  return (
    await pool.query<ScheduleSnapshot>(
      `
    select charge_id::text,
           period_starts_on::text,
           period_ends_on::text,
           amount::text,
           status,
           invoice_document_id::text
      from public.lease_schedule_lines
     where org_id = $1
     order by charge_id, period_starts_on`,
      [orgId],
    )
  ).rows;
}

async function tenantSnapshot(orgId: string): Promise<{
  charges: ChargeSnapshot[];
  schedules: ScheduleSnapshot[];
  evidence: AuditSnapshot[];
}> {
  const [charges, schedules, evidence] = await Promise.all([
    pool.query<ChargeSnapshot>(
      `
      select id::text,
             lease_id::text,
             effective_from::text,
             effective_to::text,
             amount::text
        from public.lease_charges
       where org_id = $1
       order by id`,
      [orgId],
    ),
    scheduleSnapshot(orgId),
    pool.query<AuditSnapshot>(
      `
      select row_id::text, action, changes, request_id
        from public.audit_log
       where org_id = $1
       order by id`,
      [orgId],
    ),
  ]);
  return { charges: charges.rows, schedules, evidence: evidence.rows };
}

async function restoreBaseRentConstraint(): Promise<void> {
  await pool.query(`
    do $restore_lease_base_rent_constraint$
    begin
      if not exists (
        select 1
          from pg_catalog.pg_constraint c
          join pg_catalog.pg_class t on t.oid = c.conrelid
          join pg_catalog.pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'public'
           and t.relname = 'lease_charges'
           and c.conname = 'lease_charges_base_rent_no_overlap'
      ) then
        alter table public.lease_charges
          add constraint lease_charges_base_rent_no_overlap
          exclude using gist (
            org_id with =,
            lease_id with =,
            (daterange(effective_from, effective_to, '[]')) with &&
          )
          where (charge_type = 'base_rent');
      end if;
    end
    $restore_lease_base_rent_constraint$;
  `);
}

test(
  "0069 accumulates lease cancellation conflicts and replays without rewriting tenant evidence",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const org = await createScratchOrg();
    let constraintDropped = false;
    try {
      const propertyId = randomUUID();
      await db.execute(sql`
        insert into managed_properties
          (id, org_id, subsidiary_id, location_id, code, name, property_type,
           currency, rent_income_account_id)
        values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId},
                ${`LEASE-${propertyId.slice(0, 8)}`}, 'Lease repair fixture', 'commercial',
                'CAD', ${org.accounts.revenue})`);

      // Existing, non-conflicting tenant data is present before 0069 installs.
      const canonicalLeaseId = await createLeaseFixture(
        org,
        propertyId,
        `CANON-${randomUUID().slice(0, 8)}`,
      );
      await createCharge(org, canonicalLeaseId, "2026-07-01", "Canonical rent");
      const beforeInstall = await tenantSnapshot(org.orgId);
      await pool.query(migration);
      assert.deepEqual(
        await tenantSnapshot(org.orgId),
        beforeInstall,
        "install does not touch existing tenant rows or evidence",
      );

      // 0060's exclusion constraint prevents constructing the legacy state in
      // a current schema.  Remove it only in this scratch database, then put it
      // back after the two pre-enforcement conflict pairs are repaired.
      await pool.query(
        "alter table public.lease_charges drop constraint if exists lease_charges_base_rent_no_overlap",
      );
      constraintDropped = true;

      for (const suffix of ["A", "B"]) {
        const leaseId = await createLeaseFixture(
          org,
          propertyId,
          `CONFLICT-${suffix}-${randomUUID().slice(0, 8)}`,
        );
        const olderChargeId = await createCharge(
          org,
          leaseId,
          "2026-01-01",
          `Older ${suffix}`,
        );
        await createCharge(org, leaseId, "2026-03-01", `Successor ${suffix}`);

        // One line per conflict is cancellable.  The invoiced line is posted
        // evidence and must survive both the repair and a migration replay.
        await createScheduleLine(
          org,
          leaseId,
          olderChargeId,
          "2026-03-01",
          "2026-03-31",
          "scheduled",
        );
        await createScheduleLine(
          org,
          leaseId,
          olderChargeId,
          "2026-04-01",
          "2026-04-30",
          "invoiced",
        );
        await db.execute(sql`
          insert into audit_log (id, org_id, table_name, row_id, action, changes, request_id)
          values (${randomUUID()}, ${org.orgId}, 'lease_schedule_lines', ${olderChargeId},
                  'fixture_evidence', '{"source":"lease-repair-test"}'::jsonb,
                  ${`lease-repair-fixture-${suffix}`})`);
      }

      const repaired = (
        await pool.query<RepairResult>(
          "select * from public.lease_charges_base_rent_repair()",
        )
      ).rows[0]!;
      assert.deepEqual(
        repaired,
        { windows_closed: 2, shadows_deleted: 0, lines_cancelled: 2 },
        "both independent conflicts contribute to one cancellation total",
      );

      const afterRepair = await tenantSnapshot(org.orgId);
      assert.equal(
        afterRepair.schedules.filter((line) => line.status === "cancelled")
          .length,
        2,
        "one scheduled line per conflict is cancelled",
      );
      assert.equal(
        afterRepair.schedules.filter((line) => line.status === "invoiced")
          .length,
        2,
        "invoiced schedule evidence is preserved",
      );

      const secondPass = (
        await pool.query<RepairResult>(
          "select * from public.lease_charges_base_rent_repair()",
        )
      ).rows[0]!;
      assert.deepEqual(
        secondPass,
        { windows_closed: 0, shadows_deleted: 0, lines_cancelled: 0 },
        "reapplying the repair after success is idempotent",
      );
      assert.deepEqual(
        await tenantSnapshot(org.orgId),
        afterRepair,
        "idempotent pass preserves every tenant row and evidence",
      );

      // Replaying the forward migration only replaces the installed function;
      // it does not rerun the historical repair or alter tenant evidence.
      await pool.query(migration);
      assert.deepEqual(
        await tenantSnapshot(org.orgId),
        afterRepair,
        "migration replay preserves repaired evidence",
      );
      await pool.query(migration);
      assert.deepEqual(
        await tenantSnapshot(org.orgId),
        afterRepair,
        "second migration replay is also a no-op",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
      if (constraintDropped) await restoreBaseRentConstraint();
    }
  },
);
