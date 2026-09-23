import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { buildAssembly } from "@openbooks/engine/src/inventory/assembly.ts";
import { getOnHand } from "@openbooks/engine/src/inventory/position.ts";

const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __inventoryApiAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__inventoryApiAudit.user,allowedSubsidiaryIds:null}}",
      ) };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});

/**
 * IN2: action="reverse" on an assembly_build movement must reach
 * reverseAssemblyBuild through the API — stock and GL restored exactly,
 * same-key retries replaying, changed payloads conflicting.
 */

async function reverse(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import("./route");
  const response = await POST(new Request("http://audit.local/api/inventory/actions", {
    method: "POST",
    body: JSON.stringify(body),
  }));
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("API reverse of an assembly build restores stock, replays retries, and conflicts on key reuse", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.component, stockLocationId: org.stockLocationId,
      quantity: "10", unitCost: "1", subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const built = await buildAssembly(org.orgId, actor, {
      assemblyItemId: org.items.assembly, quantity: "2",
      stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date,
    });

    const key = `assembly-reverse-${randomUUID()}`;
    const payload = {
      action: "reverse", idempotencyKey: key, movementId: built.movementId,
      date: org.date, memo: "built the wrong quantity, unwinding",
    };
    const first = await reverse(payload);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(first.json.ok, true);
    assert.equal(first.json.replayed, false);
    assert.equal(first.json.alreadyReversed, false);

    assert.equal(
      (await getOnHand(org.orgId, org.items.component, org.stockLocationId)).quantity,
      "10.0000",
      "component stock must be restored exactly",
    );
    assert.equal(
      (await getOnHand(org.orgId, org.items.assembly, org.stockLocationId)).quantity,
      "0.0000",
      "finished stock must be removed exactly",
    );
    const nets = (await db.execute<{ net: string }>(sql`
      select sum(amount)::text as net from journal_lines
       where org_id = ${org.orgId} and entry_id in (${built.entryId}::uuid, ${(first.json.entryId as string)}::uuid)`)).rows[0]!.net;
    assert.equal(nets, "0.0000", "build and reversal journals must net to zero");

    const movementsAfter = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n;
    const replay = await reverse(payload);
    assert.equal(replay.status, 200, JSON.stringify(replay.json));
    assert.equal(replay.json.replayed, true, "same key + payload must replay, never double-reverse");
    assert.deepEqual(replay.json.movementIds, first.json.movementIds);
    assert.equal(
      (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from inventory_movements where org_id = ${org.orgId}`)).rows[0]!.n,
      movementsAfter,
      "the replay must write no second reversal",
    );

    const conflict = await reverse({ ...payload, memo: "a different reason entirely" });
    assert.equal(conflict.status, 409, "key reuse with different input must conflict");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
