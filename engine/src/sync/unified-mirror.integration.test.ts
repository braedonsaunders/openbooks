import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { MigrationSource } from "./source.ts";
import type { ImportSummary } from "./netsuite-attachments.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const attachmentSummary: ImportSummary = {
  scope: "all", requestedSourceFileIds: [], sourceDocuments: 0, sourceDocumentsWithoutId: 0,
  sourceFiles: 0, sourceLinks: 0, createdFiles: 0, newVersions: 0,
  unchangedFiles: 0, skippedUnchanged: 0, createdLinks: 0, failures: 0, failureDetails: [],
};

test("one mirror includes supplemental populations and advances only after every phase succeeds", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const connectionId = randomUUID();
    await db.execute(sql`insert into connections (id, org_id, source, display_name)
      values (${connectionId}, ${org.orgId}, 'qbo', 'Unified mirror')`);
    const phases: string[] = [];
    let failAttachments = false;
    let failProjectInputs = false;
    let watermark = new Date("2026-10-01T00:00:00Z");
    const source: MigrationSource = {
      name: "qbo", refKey: "qboId", baseCurrency: "CAD",
      accountingPeriods: async () => [], entities: async () => [],
      nativeChanges: async () => ({ documents: [], applications: [], deletedRefs: [], syncedThrough: watermark, unbuildable: [] }),
      trialBalance: async () => [], monthlyActivity: async () => [], openItems: async () => [],
      syncAttachments: async (options) => {
        assert.equal(options.orgId, org.orgId);
        assert.equal(options.connectionId, connectionId);
        assert.equal(options.actorId, null, "scheduled work never impersonates an administrator");
        phases.push("attachments");
        if (failAttachments) throw new Error("Source attachment metadata unavailable");
        return attachmentSummary;
      },
      projectFinancialInputs: async () => {
        phases.push("project-financials");
        if (failProjectInputs) throw new Error("Project billing snapshot unavailable");
        return { projects: [], timeEntryBillingStates: [] };
      },
      syncOperationalRecords: async () => {
        phases.push("operational-records");
        return { disabledFeatures: ["crm", "fixedAssets"] };
      },
    };
    const options = { orgId: org.orgId, connectionId, since: null };
    const ok = await runSync(source, "scheduler", options);
    assert.deepEqual(phases, ["operational-records", "attachments", "project-financials"]);
    assert.deepEqual(ok.attachments, attachmentSummary);
    assert.equal(ok.projectFinancials?.sourceProjects, 0);
    assert.deepEqual(ok.operationalRecords?.disabledFeatures, ["crm", "fixedAssets"]);
    const cursor = async () => (await db.execute<{ cursor: string }>(sql`select cursor::text from connections where org_id=${org.orgId} and id=${connectionId}`)).rows[0]!.cursor;
    const originalCursor = await cursor();
    failAttachments = true;
    watermark = new Date("2026-10-02T00:00:00Z");
    await assert.rejects(runSync(source, "scheduler", options), /Source attachment metadata unavailable/);
    assert.equal(await cursor(), originalCursor);
    failAttachments = false;
    failProjectInputs = true;
    await assert.rejects(runSync(source, "scheduler", options), /Project billing snapshot unavailable/);
    assert.equal(await cursor(), originalCursor);
    const row = (await db.execute<{ status: string; stats: { attachments: ImportSummary } }>(sql`
      select status, stats from sync_runs where org_id=${org.orgId} and connection_id=${connectionId}
      order by started_at desc limit 1`)).rows[0]!;
    assert.equal(row.status, "failed");
    assert.deepEqual(row.stats.attachments, attachmentSummary, "successful attachment evidence survives a later refusal");
  } finally { await dropScratchOrg(org.orgId); }
});
