import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  activatePropertyLease,
  createPropertyLease,
  securityDepositReconciliation,
  recordSecurityDeposit,
} from "./management.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const leaseTerms = {
  billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none" as const,
  lateFeeType: "none" as const, lateFeeValue: "0", graceDays: 0, autoInvoice: true, autoPost: false,
};

/** Two active properties sharing one location and one deposit-liability account. */
async function seedSharedControl() {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Deposit reconciliation operator", "admin");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`);
  const propertyIds = [randomUUID(), randomUUID()];
  let index = 0;
  for (const propertyId of propertyIds) {
    index += 1;
    await db.execute(sql`
      insert into managed_properties
        (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
         rent_income_account_id, cam_income_account_id, deposit_liability_account_id, default_bank_account_id)
      values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, ${`PRP-SHARE-${index}`},
              ${`Shared Control Tower ${index}`}, 'commercial', 'active', 'CAD',
              ${org.accounts.revenue}, ${org.accounts.revenue}, ${org.accounts.deferred}, ${org.accounts.bank})`);
  }
  const leaseIds: string[] = [];
  index = 0;
  for (const propertyId of propertyIds) {
    index += 1;
    const lease = await createPropertyLease({
      orgId: org.orgId, actorId, propertyId, tenantId: org.customerId,
      leaseNumber: `L-SHARE-${index}`, startsOn: "2026-01-01", endsOn: null,
      baseRent: "1000", ...leaseTerms,
    });
    await activatePropertyLease(org.orgId, actorId, lease.id);
    leaseIds.push(lease.id);
  }
  return { org, actorId, propertyIds, leaseIds };
}

/** A manual GL posting straight to the shared deposit-liability account/location. */
async function postManualLiability(orgId: string, bookId: string, subsidiaryId: string, locationId: string, accountId: string, offsetAccountId: string, amount: string, postingDate: string, periodId: string): Promise<void> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
    values (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId},
            ${`MANUAL-${entryId.slice(0, 8)}`}, ${postingDate}, ${periodId},
            'Manual deposit-liability adjustment', 'draft', 'manual', null, null)`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, location_id, amount, currency, txn_amount, fx_rate)
    values (${orgId}, ${entryId}, 1, ${accountId}, ${subsidiaryId},
            ${locationId}, ${amount}, 'CAD', ${amount}, 1),
           (${orgId}, ${entryId}, 2, ${offsetAccountId}, ${subsidiaryId},
            null, ${`-${amount}`}, 'CAD', ${`-${amount}`}, 1)`);
  await db.execute(sql`
    update journal_entries set status = 'posted', posted_at = now(), updated_at = now(), updated_by = null
     where org_id = ${orgId} and id = ${entryId}`);
}

test("PM1: properties sharing one location control reconcile together with zero false discrepancy", { skip: !DB }, async () => {
  const fx = await seedSharedControl();
  try {
    const orgId = fx.org.orgId;
    for (const leaseId of fx.leaseIds) {
      await recordSecurityDeposit({ orgId, actorId: fx.actorId, leaseId, kind: "received", occurredOn: fx.org.date, amount: "100" });
    }
    const recon = await securityDepositReconciliation(orgId, fx.org.date);
    assert.equal(recon.rows.length, 2);
    // Each property holds $100; the shared GL control honestly reads $200.
    for (const row of recon.rows) {
      assert.equal(row.subledgerBalance, "100.0000");
      assert.equal(row.linkedGlBalance, "100.0000");
      assert.equal(row.locationControlBalance, "200.0000");
    }
    // No per-property variance may be claimed from the shared control, so
    // balanced deposits reconcile instead of reporting a false $100 gap.
    assert.equal(recon.totals.discrepancies, 0);
    for (const row of recon.rows) {
      assert.equal(row.status, "reconciled");
      assert.equal(row.controlShared, true);
      assert.equal(row.controlVariance, null);
      assert.equal(row.controlGroupVariance, "0.0000");
      assert.deepEqual([...row.controlGroupPropertyIds].sort(), [...fx.propertyIds].sort());
    }
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("PM1: a genuine imbalance on a shared control still reports a group discrepancy", { skip: !DB }, async () => {
  const fx = await seedSharedControl();
  try {
    const orgId = fx.org.orgId;
    for (const leaseId of fx.leaseIds) {
      await recordSecurityDeposit({ orgId, actorId: fx.actorId, leaseId, kind: "received", occurredOn: fx.org.date, amount: "100" });
    }
    // A $10 manual debit to the shared liability account: the GL control now
    // reads $190 against $200 of subledger, with linked provenance untouched.
    await postManualLiability(orgId, fx.org.bookId, fx.org.subsidiaryId, fx.org.locationId, fx.org.accounts.deferred, fx.org.accounts.bank, "10", fx.org.date, fx.org.periodId);
    const recon = await securityDepositReconciliation(orgId, fx.org.date);
    assert.equal(recon.totals.discrepancies, 2);
    assert.equal(recon.rows.length, 2);
    for (const row of recon.rows) {
      assert.equal(row.status, "discrepancy");
      assert.equal(row.linkedVariance, "0.0000");
      assert.equal(row.controlVariance, null);
      assert.equal(row.controlShared, true);
      assert.equal(row.controlGroupVariance, "-10.0000");
    }
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("PM1: a property with a unique location control keeps per-property variance", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Deposit reconciliation operator", "admin");
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
      values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '0', 'CAD', false, ${actorId}, ${actorId})`);
    const propertyId = randomUUID();
    await db.execute(sql`
      insert into managed_properties
        (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
         rent_income_account_id, cam_income_account_id, deposit_liability_account_id, default_bank_account_id)
      values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-SOLO',
              'Solo Control Tower', 'commercial', 'active', 'CAD',
              ${org.accounts.revenue}, ${org.accounts.revenue}, ${org.accounts.deferred}, ${org.accounts.bank})`);
    const lease = await createPropertyLease({
      orgId: org.orgId, actorId, propertyId, tenantId: org.customerId,
      leaseNumber: "L-SOLO", startsOn: "2026-01-01", endsOn: null, baseRent: "1000", ...leaseTerms,
    });
    await activatePropertyLease(org.orgId, actorId, lease.id);
    await recordSecurityDeposit({ orgId: org.orgId, actorId, leaseId: lease.id, kind: "received", occurredOn: org.date, amount: "100" });
    const recon = await securityDepositReconciliation(org.orgId, org.date);
    assert.equal(recon.rows.length, 1);
    const row = recon.rows[0]!;
    assert.equal(row.status, "reconciled");
    assert.equal(row.controlShared, false);
    assert.equal(row.controlVariance, "0.0000");
    assert.equal(row.controlGroupVariance, "0.0000");
    assert.deepEqual(row.controlGroupPropertyIds, [propertyId]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
