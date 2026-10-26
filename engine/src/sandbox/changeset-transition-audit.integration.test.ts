import { installEngineSeams } from "../composition/install.ts";
import { decideGate } from "../flows/gates.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { reviewChangeSet } from "./promote.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
} from "../testing/fixtures.ts";

/** Tenant-configured change-set decisions require current native authority
 * and retain actor, time and before/after audit evidence. */
installEngineSeams();
const DB = !!process.env.OPENBOOKS_DB_URL;

async function insertDraftChangeSet(orgId: string, createdBy: string): Promise<string> {
  // Review/approval need a live ready sandbox: a shell row on the scratch org (no clone — authority, not capture).
  await db.execute(sql`
    insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
    values (${randomUUID()}, ${orgId}, ${orgId}, 'Authority probe source', 'full', false, 'ready')`);
  const changeSetId = randomUUID();
  await db.execute(sql`
    insert into change_sets
      (id, org_id, sandbox_org_id, name, status, capture_complete, item_count, created_by)
    values
      (${changeSetId}, ${orgId}, ${orgId}, 'Authority probe', 'draft', true, 0, ${createdBy})
  `);
  return changeSetId;
}

async function changeSetStatus(orgId: string, changeSetId: string): Promise<string> {
  return (
    await db.execute<{ status: string }>(
      sql`
      select status from change_sets where id = ${changeSetId} and org_id = ${orgId}`,
      "objects",
    )
  )[0]!.status;
}

async function setRolePermissions(
  orgId: string,
  roleKey: string,
  permissions: readonly string[],
): Promise<void> {
  const updated = await db.execute<never>(sql`
    update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new Error(`failed to set ${roleKey} permissions in ${orgId}`);
  }
}

test("change-set review and approval require admin.sandboxes.manage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const changeSetId = await insertDraftChangeSet(org.orgId, actors.submitterId);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "sandbox_change_set",
      assignees: [{ type: "user", userId: actors.approver2Id }],
      mode: "all",
    });

    // An active production user is not enough: seedFlowActors mints the
    // approver role with permissions []. Unrelated grants, and a deny of the
    // sandbox-management key, must also refuse — otherwise a role-JSON-only
    // check could pass while promotionAuthority would not.
    await setRolePermissions(org.orgId, "approver", ["gl.read"]);
    await assert.rejects(
      () => reviewChangeSet(changeSetId, actors.approver1Id),
      /requires admin\.sandboxes\.manage/,
    );
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "draft");

    await setRolePermissions(org.orgId, "approver", ["admin.sandboxes.manage"]);
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${org.orgId}, ${actors.approver1Id}, 'admin.sandboxes.manage', 'deny')`);
    await assert.rejects(
      () => reviewChangeSet(changeSetId, actors.approver1Id),
      /requires admin\.sandboxes\.manage/,
    );
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "draft");

    await db.execute(sql`
      delete from user_permission_overrides
       where org_id = ${org.orgId} and user_id = ${actors.approver1Id}
         and permission = 'admin.sandboxes.manage'`);
    await reviewChangeSet(changeSetId, actors.approver1Id);
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "reviewed");

    await setRolePermissions(org.orgId, "approver", []);
    await assert.rejects(
      () => decideChangeSet(org.orgId, changeSetId, actors.approver2Id),
      /not an approver|permission|authoriz|admin\.sandboxes\.manage/i,
    );
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "reviewed");

    await setRolePermissions(org.orgId, "approver", ["admin.sandboxes.manage"]);
    await decideChangeSet(org.orgId, changeSetId, actors.approver2Id);
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "change-set review and approval evidence their transitions in audit_log",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await setRolePermissions(org.orgId, "approver", ["admin.sandboxes.manage"]);
      const changeSetId = await insertDraftChangeSet(org.orgId, actors.submitterId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "sandbox_change_set",
        assignees: [{ type: "user", userId: actors.approver2Id }],
        mode: "all",
      });

      await reviewChangeSet(changeSetId, actors.approver1Id);
      await decideChangeSet(org.orgId, changeSetId, actors.approver2Id);

      assert.equal(await changeSetStatus(org.orgId, changeSetId), "approved");

      const rows = await db.execute<{
        action: string;
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(
        sql`
        select action, actor_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'change_sets' and row_id = ${changeSetId}
         order by at, id
      `,
        "objects",
      );
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => row.action),
        ["update", "update"],
      );
      assert.deepEqual(
        rows.map((row) => row.actor_id),
        [actors.approver1Id, actors.approver2Id],
      );
      const [reviewed, approved] = rows.map(
        (row) =>
          row.changes as {
            operation: string;
            before: { status: string };
            after: { status: string };
          },
      );
      assert.equal(reviewed!.operation, "review");
      assert.equal(reviewed!.before.status, "draft");
      assert.equal(reviewed!.after.status, "reviewed");
      assert.equal(approved!.operation, "approve");
      assert.equal(approved!.before.status, "reviewed");
      assert.equal(approved!.after.status, "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

async function decideChangeSet(orgId: string, subjectId: string, userId: string): Promise<void> {
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${orgId}
    and subject_kind='sandbox_change_set' and subject_id=${subjectId} and status='pending'`,
      "objects",
    )
  )[0];
  assert.ok(gate);
  await decideGate({ gateId: gate.id, userId, decision: "approved" });
}
