import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/test-fixtures.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory.ts";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { withSimClock } from "@openbooks/engine/src/clock.ts";

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

for (const scenario of ["receive date", "receive subsidiary", "transfer subsidiary", "voucher subsidiary", "adjust cost", "landed basis", "receipt lot"] as const) {
  test(`inventory API refuses malformed ${scenario} without substituting financial instructions`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      state.user = { orgId: org.orgId, id: actor };
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
      await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        quantity: "5", unitCost: "10", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
      const basic: Record<string, unknown> = { action: "receive", idempotencyKey: randomUUID(), itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date, quantity: "1", unitCost: "10", offsetAccountId: org.accounts.clearing };
      let advanced = false;
      let body = basic;
      if (scenario === "receive date") body.date = "not-a-date";
      if (scenario === "receive subsidiary") body.subsidiaryId = "not-an-entity";
      if (scenario === "adjust cost") { body.action = "adjust"; body.unitCost = "not-a-cost"; }
      if (scenario === "landed basis") { body.action = "landed"; body.basis = "not-an-allocation-policy"; }
      if (scenario === "receipt lot") body.lotId = "not-a-lot";
      if (scenario === "transfer subsidiary") {
        advanced = true;
        body = { action: "createTransfer", idempotencyKey: randomUUID(), subsidiaryId: "not-an-entity", orderedOn: org.date,
          fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2, lines: [{ itemId: org.items.fifo, quantity: "1" }] };
      }
      if (scenario === "voucher subsidiary") {
        advanced = true;
        body = { action: "postLandedVoucher", idempotencyKey: randomUUID(), subsidiaryId: "not-an-entity", voucherDate: org.date,
          amount: "1", basis: "value", freightAccountId: org.accounts.clearing, targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] };
      }
      const { POST } = advanced ? await import("../app/api/inventory/advanced/route") : await import("../app/api/inventory/actions/route");
      const before = (await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n;
      const response = await withSimClock(org.date, () => POST(new Request("http://audit.local/api/inventory", { method: "POST", body: JSON.stringify(body) })));
      assert.equal(response.status, 422, JSON.stringify(await response.json()));
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from inventory_movements where org_id=${org.orgId}`)).rows[0]!.n, before);
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from transfer_orders where org_id=${org.orgId}`)).rows[0]!.n, 0);
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from landed_cost_vouchers where org_id=${org.orgId}`)).rows[0]!.n, 0);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("valid inventory requests retain omission defaults and exact idempotent replay", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    state.user = { orgId: org.orgId, id: actor };
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true}'::jsonb) where id=${org.orgId}`);
    const { POST: basic } = await import("../app/api/inventory/actions/route");
    const { POST: advanced } = await import("../app/api/inventory/advanced/route");
    const requests = [
      { route: basic, status: 200, body: { action: "receive", idempotencyKey: randomUUID(), itemId: org.items.fifo,
        stockLocationId: org.stockLocationId, quantity: "5", unitCost: "10.1234", offsetAccountId: org.accounts.clearing } },
      { route: advanced, status: 201, body: { action: "createTransfer", idempotencyKey: randomUUID(),
        fromStockLocationId: org.stockLocationId, toStockLocationId: org.stockLocationId2, lines: [{ itemId: org.items.fifo, quantity: "1" }] } },
      { route: advanced, status: 201, body: { action: "postLandedVoucher", idempotencyKey: randomUUID(),
        amount: "2.5001", freightAccountId: org.accounts.clearing, targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }] } },
    ];
    for (const input of requests) {
      const request = () => new Request("http://audit.local/api/inventory", { method: "POST", body: JSON.stringify(input.body) });
      const first = await withSimClock(org.date, () => input.route(request()));
      const result = await first.json();
      assert.equal(first.status, input.status, JSON.stringify(result));
      assert.equal(result.replayed, false);
      const retry = await withSimClock(org.date, () => input.route(request()));
      const replay = await retry.json();
      assert.equal(retry.status, input.status, JSON.stringify(replay));
      assert.deepEqual(replay, { ...result, replayed: true });
    }
    const movements = (await db.execute<{ moved_on: string; subsidiary_id: string }>(sql`
      select moved_at::date::text as moved_on,subsidiary_id from inventory_movements where org_id=${org.orgId}`)).rows;
    assert.equal(movements.length, 1);
    assert.equal(movements[0]!.moved_on, await withSimClock(org.date, () => businessToday(org.orgId)));
    assert.equal(movements[0]!.subsidiary_id, org.subsidiaryId);
    assert.equal((await db.execute(sql`select entry_id from journal_lines where org_id=${org.orgId} group by entry_id having sum(amount)<>0`)).rows.length, 0);
  } finally { await dropScratchOrg(org.orgId); }
});
