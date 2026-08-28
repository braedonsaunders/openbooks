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

    // The scratch org's built-in role lives only in production, so the diff
    // must also flag it as a promotable-table delete (app_roles is on the
    // PROMOTABLE list).
    const adminRoleId = (await db.execute<{ id: string }>(sql`
      select id::text as id from app_roles where org_id = ${prod.orgId}`)).rows[0]!.id;

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

    // Production-only built-in role → delete from a THIRD promotable table.
    const roleDel = byKey.get(`app_roles:delete:${adminRoleId}`);
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
