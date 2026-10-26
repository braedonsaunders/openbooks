import { installEngineSeams } from "../composition/install.ts";
import { submitComplianceWaiver } from "./waivers.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { vendorComplianceStatus } from "./compliance.ts";

/**
 * Revoking a compliance exception must narrow its window, not erase it.
 * vendorComplianceStatus as of a date before the revocation still reports
 * waived; on/after the revocation it reports the underlying failure again.
 * The revocation date is the org-local calendar date (same basis as
 * businessToday), not the UTC date of the instant.
 */
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedRevokedWaiver(
  orgId: string,
  actorId: string,
  partyId: string,
  requirementId: string,
  revokedAt: string,
): Promise<void> {
  installEngineSeams();
  await grantScratchPermissions(orgId, actorId, ["compliance.waive"]);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"subcontractorCompliance":true}'::jsonb) where id=${orgId}`);
  const waiver = (
    await db.execute<{ id: string }>(
      sql`
    insert into compliance_waivers
      (org_id,party_id,requirement_id,reason,effective_from,expires_on,created_by,updated_by,requested_by,approved_by,approved_at)
    values (${orgId},${partyId},${requirementId},'Bounded exception window','2026-06-01','2026-08-01',${actorId},${actorId},${actorId},null,null) returning id`,
      "objects",
    )
  )[0]!;
  const released = await submitComplianceWaiver({ orgId, actorId, id: waiver.id });
  assert.equal(released.status, "approved");
  await db.execute(sql`update compliance_waivers set revoked_at=${revokedAt}::timestamptz,
    revoked_by=${actorId},revoke_reason='No longer needed',updated_by=${actorId}
    where org_id=${orgId} and id=${waiver.id}`);
}

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
          await db.execute<{ id: string }>(
            sql`
            insert into compliance_classes (org_id, code, name, created_by, updated_by)
            values (${org.orgId}, 'TRADE', 'Trade', ${actorId}, ${actorId})
            returning id`,
            "objects",
          )
        )[0]!.id;
        await db.execute(sql`
          insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
          values (${org.orgId}, ${partyId}, ${cls}, ${actorId}, ${actorId})`);
        const req = (
          await db.execute<{ id: string }>(
            sql`
            insert into compliance_requirements
              (org_id, class_id, code, name, category, enforcement, requires_verification, created_by, updated_by)
            values (${org.orgId}, ${cls}, 'GL', 'General Liability', 'insurance', 'block_payment', false, ${actorId}, ${actorId})
            returning id`,
            "objects",
          )
        )[0]!.id;
        await seedRevokedWaiver(org.orgId, actorId, partyId, req, "2026-07-10T14:00:00Z");
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

test("a late-evening revocation stops covering that org-local day", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() =>
      createScratchUser(org.orgId, "Compliance Manager", "compliance_manager"),
    );
    const partyId = randomUUID();
    await withBypassContext(async () => {
      // 2026-07-10T02:00:00Z is 21:00 July 9th in Chicago: the UTC date
      // (July 10th) would still cover the 9th, the org-local date does not.
      await db.execute(sql`
          update orgs set settings = coalesce(settings, '{}'::jsonb) || '{"timeZone": "America/Chicago"}'::jsonb
           where id = ${org.orgId}`);
      await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id, created_by, updated_by)
          values (${partyId}, ${org.orgId}, 'company', 'Timezone Vendor', ${org.subsidiaryId}, ${actorId}, ${actorId})`);
      const cls = (
        await db.execute<{ id: string }>(
          sql`
            insert into compliance_classes (org_id, code, name, created_by, updated_by)
            values (${org.orgId}, 'TRADE', 'Trade', ${actorId}, ${actorId})
            returning id`,
          "objects",
        )
      )[0]!.id;
      await db.execute(sql`
          insert into vendor_roles (org_id, party_id, compliance_class_id, created_by, updated_by)
          values (${org.orgId}, ${partyId}, ${cls}, ${actorId}, ${actorId})`);
      const req = (
        await db.execute<{ id: string }>(
          sql`
            insert into compliance_requirements
              (org_id, class_id, code, name, category, enforcement, requires_verification, created_by, updated_by)
            values (${org.orgId}, ${cls}, 'GL', 'General Liability', 'insurance', 'block_payment', false, ${actorId}, ${actorId})
            returning id`,
          "objects",
        )
      )[0]!.id;
      await seedRevokedWaiver(org.orgId, actorId, partyId, req, "2026-07-10T02:00:00Z");
    });
    const statusAt = (asOf: string) =>
      withOrgContext(org.orgId, () => vendorComplianceStatus({ orgId: org.orgId, partyId, asOf }));
    const covered = await statusAt("2026-07-08");
    assert.equal(covered.overall, "waived");
    const revokedDay = await statusAt("2026-07-09");
    assert.equal(revokedDay.overall, "missing");
    assert.equal(revokedDay.blocksPayment, true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
