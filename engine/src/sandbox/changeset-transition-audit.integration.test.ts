import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { approveChangeSet, reviewChangeSet } from "./promote.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Change-set review and approval are the four-eyes authorization for
 * promoting sandbox work into production. Each actor must hold
 * admin.sandboxes.manage (the same engine authority apply already required),
 * and each transition must leave an audit_log row naming its actor with the
 * before/after status, not just the reviewed_by/approved_by columns.
 * (Per-row apply evidence already exists; these header transitions have none.)
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function insertDraftChangeSet(orgId: string, createdBy: string): Promise<string> {
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
    await db.execute<{ status: string }>(sql`
      select status from change_sets where id = ${changeSetId} and org_id = ${orgId}`)
  ).rows[0]!.status;
}

async function setRolePermissions(orgId: string, roleKey: string, permissions: readonly string[]): Promise<void> {
  const updated = await db.execute(sql`
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
      () => approveChangeSet(changeSetId, actors.approver2Id),
      /requires admin\.sandboxes\.manage/,
    );
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "reviewed");

    await setRolePermissions(org.orgId, "approver", ["admin.sandboxes.manage"]);
    await approveChangeSet(changeSetId, actors.approver2Id);
    assert.equal(await changeSetStatus(org.orgId, changeSetId), "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("change-set review and approval evidence their transitions in audit_log", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await setRolePermissions(org.orgId, "approver", ["admin.sandboxes.manage"]);
    const changeSetId = await insertDraftChangeSet(org.orgId, actors.submitterId);

    await reviewChangeSet(changeSetId, actors.approver1Id);
    await approveChangeSet(changeSetId, actors.approver2Id);

    const status = (
      await db.execute<{ status: string }>(sql`
        select status from change_sets where id = ${changeSetId} and org_id = ${org.orgId}`)
    ).rows[0]!.status;
    assert.equal(status, "approved");

    const rows = (
      await db.execute<{
        action: string;
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(sql`
        select action, actor_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'change_sets' and row_id = ${changeSetId}
         order by at, id
      `)
    ).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.action),
      ["update", "update"],
    );
    assert.deepEqual(
      rows.map((row) => row.actor_id),
      [actors.approver1Id, actors.approver2Id],
    );
    const [reviewed, approved] = rows.map((row) => row.changes as {
      operation: string;
      before: { status: string };
      after: { status: string };
    });
    assert.equal(reviewed!.operation, "review");
    assert.equal(reviewed!.before.status, "draft");
    assert.equal(reviewed!.after.status, "reviewed");
    assert.equal(approved!.operation, "approve");
    assert.equal(approved!.before.status, "reviewed");
    assert.equal(approved!.after.status, "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
