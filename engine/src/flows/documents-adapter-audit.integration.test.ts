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
      adapter.changeStatus!(docId, "pending_approval", {
        orgId: org.orgId,
        userId: actors.adminId,
      }),
    );

    const status = (
      await db.execute<{ status: string }>(
        sql`select status from documents where id = ${docId} and org_id = ${org.orgId}`,
        "objects",
      )
    )[0]!.status;
    assert.equal(status, "pending_approval");

    const rows = await db.execute<{
      action: string;
      actor_id: string | null;
      changes: Record<string, unknown>;
    }>(
      sql`
        select action, actor_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${docId}
         order by at, id
      `,
      "objects",
    );
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

test(
  "flow releaseApproval carries the decision reason on the document audit row",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const adapter = createDocumentsFlowAdapter("vendor_bill");
      const ctx = { orgId: org.orgId, userId: actors.adminId };

      const rejectedId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        number: "FLOW-AUDIT-REJECT",
      });
      await withOrg(org.orgId, () => adapter.changeStatus!(rejectedId, "pending_approval", ctx));
      await withOrg(org.orgId, () =>
        adapter.releaseApproval!(rejectedId, "rejected", ctx, {
          comment: "Wrong cost center — please fix",
        }),
      );

      const approveId = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        number: "FLOW-AUDIT-APPROVE",
      });
      await withOrg(org.orgId, () => adapter.changeStatus!(approveId, "pending_approval", ctx));
      await withOrg(org.orgId, () =>
        adapter.releaseApproval!(approveId, "approved", ctx, {
          comment: "Verified against the purchase order",
        }),
      );

      const rows = await db.execute<{
        row_id: string;
        changes: Record<string, unknown>;
      }>(
        sql`
        select row_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'documents'
           and (row_id = ${rejectedId} or row_id = ${approveId})
         order by at, id
      `,
        "objects",
      );
      const lastFor = (id: string) =>
        rows.filter((row) => row.row_id === id).at(-1)!.changes as {
          mode: string;
          source: string;
          reason?: string;
          before: { document: { status: string } };
          after: { document: { status: string } };
        };
      // The Approvals section reads the gate comment; the document's own change
      // set must name the same words, or the audit cannot explain the move.
      const rejection = lastFor(rejectedId);
      assert.equal(rejection.mode, "record_update");
      assert.equal(rejection.source, "flows");
      assert.equal(rejection.before.document.status, "pending_approval");
      assert.equal(rejection.after.document.status, "draft");
      assert.equal(rejection.reason, "Wrong cost center — please fix");
      const approval = lastFor(approveId);
      assert.equal(approval.before.document.status, "pending_approval");
      assert.equal(approval.after.document.status, "approved");
      assert.equal(approval.reason, "Verified against the purchase order");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
