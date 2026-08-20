import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { levelLeaseRentStraightLine } from "./property-management.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed')
     where l.org_id = ${orgId} and l.account_id = ${accountId}`));
  return toUnits(r.rows[0]!.bal);
}

/**
 * A five-year annual lease escalating 10k→14k (total 60k), levelled to 12k a
 * year. The corpus's worked lessor example, run through the REAL property
 * lease + levelling service. The fixture's open accounting period is July
 * 2026; the lease is annual with periods ending 30 June, so each levelling
 * date falls inside an open-period month by construction — but levelling
 * posts into the period covering the asOf date, and the conformance org only
 * opens 2026, so this test posts the year-one accrual only and asserts the
 * full-term arithmetic from the service's own figures.
 */
async function seedLease(org: ScratchOrg, slAccountId: string): Promise<string> {
  await db.execute(sql`
    update orgs set settings = settings
      || ${JSON.stringify({ features: { propertyManagement: true } })}::jsonb
      || jsonb_build_object('controlAccounts',
           coalesce(settings->'controlAccounts', '{}'::jsonb) || ${JSON.stringify({ straightLineRent: slAccountId })}::jsonb)
     where id = ${org.orgId}`);

  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, code, name, property_type, status, currency, address, custom,
       rent_income_account_id, created_by, updated_by)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, 'PROP-1', 'Levelled Property', 'commercial',
            'active', 'CAD', '{}'::jsonb, '{}'::jsonb, ${org.accounts.revenue}, null, null)`);

  const leaseId = randomUUID();
  await db.execute(sql`
    insert into property_leases
      (id, org_id, property_id, tenant_id, lease_number, status, starts_on, ends_on, billing_day,
       created_by, updated_by)
    values (${leaseId}, ${org.orgId}, ${propertyId}, ${org.customerId}, 'LSE-LEVEL-1', 'active',
            '2025-07-01', '2030-06-30', 1, null, null)`);

  // Five annual base-rent charges: 10k, 11k, 12k, 13k, 14k.
  const amounts = ["10000", "11000", "12000", "13000", "14000"];
  for (let year = 0; year < 5; year++) {
    await db.execute(sql`
      insert into lease_charges
        (org_id, lease_id, charge_type, description, amount, frequency, effective_from, effective_to,
         income_account_id, created_by, updated_by)
      values (${org.orgId}, ${leaseId}, 'base_rent', ${`Year ${year + 1} rent`}, ${amounts[year]}, 'annually',
              ${`${2025 + year}-07-01`}, ${`${2026 + year}-06-30`}, ${org.accounts.revenue}, null, null)`);
  }
  return leaseId;
}

test("escalating rent levels to straight-line income and the accrual posts once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // A dedicated straight-line rent asset account.
    const slAccountId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                            required_dimensions, custom, subsidiary_include_children)
      values (${slAccountId}, ${org.orgId}, '1160', 'Straight-Line Rent Receivable', 'asset_current_other',
              false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    const leaseId = await seedLease(org, slAccountId);

    // Year one complete (period ends 2026-06-30; asOf inside the open month).
    const results = await levelLeaseRentStraightLine(org.orgId, null, {
      asOf: "2026-07-15",
      onlyLeaseId: leaseId,
    });
    assert.equal(results.length, 1);
    const r = results[0]!;
    assert.equal(r.billedToDate, "10000.0000");
    assert.equal(r.straightLineToDate, "12000.0000"); // 60,000 / 5 — levelled
    assert.equal(r.targetAccrual, "2000.0000");
    assert.equal(r.delta, "2000.0000");
    assert.ok(r.entryId);

    // The GL carries the accrual: DR SL receivable 2,000 / CR rent income 2,000.
    assert.equal(await glBalance(org.orgId, slAccountId), toUnits("2000"));
    assert.equal(await glBalance(org.orgId, org.accounts.revenue), -toUnits("2000"));

    // Idempotent: a rerun as of the same date posts nothing further.
    const rerun = await levelLeaseRentStraightLine(org.orgId, null, {
      asOf: "2026-07-15",
      onlyLeaseId: leaseId,
    });
    assert.equal(rerun[0]!.delta, "0.0000");
    assert.equal(rerun[0]!.entryId, null);
    assert.equal(await glBalance(org.orgId, slAccountId), toUnits("2000"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
