import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  activatePropertyLease,
  addLeaseCharge,
  billDueLeaseCharges,
  createPropertyLease,
  propertyManagementWorkspace,
} from "./management.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const leaseTerms = {
  billingDay: 1, paymentTermsDays: 0, securityDepositRequired: "0", camMethod: "none" as const,
  lateFeeType: "none" as const, lateFeeValue: "0", graceDays: 0, autoPost: true,
};

async function seedTruncationOrg() {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Rent-roll operator", "admin");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
    -- No credit limit: lease billing is contractual execution, not a sales commitment, so the invoice-posting credit gate leaves it alone.
    values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, null, 'CAD', false, ${actorId}, ${actorId})`);
  const propertyId = randomUUID();
  await db.execute(sql`
    insert into managed_properties
      (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency,
       rent_income_account_id, cam_income_account_id, deposit_liability_account_id, default_bank_account_id)
    values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-ROLL',
            'Rent Roll Tower', 'commercial', 'active', 'CAD',
            ${org.accounts.revenue}, ${org.accounts.revenue}, ${org.accounts.deferred}, ${org.accounts.bank})`);
  return { org, actorId, propertyId };
}

test("PM2: past-due and lease detail survive the schedule preview cap", { skip: !DB }, async () => {
  const fx = await seedTruncationOrg();
  try {
    const orgId = fx.org.orgId;
    // Lease A is old: three $1,000 periods billed into one posted $3,000
    // invoice due 2026-07-01, left unpaid. Billing lands inside the scratch
    // org's open July-2026 period; the workspace reads as of 2026-07-20 so
    // the test never depends on the ambient business date.
    const leaseA = await createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-OLD", startsOn: "2026-04-01", endsOn: "2026-06-30",
      baseRent: "1000", autoInvoice: true, ...leaseTerms,
    });
    await activatePropertyLease(orgId, fx.actorId, leaseA.id);
    const billed = await billDueLeaseCharges(orgId, fx.actorId, "2026-07-01", leaseA.id);
    assert.equal(billed.invoices.length, 1, "the old periods bill into one invoice");
    const invoiceId = billed.invoices[0]!;

    // Lease B carries the bulk that pushes the portfolio past the preview
    // cap: every filler line is newer, so the preview keeps filler only and
    // the old invoiced lines fall out first.
    const leaseB = await createPropertyLease({
      orgId, actorId: fx.actorId, propertyId: fx.propertyId, tenantId: fx.org.customerId,
      leaseNumber: "L-NEW", startsOn: "2026-07-01", endsOn: null,
      baseRent: "100", autoInvoice: false, ...leaseTerms,
    });
    await activatePropertyLease(orgId, fx.actorId, leaseB.id);
    // Filler rides a second charge with no generated lines, so its daily
    // periods cannot collide with the monthly base-rent schedule under the
    // (org, charge, period-starts-on) uniqueness rule.
    const fillerCharge = await addLeaseCharge({
      orgId, actorId: fx.actorId, leaseId: leaseB.id, chargeType: "parking",
      description: "Bulk filler", amount: "100", frequency: "monthly", effectiveFrom: "2026-07-02",
    });
    await db.execute(sql`insert into lease_schedule_lines (org_id, lease_id, charge_id, period_starts_on, period_ends_on, due_on, amount, status)
      select ${orgId}, ${leaseB.id}, ${fillerCharge.id}, d::date, (d + interval '1 month' - interval '1 day')::date, d::date, '100', 'scheduled'
      from generate_series('2026-07-02'::date, '2026-07-02'::date + 2009, '1 day') as d`);

    const workspace = await propertyManagementWorkspace(orgId, "2026-07-20");

    // The preview is capped while the completeness evidence is not.
    assert.ok(workspace.scheduleTotal > 2000, `expected more than 2000 lines, got ${workspace.scheduleTotal}`);
    assert.equal(workspace.schedules.length, 2000);
    assert.equal(workspace.schedulesTruncated, true);
    const previewDocuments = new Set(workspace.schedules.map((line) => line.invoiceDocumentId).filter(Boolean));
    assert.ok(!previewDocuments.has(invoiceId), "the oldest invoiced line fell out of the capped preview");

    // Past-due still counts the oldest posted unpaid invoice ...
    assert.equal(workspace.overdueAsOf, "2026-07-20");
    assert.equal(workspace.overdueTotal, "3000.0000");
    const leaseEntry = workspace.overdueByLease.find((row) => row.leaseId === leaseA.id);
    assert.deepEqual(leaseEntry, { leaseId: leaseA.id, balance: "3000.0000" });
    const invoiceEntry = workspace.overdueInvoices.find((row) => row.documentId === invoiceId);
    assert.equal(invoiceEntry?.leaseId, leaseA.id);
    assert.equal(invoiceEntry?.openBalance, "3000.0000");

    // ... and the lease detail still knows its full line count even though
    // the preview holds none of its lines.
    assert.equal(workspace.schedules.filter((line) => line.leaseId === leaseA.id).length, 0);
    assert.equal(
      workspace.scheduleCountsByLease.find((row) => row.leaseId === leaseA.id)?.total,
      3,
      "lease A keeps its complete line count for the 'showing N of M' indicator",
    );
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
