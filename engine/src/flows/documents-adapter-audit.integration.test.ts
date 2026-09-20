import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Flow-driven document mutations must leave the same transaction evidence as
 * every other document writer: an audit_log row with the actor (null for
 * timer-fired runs), the source, and the before/after snapshots. The flow
 * run's effect checkpoint records THAT an action ran, not what it changed.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

test("flow change_status evidences the document mutation in audit_log", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const docId = await seedDraftDocument(org.orgId, {
      kind: "vendor_bill",
      createdBy: actors.submitterId,
      number: "FLOW-AUDIT-001",
    });
    const adapter = createDocumentsFlowAdapter("vendor_bill");

    await withOrg(org.orgId, () =>
      adapter.changeStatus!(docId, "pending_approval", { orgId: org.orgId, userId: actors.adminId }),
    );

    const status = (
      await db.execute<{ status: string }>(
        sql`select status from documents where id = ${docId} and org_id = ${org.orgId}`,
      )
    ).rows[0]!.status;
    assert.equal(status, "pending_approval");

    const rows = (
      await db.execute<{
        action: string;
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(sql`
        select action, actor_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${docId}
         order by at, id
      `)
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "update");
    assert.equal(rows[0]!.actor_id, actors.adminId);
    const changes = rows[0]!.changes as {
      mode: string;
      source: string;
      before: { document: { status: string } };
      after: { document: { status: string } };
    };
    assert.equal(changes.mode, "record_update");
    assert.equal(changes.source, "flows");
    assert.equal(changes.before.document.status, "draft");
    assert.equal(changes.after.document.status, "pending_approval");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
