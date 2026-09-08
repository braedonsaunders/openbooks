import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../test-fixtures.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

// Live-Postgres regression: a change set must diff EVERY promotable table.
// The catalog lookup filters `table_name = any(<promotable>)`; a plain JS
// array bound into a drizzle sql template serializes as a row constructor
// `( $1, $2 )` without an array cast, which PostgreSQL rejects outright once
// more than one promotable table exists — so this fixture seeds rows in TWO
// promotable tables (user_scripts + saved_views) and requires the diff to
// cover both.
const DB = !!process.env.OPENBOOKS_DB_URL;

interface ChangeSetItemRow extends Record<string, unknown> {
  table_name: string;
  target_id: string;
  op: string;
  payload: Record<string, unknown> | null;
}

test("buildChangeSet diffs multiple promotable tables and applies the approved result", { skip: !DB }, async () => {
  const prod = await createScratchOrg();
  const actorId = await createScratchUser(prod.orgId, "Promote Admin", "admin");
  const reviewerId = await createScratchUser(prod.orgId, "Promote Reviewer", "admin");
  const approverId = await createScratchUser(prod.orgId, "Promote Approver", "admin");
  const applierId = await createScratchUser(prod.orgId, "Promote Applier", "admin");
  const sbxOrgId = randomUUID();
  const seed = randomUUID();
  const sandboxId = randomUUID();
  try {
    // Hand-rolled sandbox pair (orgs + sandboxes): buildChangeSet reads only
    // these identity rows plus the live catalog, so a full clone adds nothing
    // but cost to what this regression proves.
    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind, sandbox_of, sandbox_seed)
      values (${sbxOrgId}, ${"Scratch " + sbxOrgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb,
              'sandbox', ${prod.orgId}, ${seed})`);
    await db.execute(sql`
      insert into sandboxes (id, org_id, production_org_id, name, tier, masked, status)
      values (${sandboxId}, ${sbxOrgId}, ${prod.orgId}, 'Promote Diff Regression', 'full', false, 'ready')`);

    // Real sandboxes clone role policy. Preserve that counterpart here, and
    // use an unassigned custom role to exercise an intentional role deletion.
    await db.execute(sql`insert into app_roles(id, org_id, key, name, description, is_built_in, permissions, subsidiary_restriction)
      select ob_rebase(id, ${seed}::uuid), ${sbxOrgId}, key, name, description, is_built_in, permissions, subsidiary_restriction
        from app_roles where org_id = ${prod.orgId}`);
    const deletedRoleId = randomUUID();
    await db.execute(sql`insert into app_roles(id, org_id, key, name, is_built_in, permissions)
      values (${deletedRoleId}, ${prod.orgId}, 'unused_custom', 'Unused custom', false, '[]'::jsonb)`);

    // user_scripts — matched-identical pair, matched-changed pair, sandbox-only row.
    const pMatchedScript = randomUUID();
    const pChangedScript = randomUUID();
    const sNewScript = randomUUID();
    await db.execute(sql`
      insert into user_scripts (org_id, id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
      values (${prod.orgId}, ${pMatchedScript}, 'Ledger Guard', 'record_after_submit', 'journal_entry',
              'export function run() { return true }', 2000, 100, true),
             (${prod.orgId}, ${pChangedScript}, 'Stale Name', 'record_after_submit', null,
              'export function run() { return false }', 2000, 200, true),
             (${sbxOrgId}, ${sNewScript}, 'Sandbox Only Script', 'before_submit', 'document',
              'export function run() { return 1 }', 4000, 300, true)`);
    const sMatchedScript = await rebase(pMatchedScript, seed);
    const sChangedScript = await rebase(pChangedScript, seed);
    await db.execute(sql`
      insert into user_scripts (org_id, id, name, trigger_point, document_kind, source, timeout_ms, sort_order, is_active)
      values (${sbxOrgId}, ${sMatchedScript}, 'Ledger Guard', 'record_after_submit', 'journal_entry',
              'export function run() { return true }', 2000, 100, true),
             (${sbxOrgId}, ${sChangedScript}, 'Renamed Script', 'record_after_submit', null,
              'export function run() { return false }', 2000, 200, true)`);

    // saved_views — matched-identical pair and a production-only row (delete).
    const pMatchedView = randomUUID();
    const pDeletedView = randomUUID();
    const sMatchedView = await rebase(pMatchedView, seed);
    await db.execute(sql`
      insert into saved_views (org_id, id, slug, name, description, query, layout, scope, owner_id)
      values (${prod.orgId}, ${pMatchedView}, 'ar-open', 'Open AR', 'Aging buckets',
              '{"kind":"list","entity":"invoices"}'::jsonb, null, 'global', ${actorId}),
             (${prod.orgId}, ${pDeletedView}, 'gl-mtd', 'Month to Date GL', null,
              '{"kind":"report","report":"gl"}'::jsonb, '{"columns":["date"]}'::jsonb, 'global', ${actorId}),
             (${sbxOrgId}, ${sMatchedView}, 'ar-open', 'Open AR', 'Aging buckets',
              '{"kind":"list","entity":"invoices"}'::jsonb, null, 'global', ${actorId})`);

    const { changeSetId, itemCount } = await buildChangeSet(sandboxId, "Promote Diff Regression", actorId);
    const cs = (await db.execute<{
      org_id: string;
      sandbox_org_id: string;
      status: string;
      name: string;
      capture_complete: boolean;
      item_count: number;
    }>(sql`
      select org_id, sandbox_org_id, status, name, capture_complete, item_count
        from change_sets where id = ${changeSetId}`));
    assert.deepEqual(cs.rows[0], {
      org_id: prod.orgId,
      sandbox_org_id: sbxOrgId,
      status: "draft",
      name: "Promote Diff Regression",
      capture_complete: true,
      item_count: itemCount,
    });

    const items = (await db.execute<ChangeSetItemRow>(sql`
      select table_name, target_id::text as "target_id", op, payload
        from change_set_items where change_set_id = ${changeSetId} order by table_name, op`));
    assert.equal(itemCount, items.rows.length);

    const byKey = new Map(items.rows.map((r) => [`${r.table_name}:${r.op}:${r.target_id}`, r]));
    assert.equal(items.rows.length, 4, `expected exactly 4 diff items, got ${JSON.stringify(items.rows)}`);

    // Changed pair → update carrying the sandbox content onto the production id.
    const update = byKey.get(`user_scripts:update:${pChangedScript}`);
    assert.ok(update, "changed user_scripts pair must produce an update item");
    assert.equal(update!.payload?.name, "Renamed Script");
    assert.equal(update!.payload?.org_id, prod.orgId);

    // Sandbox-only row → insert. Promotion mints a NEW production id rather
    // than carrying the sandbox row id across (payload keeps sandbox content).
    const insertItem = items.rows.find((r) => r.table_name === "user_scripts" && r.op === "insert");
    assert.ok(insertItem, "sandbox-only user_script must produce an insert item");
    assert.equal(insertItem!.payload?.name, "Sandbox Only Script");
    assert.equal(insertItem!.payload?.org_id, prod.orgId);
    assert.notEqual(insertItem!.target_id, sNewScript);

    // Production-only view → delete, no payload.
    const del = byKey.get(`saved_views:delete:${pDeletedView}`);
    assert.ok(del, "production-only saved_view must produce a delete item");
    assert.equal(del!.payload, null);

    // Production-only unassigned custom role → delete from a THIRD promotable table.
    const roleDel = byKey.get(`app_roles:delete:${deletedRoleId}`);
    assert.ok(roleDel, "production-only app_role must produce a delete item");

    // Matched-identical pairs in BOTH tables stay out of the change set.
    assert.ok(!byKey.has(`user_scripts:update:${pMatchedScript}`));
    assert.ok(![...items.rows].some((r) => r.target_id === sMatchedScript || r.target_id === sChangedScript));

    // A captured draft is not executable. Review and approval are explicit,
    // and each lifecycle step must be performed by a different actor.
    await assert.rejects(() => applyChangeSet(changeSetId, actorId), /not approved/);
    await db.execute(sql`update change_sets set capture_complete = false where id = ${changeSetId}`);
    await assert.rejects(() => reviewChangeSet(changeSetId, reviewerId), /capture is incomplete/);
    await db.execute(sql`update change_sets set capture_complete = true where id = ${changeSetId}`);
    await reviewChangeSet(changeSetId, reviewerId);
    await assert.rejects(() => approveChangeSet(changeSetId, reviewerId), /different users/);
    await approveChangeSet(changeSetId, approverId);
    await assert.rejects(
      () =>
        db
          .execute(sql`update change_set_items set payload = '{}'::jsonb where change_set_id = ${changeSetId}`)
          .catch((error: unknown) => {
            assert.match(String((error as { cause?: { message?: string } }).cause?.message), /immutable after review/);
            throw error;
          }),
      /Failed query/,
    );
    await assert.rejects(() => applyChangeSet(changeSetId, approverId), /different users/);

    // Apply: production converges to the sandbox customization layer, with an
    // attributable actor distinct from the creator, reviewer, and approver.
    await applyChangeSet(changeSetId, applierId);
    const appliedScripts = (await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from user_scripts where org_id = ${prod.orgId} order by name`));
    assert.deepEqual(appliedScripts.rows, [
      { id: pMatchedScript, name: "Ledger Guard" },
      { id: pChangedScript, name: "Renamed Script" },
      { id: insertItem!.target_id, name: "Sandbox Only Script" },
    ]);
    assert.ok(!appliedScripts.rows.some((r) => r.id === sNewScript), "the sandbox id must not leak into production");
    const appliedViews = (await db.execute<{ id: string }>(sql`
      select id::text as id from saved_views where org_id = ${prod.orgId} order by id`));
    assert.deepEqual(appliedViews.rows.map((r) => r.id), [pMatchedView]);
    const audit = await db.execute<{ table_name: string; changes: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }; actor_id: string }>(sql`
      select table_name, changes, actor_id from audit_log where org_id = ${prod.orgId}
       and changes->>'changeSetId' = ${changeSetId}`);
    assert.equal(audit.rows.length, 4, "every promoted configuration has before/after audit evidence");
    assert.ok(audit.rows.every((row) => row.actor_id === applierId));
    const scriptAudit = audit.rows.find((row) => row.table_name === "user_scripts" && row.changes.before?.id === pChangedScript)!;
    assert.equal(scriptAudit.changes.before?.name, "Stale Name");
    assert.equal(scriptAudit.changes.after?.name, "Renamed Script");
    assert.equal(scriptAudit.changes.before?.created_at, scriptAudit.changes.after?.created_at, "updates preserve creation evidence");
    assert.equal(scriptAudit.changes.after?.updated_by, applierId);
    assert.equal((await db.execute(sql`select id from role_assignments where org_id = ${prod.orgId}`)).rows.length, 4, "promotion preserves every actor's assigned role");
    const status = (await db.execute<{ status: string; applied_by: string; approved_by: string; reviewed_by: string }>(sql`
      select status, applied_by, approved_by, reviewed_by from change_sets where id = ${changeSetId}`));
    assert.deepEqual(status.rows[0], {
      status: "applied",
      applied_by: applierId,
      approved_by: approverId,
      reviewed_by: reviewerId,
    });
  } finally {
    await dropScratchOrgReporting(sbxOrgId);
    await dropScratchOrgReporting(prod.orgId);
  }
});

async function rebase(id: string, seed: string): Promise<string> {
  const r = (await db.execute<{ rebased: string }>(sql`
    select ob_rebase(${id}::uuid, ${seed}::uuid)::text as rebased`));
  return r.rows[0]!.rebased;
}

async function rolePromotionFixture(kind: "update_assigned" | "delete_assigned" | "delete_builtin" | "update_admin") {
  const prod = await createScratchOrg();
  const actors = await Promise.all(["Creator", "Reviewer", "Approver", "Applier"].map((name) =>
    createScratchUser(prod.orgId, name, "admin")));
  const adminId = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${prod.orgId} and key = 'admin'`)).rows[0]!.id;
  await db.execute(sql`update app_roles set is_built_in = true where id = ${adminId}`);
  let roleId = adminId;
  if (kind === "delete_builtin") {
    roleId = (await db.execute<{ id: string }>(sql`insert into app_roles(org_id, key, name, is_built_in, permissions)
      values (${prod.orgId}, 'controller', 'Controller', true, '[]'::jsonb) returning id`)).rows[0]!.id;
  } else if (kind !== "update_admin") {
    await createScratchUser(prod.orgId, "Role holder", "protected_custom");
    roleId = (await db.execute<{ id: string }>(sql`select id from app_roles where org_id = ${prod.orgId} and key = 'protected_custom'`)).rows[0]!.id;
  }
  const sbxOrgId = randomUUID();
  const seed = randomUUID();
  const sandboxId = randomUUID();
  await db.execute(sql`insert into orgs(id, name, base_currency, country, settings, env_kind, sandbox_of, sandbox_seed)
    values (${sbxOrgId}, ${"Scratch " + sbxOrgId.slice(0, 8)}, 'CAD', 'CA', '{}'::jsonb, 'sandbox', ${prod.orgId}, ${seed})`);
  await db.execute(sql`insert into sandboxes(id, org_id, production_org_id, name, tier, masked, status)
    values (${sandboxId}, ${sbxOrgId}, ${prod.orgId}, 'Role promotion', 'full', false, 'ready')`);
  await db.execute(sql`insert into app_roles(id, org_id, key, name, description, is_built_in, permissions, subsidiary_restriction)
    select ob_rebase(id, ${seed}::uuid), ${sbxOrgId}, key, name, description, is_built_in, permissions, subsidiary_restriction
      from app_roles where org_id = ${prod.orgId}`);
  const sandboxRole = await rebase(roleId, seed);
  if (kind.startsWith("delete")) await db.execute(sql`delete from app_roles where org_id = ${sbxOrgId} and id = ${sandboxRole}`);
  else await db.execute(sql`update app_roles set name = 'Promoted role name' where org_id = ${sbxOrgId} and id = ${sandboxRole}`);
  const { changeSetId, itemCount } = await buildChangeSet(sandboxId, "Role promotion", actors[0]!);
  assert.equal(itemCount, 1);
  await reviewChangeSet(changeSetId, actors[1]!);
  await approveChangeSet(changeSetId, actors[2]!);
  return { orgId: prod.orgId, sbxOrgId, roleId, changeSetId, actorId: actors[3]! };
}

test("promotion updates assigned roles in place and rolls back configuration when audit storage fails", { skip: !DB }, async () => {
  const f = await rolePromotionFixture("update_assigned");
  const trigger = `promotion_audit_${randomUUID().replaceAll("-", "")}`;
  let installed = false;
  try {
    const snapshot = async () => ({
      roles: (await db.execute(sql`select * from app_roles where org_id = ${f.orgId} order by id`)).rows,
      assignments: (await db.execute(sql`select * from role_assignments where org_id = ${f.orgId} order by id`)).rows,
      audit: (await db.execute(sql`select * from audit_log where org_id = ${f.orgId} order by id`)).rows,
      changeSet: (await db.execute(sql`select * from change_sets where id = ${f.changeSetId}`)).rows,
    });
    const before = await snapshot();
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
      if NEW.org_id = '${f.orgId}'::uuid and NEW.table_name = 'app_roles' then raise exception 'promotion audit unavailable'; end if;
      return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${trigger} before insert on audit_log for each row execute function ${trigger}()`));
    installed = true;
    await assert.rejects(applyChangeSet(f.changeSetId, f.actorId));
    assert.deepEqual(await snapshot(), before);
    await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`)); installed = false;
    await applyChangeSet(f.changeSetId, f.actorId);
    const after = await snapshot();
    assert.deepEqual(after.assignments, before.assignments, "role updates preserve every assignment row");
    const roleBefore = before.roles.find((row) => row.id === f.roleId)!;
    const roleAfter = after.roles.find((row) => row.id === f.roleId)!;
    assert.equal(roleAfter.name, "Promoted role name");
    assert.equal(roleAfter.updated_by, f.actorId);
    assert.deepEqual(roleAfter.created_at, roleBefore.created_at);
    assert.equal(roleAfter.created_by, roleBefore.created_by);
    assert.equal(after.audit.length, before.audit.length + 1);
    assert.equal(after.changeSet[0]!.status, "applied");
  } finally {
    if (installed) await db.execute(sql.raw(`drop trigger ${trigger} on audit_log`));
    await db.execute(sql.raw(`drop function if exists ${trigger}()`));
    await dropScratchOrgReporting(f.sbxOrgId); await dropScratchOrgReporting(f.orgId);
  }
});

for (const kind of ["delete_assigned", "delete_builtin", "update_admin"] as const) {
  test(`promotion refuses ${kind} without changing production access`, { skip: !DB }, async () => {
    const f = await rolePromotionFixture(kind);
    try {
      const snapshot = async () => ({
        roles: (await db.execute(sql`select * from app_roles where org_id = ${f.orgId} order by id`)).rows,
        assignments: (await db.execute(sql`select * from role_assignments where org_id = ${f.orgId} order by id`)).rows,
        audit: (await db.execute(sql`select * from audit_log where org_id = ${f.orgId} order by id`)).rows,
      });
      const before = await snapshot();
      const pattern = kind === "delete_assigned" ? /assigned role cannot be deleted/ : kind === "delete_builtin" ? /built-in roles cannot be deleted/ : /Administrator role cannot be edited/;
      await assert.rejects(applyChangeSet(f.changeSetId, f.actorId), pattern);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await db.execute(sql`select status from change_sets where id = ${f.changeSetId}`)).rows[0]!.status, "approved");
    } finally { await dropScratchOrgReporting(f.sbxOrgId); await dropScratchOrgReporting(f.orgId); }
  });
}
