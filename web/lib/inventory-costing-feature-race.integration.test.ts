import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.costing-feature-race")] = state;
registerHooks({ resolve(specifier, context, next) {
  const parent = decodeURIComponent(context.parentURL ?? "");
  const virtual = (source: string) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
  if (specifier === "server-only") return virtual("export {}");
  if (specifier.endsWith("/lib/feature-gates") && parent.endsWith("/costing/route.ts")) return virtual(
    "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.costing-feature-race')].gate}");
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@openbooks/engine/src/db.ts");
const { documentRevisionSql } = await import("@openbooks/engine/src/document-revision.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/test-fixtures.ts");
const { PUT } = await import("../app/api/items/[id]/costing/route");

test("costing profile write rechecks Inventory after a concurrent disable", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<Awaited<ReturnType<typeof PUT>>> | undefined;
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    state.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(["items.manage"]), allowedSubsidiaryIds: null } as Authz;
    const revision = (await db.execute<{ revision: string }>(sql`select ${documentRevisionSql(sql`updated_at`)} as revision
      from item_inventory_profiles where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows[0]!.revision;
    const evidence = async () => (await db.execute(sql`select to_jsonb(p) as profile,
      (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='item_inventory_profiles') as audits
      from item_inventory_profiles p where org_id=${org.orgId} and item_id=${org.items.fifo}`)).rows;
    const before = await evidence();
    const request = () => PUT(new Request("http://localhost/api/items/" + org.items.fifo + "/costing", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({
        costingMethod: "fifo", tracking: "none", expectedUpdatedAt: revision,
        assetAccountId: org.accounts.invAsset, cogsAccountId: org.accounts.cogs,
        adjustmentAccountId: org.accounts.adjustment, reorderPoint: "3",
      }),
    }), { params: Promise.resolve({ id: org.items.fifo }) });
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{\"inventory\":false}'::jsonb) where id=$1", [org.orgId]);
    await writer.query("select id from items where org_id=$1 and id=$2 for update", [org.orgId, org.items.fifo]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = request();
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const row = (await pool.query<{ blocked: boolean }>("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked", [pid])).rows[0]!;
      if (row.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "profile write must wait for the in-flight policy change");
    await writer.query("commit");
    const response = await pending;
    assert.equal(response.status, 422, JSON.stringify(await response.json()));
    assert.deepEqual(await evidence(), before);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','true'::jsonb) where id=${org.orgId}`);
    const allowed = await request();
    assert.equal(allowed.status, 200, JSON.stringify(await allowed.json()));
  } finally {
    await writer.query("rollback"); writer.release(); await pending;
    state.gate = null; await dropScratchOrg(org.orgId);
  }
});
