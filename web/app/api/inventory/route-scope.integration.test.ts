import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";

/**
 * Inventory writes lock the count / transfer order / voucher row and recheck
 * the caller scope inside the write transaction (the service joins that
 * transaction, so the lock covers its whole unit, including retries): an
 * unlocked route precheck can authorize an A record while a concurrent A→B
 * reassignment lands before the service commits, which would let a
 * restricted items.post actor mutate another entity's count, transfer, or
 * voucher.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" }, scope: null as Set<string> | null };
Object.assign(globalThis, { __inventoryScopeAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__inventoryScopeAudit.user,allowedSubsidiaryIds:globalThis.__inventoryScopeAudit.scope}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { POST: countsPost } = await import("./counts/route");
const { POST: advancedPost } = await import("./advanced/route");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await createScratchOrg();
  const actor = (await seedFlowActors(org.orgId)).adminId;
  state.user = { orgId: org.orgId, id: actor };
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
  const hidden = randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values (${hidden},${org.orgId},${org.subsidiaryId},'Hidden entity','CAD','CA')`);
  await db.execute(sql`insert into stock_locations(id,org_id,location_id,code,kind,is_active) values (${randomUUID()},${org.orgId},${org.locationId},'TRANSIT-SCOPE','transit',true)`);
  const { receiveInventory } = await import("@openbooks/engine/src/inventory/movements.ts");
  await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "10", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
  return { org, actor, hidden };
}

async function seedCount(orgId: string, actor: string, subsidiaryId: string, locationId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into stock_counts (id, org_id, location_id, subsidiary_id, counted_on, status, created_by, updated_by)
    values (${id}, ${orgId}, ${locationId}, ${subsidiaryId}, '2026-07-15', 'draft', ${actor}, ${actor})`);
  return id;
}

async function countStatus(orgId: string, countId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from stock_counts where org_id=${orgId} and id=${countId}`)).rows[0]!.status;
}

const countsCall = (body: unknown) =>
  countsPost(new Request("http://audit.local/api/inventory/counts", { method: "POST", body: JSON.stringify(body) }));

const advancedCall = (body: unknown) =>
  advancedPost(new Request("http://audit.local/api/inventory/advanced", { method: "POST", body: JSON.stringify(body) }));

test("count writes refuse an out-of-scope count and leave it untouched", { skip: !DB }, async () => {
  const { org, actor, hidden } = await fixture();
  try {
    state.scope = new Set([org.subsidiaryId]);
    const countA = await seedCount(org.orgId, actor, org.subsidiaryId, org.locationId);
    const countB = await seedCount(org.orgId, actor, hidden, org.locationId);
    const refused = await countsCall({ action: "cancel", countId: countB, idempotencyKey: randomUUID() });
    assert.equal(refused.status, 403, JSON.stringify(await refused.clone().json()));
    assert.equal(await countStatus(org.orgId, countB), "draft", "a refused cancel leaves the count untouched");
    const accepted = await countsCall({ action: "cancel", countId: countA, idempotencyKey: randomUUID() });
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
    assert.equal(await countStatus(org.orgId, countA), "cancelled");
  } finally {
    state.scope = null;
    await dropScratchOrg(org.orgId);
  }
});

test("count cancel waits on a count reassignment in flight instead of racing it", { skip: !DB }, async () => {
  const { org, actor, hidden } = await fixture();
  const writer = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    state.scope = new Set([org.subsidiaryId]);
    const moving = await seedCount(org.orgId, actor, org.subsidiaryId, org.locationId);
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true), set_config('statement_timeout','10000',true)");
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    await writer.query("update stock_counts set subsidiary_id=$1 where id=$2", [hidden, moving]);
    pending = countsCall({ action: "cancel", countId: moving, idempotencyKey: randomUUID() });
    let blocked = false;
    for (let n = 0; n < 200; n++) {
      blocked = !!((await pool.query("select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))", [pid])).rowCount);
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "the cancel waits on the locked count instead of mutating the pre-reassignment row");
    await writer.query("commit");
    const response = await pending;
    assert.equal(response.status, 403, JSON.stringify(await response.clone().json()));
    assert.equal(await countStatus(org.orgId, moving), "draft", "the cancel refused after the reassignment leaves the count draft");
  } finally {
    await writer.query("rollback").catch(() => {});
    await pending?.catch(() => {});
    writer.release();
    state.scope = null;
    await dropScratchOrg(org.orgId);
  }
});

test("transfer ship refuses an out-of-scope order and leaves it draft", { skip: !DB }, async () => {
  const { org, actor, hidden } = await fixture();
  try {
    const seedOrder = async (subsidiaryId: string) => {
      const id = randomUUID();
      await db.execute(sql`
        insert into transfer_orders
          (id, org_id, document_number, status, from_stock_location_id, to_stock_location_id,
           subsidiary_id, ordered_on, created_by, updated_by)
        values (${id}, ${org.orgId}, ${`TO-${randomUUID().slice(0, 8)}`}, 'draft',
                ${org.stockLocationId}, ${org.stockLocationId2}, ${subsidiaryId}, ${org.date}, ${actor}, ${actor})`);
      await db.execute(sql`
        insert into transfer_order_lines
          (org_id, transfer_order_id, line_number, item_id, quantity, created_by, updated_by)
        values (${org.orgId}, ${id}, 1, ${org.items.fifo}, '2', ${actor}, ${actor})`);
      return id;
    };
    state.scope = null;
    const orderB = await seedOrder(hidden);
    state.scope = new Set([org.subsidiaryId]);
    const refused = await advancedCall({ action: "shipTransfer", id: orderB, date: org.date, idempotencyKey: randomUUID() });
    assert.equal(refused.status, 403, JSON.stringify(await refused.clone().json()));
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from transfer_orders where id=${orderB}`)).rows[0]!.status,
      "draft",
      "a refused ship leaves the order draft",
    );
    const orderA = await seedOrder(org.subsidiaryId);
    const accepted = await advancedCall({ action: "shipTransfer", id: orderA, date: org.date, idempotencyKey: randomUUID() });
    assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from transfer_orders where id=${orderA}`)).rows[0]!.status,
      "in_transit",
    );
  } finally {
    state.scope = null;
    await dropScratchOrg(org.orgId);
  }
});
