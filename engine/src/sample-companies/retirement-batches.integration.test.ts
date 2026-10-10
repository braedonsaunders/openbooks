import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withMaintenanceTransaction, withOrgContext } from "../platform/db.ts";
import { installEngineSeams } from "../composition/install.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { seedRolesForOrg } from "../provisioning/seed-roles.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { loadCatalog } from "../sandbox/catalog.ts";
import { beginTenantRetirement, releaseTenantRetirement } from "../organization/tenant-retirement.ts";
import { admitSampleRetirement } from "./retirement.ts";
import { sampleRetirementPlan } from "./retirement-plan.ts";
import { deleteRetiredTenantRows, retirementFingerprint } from "./retirement-data.ts";
import { retireSampleFixtureCompanies } from "./retirement-test-fixtures.ts";
import type { RetirementDatabaseIdentity } from "./retirement-contract.ts";

installEngineSeams();

test("bounded native retirement keeps complete journal entries and restores all batches on target rollback", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const anchor = await withBypass(() => createScratchOrg());
  const target = await withBypass(() => createScratchOrg());
  const retained = await withBypass(() => createScratchOrg());
  const actor = await withBypass(async () => {
    await seedRolesForOrg(anchor.orgId);
    return createScratchUser(anchor.orgId, "Recovery administrator", "admin");
  });
  let admission: { runId: string; digest: string } | undefined;
  try {
    for (const org of [target, retained]) {
      const author = await withBypass(async () => {
        await seedRolesForOrg(org.orgId);
        return createScratchUser(org.orgId, "Native journal author", "admin");
      });
      for (let index = 0; index < (org === target ? 5 : 1); index += 1) {
        await withOrgContext(org.orgId, () => createScriptJournal(org.orgId, author, {
          documentDate: org.date, subsidiaryId: org.subsidiaryId,
          memo: "Native balanced journal retained by recovery",
          lines: [
            { accountId: org.accounts.bank, amount: "25.00" },
            { accountId: org.accounts.adjustment, amount: "-25.00" },
          ],
        }, { post: index % 2 === 0, allowedSubsidiaryIds: null, idempotencyKey: `recovery:${org.orgId}:${index}` }));
      }
    }
    const snapshot = (id: string) => withMaintenanceTransaction(null, async () => retirementFingerprint(await loadCatalog(), id), { isolationLevel: "REPEATABLE READ" });
    const beforeTarget = await snapshot(target.orgId);
    const beforeRetained = await snapshot(retained.orgId);
    const expectedLines = beforeTarget.tables.find(table => table.table === "journal_lines")!.count;
    assert.ok(BigInt(expectedLines) >= 6n, "several actual posted entries exercise separate balancing statements");
    const selection = await withMaintenanceTransaction(null, async () => {
      const identity = (await db.execute<RetirementDatabaseIdentity & Record<string, unknown>>(sql`
        select current_database() as database,inet_server_addr()::text as "serverAddress",
          inet_server_port() as "serverPort",current_setting('cluster_name') as "clusterName"`)).rows[0]!;
      const ids = (await db.execute<{ id: string }>(sql`select id from orgs order by id`)).rows.map(row => row.id);
      return { version: 1 as const, database: identity, retainOrgIds: ids.filter(id => id !== target.orgId),
        retireOrgIds: [target.orgId], reason: "Verify whole-company rollback across bounded native deletion statements" };
    });
    const plan = await sampleRetirementPlan(selection);
    assert.equal(plan.admissible, true, JSON.stringify(plan.blockers));
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const runId = randomUUID();
    // Disposable-fixture attestations exercise admission only; operational
    // retirement still requires a verified real backup and restore.
    await admitSampleRetirement({ plan, runId, actorId: actor, recovery: {
      backupSha256: hash("fixture backup"), restoreReceiptSha256: hash("fixture restore"),
      preservationReceiptSha256: hash("fixture preservation"), objectRetentionReceiptSha256: hash("fixture object retention"),
      verifiedAt: new Date().toISOString(), verifier: "Native bounded retirement integration fixture",
    } });
    admission = { runId, digest: plan.digest };
    await assert.rejects(withMaintenanceTransaction(null, async () => {
      assert.equal(await beginTenantRetirement(runId, target.orgId, plan.digest), true);
      await db.execute(sql`set constraints all deferred`);
      const removed = await deleteRetiredTenantRows(await loadCatalog(), target.orgId, { batchSize: 1 });
      assert.equal(removed.journal_lines, expectedLines, "complete entries pass the unchanged balance and FX statement guards");
      assert.equal(removed.orgs, "1");
      assert.equal((await db.execute(sql`select id from orgs where id=${target.orgId}`)).rows.length, 0);
      throw new Error("Roll back every completed deletion batch");
    }, { isolationLevel: "REPEATABLE READ" }), /Roll back every completed deletion batch/);
    assert.deepEqual(await snapshot(target.orgId), beforeTarget, "every posted, draft, configuration and audit row returns");
    assert.deepEqual(await snapshot(retained.orgId), beforeRetained, "retained native financial history is unchanged");
  } finally {
    if (admission) await releaseTenantRetirement({ runId: admission.runId, orgId: target.orgId,
      planDigest: admission.digest, actorId: actor, reason: "Release the intact native batch fixture for exact reviewed cleanup" });
    assert.equal(await retireSampleFixtureCompanies(anchor.orgId, [target.orgId, retained.orgId]), true);
    await withBypass(() => dropScratchOrg(anchor.orgId));
  }
});
