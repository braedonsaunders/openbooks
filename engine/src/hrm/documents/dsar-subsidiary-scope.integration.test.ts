import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import {
  enableFeatures,
  mkSecondSubsidiary,
  scopeRole,
  seedPerson,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { HrmDocumentsError } from "./errors.ts";
import {
  buildExport,
  downloadExport,
  listExports,
  requestExport,
} from "./dsar.ts";

/**
 * Two-entity DSAR regressions: an HR actor
 * restricted to subsidiary A cannot queue a full data ZIP for B's people,
 * lists only in-scope subjects' exports, and cannot download (or mark
 * delivered) B's ready export. Proofs are read back from storage, never
 * from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  adminId: string;
  managerAId: string;
  partyA: string;
  partyB: string;
};

async function setupDsarSubsidiaryHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId, ["hrm", "hrmDocuments", "hrmDataSubjectExport"]);
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId, { currency: "USD", country: "US" });
  const empA = await seedPerson(org.orgId, org.subsidiaryId, "Amy Alpha");
  const empB = await seedPerson(org.orgId, subB, "Ben Beta");
  const adminId = await createScratchUser(org.orgId, "Ada Admin", "dsar_admin");
  await scopeRole(org.orgId, "dsar_admin", ["hrm.documents.read", "hrm.documents.manage"], "all");
  const managerAId = await createScratchUser(org.orgId, "Mara Manager", "dsar_manager_a");
  await scopeRole(org.orgId, "dsar_manager_a", ["hrm.documents.read", "hrm.documents.manage"], [org.subsidiaryId]);
  return { org, adminId, managerAId, partyA: empA.partyId, partyB: empB.partyId };
}

async function exportCount(orgId: string, partyId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ n: string }>(sql`
        select count(*) as n from hrm_data_subject_exports where org_id = ${orgId} and party_id = ${partyId}
      `)
    ).rows[0]!.n,
  );
}

test("an A-restricted manager cannot queue an export for an out-of-scope subject", { skip: !DB }, async () => {
  await withHarness(setupDsarSubsidiaryHarness, async (h: Harness) => {
    const before = await exportCount(h.org.orgId, h.partyB);
    await assert.rejects(
      requestExport({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyB }),
      /not visible in this organization/,
    );
    assert.equal(await exportCount(h.org.orgId, h.partyB), before);
    // The in-scope subject still queues.
    const queued = await requestExport({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyA });
    assert.equal(queued.partyId, h.partyA);
  });
});

test("an A-restricted manager lists only in-scope subjects' exports", { skip: !DB }, async () => {
  await withHarness(setupDsarSubsidiaryHarness, async (h: Harness) => {
    await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyA });
    await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyB });
    const listed = await listExports({ orgId: h.org.orgId, actorId: h.managerAId });
    assert.ok(listed.length > 0);
    for (const row of listed) assert.equal(row.partyId, h.partyA);
    await assert.rejects(
      listExports({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyB }),
      /not visible in this organization/,
    );
  });
});

test("an A-restricted manager cannot download an out-of-scope ready export", { skip: !DB }, async () => {
  await withHarness(setupDsarSubsidiaryHarness, async (h: Harness) => {
    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyB });
    await buildExport(h.org.orgId, requested.id);
    const status = (
      await db.execute<{ status: string }>(sql`
        select status from hrm_data_subject_exports where org_id = ${h.org.orgId} and id = ${requested.id}
      `)
    ).rows[0]!.status;
    assert.equal(status, "ready");
    await assert.rejects(
      downloadExport({ orgId: h.org.orgId, actorId: h.managerAId, exportId: requested.id }),
      (e: unknown) => e instanceof HrmDocumentsError || /not visible in this organization/.test(String(e)),
    );
    // The refused read never flips the row to delivered.
    const after = (
      await db.execute<{ status: string }>(sql`
        select status from hrm_data_subject_exports where org_id = ${h.org.orgId} and id = ${requested.id}
      `)
    ).rows[0]!.status;
    assert.equal(after, "ready");
  });
});
