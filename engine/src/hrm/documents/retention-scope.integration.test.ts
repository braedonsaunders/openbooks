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
  scopeRole,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { saveCategory } from "./categories.ts";
import { listSchedules, saveSchedule } from "./retention.ts";

/**
 * Retention schedules are
 * org-wide policy — they purge every legal entity's documents — so a
 * subsidiary-restricted manager cannot write them (canonical 403), while
 * the unrestricted admin still can and the read list stays open.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = { org: ScratchOrg; adminId: string; managerAId: string };

async function setupRetentionHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId, ["hrm", "hrmDocuments", "hrmDocumentRetention"]);
  const adminId = await createScratchUser(org.orgId, "Ada Admin", "ret_admin");
  await scopeRole(org.orgId, "ret_admin", ["hrm.documents.read", "hrm.documents.manage"], "all");
  const managerAId = await createScratchUser(org.orgId, "Mara Manager", "ret_manager_a");
  await scopeRole(org.orgId, "ret_manager_a", ["hrm.documents.read", "hrm.documents.manage"], [org.subsidiaryId]);
  await saveCategory({ orgId: org.orgId, actorId: adminId, key: "contract", label: "Contracts" });
  return { org, adminId, managerAId };
}



async function scheduleCount(orgId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ n: string }>(sql`
        select count(*) as n from hrm_retention_schedules where org_id = ${orgId}
      `)
    ).rows[0]!.n,
  );
}

const SAVE = {
  categoryKey: "contract",
  retainYears: 7,
  fromEvent: "completion",
  action: "anonymize",
} as const;

test("a subsidiary-restricted manager cannot write org-wide retention policy", { skip: !DB }, async () => {
  await withHarness(setupRetentionHarness, async (h: Harness) => {
    const before = await scheduleCount(h.org.orgId);
    await assert.rejects(
      saveSchedule({ orgId: h.org.orgId, actorId: h.managerAId, ...SAVE }),
      (e: unknown) =>
        e instanceof UnrestrictedScopeError && /requires unrestricted subsidiary access/.test(e.message),
    );
    assert.equal(await scheduleCount(h.org.orgId), before);
  });
});

test("the unrestricted admin still writes, and the read list stays open", { skip: !DB }, async () => {
  await withHarness(setupRetentionHarness, async (h: Harness) => {
    const saved = await saveSchedule({ orgId: h.org.orgId, actorId: h.adminId, ...SAVE });
    assert.equal(saved.categoryKey, "contract");
    const listed = await listSchedules({ orgId: h.org.orgId, actorId: h.managerAId });
    assert.ok(listed.some((row) => row.id === saved.id));
  });
});
