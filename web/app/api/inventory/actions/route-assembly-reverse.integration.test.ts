import { approveFixtureRouting, createManufacturingOperator } from "@openbooks/engine/src/testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import type { SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "@openbooks/engine/src/testing/fixtures.ts";
import { receiveInventory } from "@openbooks/engine/src/inventory/movements.ts";
import { buildAssembly } from "@openbooks/engine/src/inventory/assembly.ts";
import { getOnHand } from "@openbooks/engine/src/inventory/position.ts";
import { issueMaterials } from "@openbooks/engine/src/manufacturing/materials.ts";
import { createRouting, createRoutingOperation } from "@openbooks/engine/src/manufacturing/routings.ts";
import { createWorkCenter } from "@openbooks/engine/src/manufacturing/work-centers.ts";
import { createWorkOrder, releaseWorkOrder } from "@openbooks/engine/src/manufacturing/work-orders.ts";

const state: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } = {
  user: { orgId: "", id: "" },
  allowedSubsidiaryIds: null,
};
Object.assign(globalThis, { __inventoryApiAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/inventory/")) {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
        "export async function guardPermission(){return {user:globalThis.__inventoryApiAudit.user,allowedSubsidiaryIds:globalThis.__inventoryApiAudit.allowedSubsidiaryIds}};export function can(){return true}",
      ) };
    }
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

function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  return withBypassContext(() => db.transaction(work));
}

test("API reverse of an assembly build restores stock, replays retries, and conflicts on key reuse", async () => {
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
    // A restricted caller cannot distinguish a hidden movement from an
    // absent id; the denial must happen before idempotency or reversal work.
    state.allowedSubsidiaryIds = new Set([randomUUID()]);
    const hidden = await reverse({ ...payload, idempotencyKey: `${key}-hidden` });
    const absent = await reverse({ ...payload, movementId: randomUUID(), idempotencyKey: `${key}-absent` });
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.json, absent.json);
    assert.deepEqual(absent.json, { error: "not_found" });
    state.allowedSubsidiaryIds = null;

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

test("API reverse of a work-order issue reverses every consume leg in the entry", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await withBypassContext(() => createManufacturingOperator(org.orgId, "Production operator"));
    state.user = { orgId: org.orgId, id: actor };
    state.allowedSubsidiaryIds = null;
    const wipId = randomUUID();
    await withBypassContext(async () => {
      const feature = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"inventory":true,"manufacturing":true,"warehousing":true}'::jsonb) where id=${org.orgId} returning id`);
      assert.equal(feature.rows.length, 1);
      const account = await db.execute(sql`insert into accounts (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
        values (${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
      assert.equal(account.rows.length, 1);
      const mapping = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts,mfgWip}',to_jsonb(${wipId}::text),true) where id=${org.orgId} returning id`);
      assert.equal(mapping.rows.length, 1);
      const open = await db.execute<{ id: string }>(sql`select id from accounting_periods where org_id=${org.orgId}
        and current_date between starts_on and ends_on and not is_adjustment limit 1`);
      if (open.rows.length === 0) {
        const period = await db.execute(sql`insert into accounting_periods
          (id,org_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,fiscal_calendar_id)
          select ${randomUUID()},${org.orgId},extract(year from current_date)::int,extract(month from current_date)::int,
            to_char(current_date,'YYYY-MM'),date_trunc('month',current_date)::date,
            (date_trunc('month',current_date)+interval '1 month - 1 day')::date,false,fiscal_calendar_id
            from accounting_periods where id=${org.periodId} returning id`);
        assert.equal(period.rows.length, 1);
      }
      const bom = await db.execute(sql`update bom_components set quantity_per='1',operation_seq=null
        where org_id=${org.orgId} and assembly_item_id=${org.items.assembly} and component_item_id=${org.items.component} returning id`);
      assert.equal(bom.rows.length, 1);
      const secondBom = await db.execute(sql`insert into bom_components (org_id,assembly_item_id,component_item_id,quantity_per,sort_order,is_byproduct)
        values (${org.orgId},${org.items.assembly},${org.items.fifo},'1',1,false) returning id`);
      assert.equal(secondBom.rows.length, 1);
      await receiveInventory(org.orgId, actor, { itemId: org.items.component, stockLocationId: org.stockLocationId,
        quantity: "3", unitCost: "2", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
      await receiveInventory(org.orgId, actor, { itemId: org.items.fifo, stockLocationId: org.stockLocationId,
        quantity: "3", unitCost: "1", subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date });
    });
    const center = await run((tx) => createWorkCenter(tx, org.orgId, actor, {
      code: `WC-${randomUUID()}`, name: "Assembly center", kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false,
    }));
    const routing = await run((tx) => createRouting(tx, org.orgId, actor, {
      producedItemId: org.items.assembly, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: "2026-01-01",
      defaultIssueLocationId: org.stockLocationId, defaultReceiptLocationId: org.stockLocationId2, overheadBasis: "units",
    }));
    await run((tx) => createRoutingOperation(tx, org.orgId, actor, String(routing.id), {
      sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "1",
    }));
    await run((tx) => approveFixtureRouting(tx, org.orgId, actor, String(routing.id)));
    const order = await run((tx) => createWorkOrder(tx, org.orgId, actor, {
      producedItemId: org.items.assembly, quantityOrdered: "1", subsidiaryId: org.subsidiaryId,
      issueLocationId: org.stockLocationId, receiptLocationId: org.stockLocationId2, plannedStart: org.date,
    }));
    await run((tx) => releaseWorkOrder(tx, org.orgId, actor, order.id));
    const postingDate = await withBypassContext(async () => (await db.execute<{ date: string }>(sql`select current_date::text date`)).rows[0]!.date);
    const materials = await withBypassContext(async () => (await db.execute<{ id: string; component_item_id: string }>(sql`select id,component_item_id from mfg_wo_materials
      where org_id=${org.orgId} and work_order_id=${order.id} order by component_item_id`)).rows);
    const issued = await run((tx) => issueMaterials(tx, org.orgId, actor, order.id,
      materials.map((material) => ({ materialId: material.id, quantity: "1" }))));
    assert.equal(issued.movementIds.length, 2);

    const result = await reverse({ action: "reverse", idempotencyKey: `work-order-reverse-${randomUUID()}`,
      movementId: issued.movementIds[0], date: postingDate, memo: "Correct the work-order issue" });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.alreadyReversed, false);
    assert.equal((result.json.movementIds as string[]).length, 2, "one movement leg must reverse the whole issue entry");
    const source = await withBypassContext(() => db.execute<{ status: string; origin: string; work_order_number: string }>(sql`select status,origin,custom->>'work_order_number' work_order_number
      from journal_entries where org_id=${org.orgId} and id=${issued.entryId}`));
    assert.deepEqual(source.rows[0], { status: "reversed", origin: "manufacturing", work_order_number: order.number });
    const counters = await withBypassContext(() => db.execute<{ issued: string; backflush: string }>(sql`select sum(issued_qty)::text issued,sum(backflush_qty)::text backflush
      from mfg_wo_materials where org_id=${org.orgId} and work_order_id=${order.id}`));
    assert.equal(counters.rows[0]?.issued, "0.0000");
    assert.equal(counters.rows[0]?.backflush, "0.0000");
    assert.equal((await getOnHand(org.orgId, org.items.component, org.stockLocationId)).quantity, "3.0000");
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity, "3.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
