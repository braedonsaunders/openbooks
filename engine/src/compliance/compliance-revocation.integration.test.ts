import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { vendorComplianceStatus } from "./compliance.ts";

/**
 * DB-UNVERIFIED (no GPU test DB in this lane; the coordinator runs the DB
 * partition on the Mac): revoking a compliance exception must narrow its
 * window, not erase it. vendorComplianceStatus as of a date before the
 * revocation still reports waived; on/after the revocation it reports the
 * underlying failure again.
 */
const { db, withBypassContext, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a revoked exception covers dates before revocation but not after",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Compliance Manager", "compliance_manager"),
      );
      const partyId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by, updated_by)
          values (${partyId}, ${org.orgId}, 'company', 'Revocation Vendor', ${org.subsidiaryId}, ${actorId}, ${actorId})`);
        const cls = (
          await db.execute<{ id: string }>(sql`
            insert into compliance_classes (org_id, code, name, created_by, updated_by)
            values (${org.orgId}, 'TRADE', 'Trade', ${actorId}, ${actorId})
            returning id`)
        ).rows[0]!.id;
        await db.execute(sql`
          insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
          values (${org.orgId}, ${partyId}, ${cls}, ${actorId}, ${actorId})`);
        const req = (
          await db.execute<{ id: string }>(sql`
            insert into compliance_requirements
              (org_id, code, name, category, enforcement, requires_verification, created_by, updated_by)
            values (${org.orgId}, 'GL', 'General Liability', 'insurance', 'block_payment', false, ${actorId}, ${actorId})
            returning id`)
        ).rows[0]!.id;
        await db.execute(sql`
          insert into compliance_waivers
            (org_id, party_id, requirement_id, reason, effective_from, expires_on,
             approved_by, revoked_at, revoke_reason, created_by, updated_by)
          values (${org.orgId}, ${partyId}, ${req}, 'test exception window',
                  '2026-06-01', '2026-08-01',
                  ${actorId}, '2026-07-10T14:00:00Z', 'no longer needed', ${actorId}, ${actorId})`);
      });
      const statusAt = (asOf: string) =>
        withOrgContext(org.orgId, () =>
          vendorComplianceStatus({ orgId: org.orgId, partyId, asOf }),
        );
      const before = await statusAt("2026-07-01");
      assert.equal(before.overall, "waived");
      assert.equal(before.blocksPayment, false);
      const onDay = await statusAt("2026-07-10");
      assert.equal(onDay.overall, "missing");
      assert.equal(onDay.blocksPayment, true);
      const after = await statusAt("2026-07-20");
      assert.equal(after.overall, "missing");
      assert.equal(after.blocksPayment, true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
