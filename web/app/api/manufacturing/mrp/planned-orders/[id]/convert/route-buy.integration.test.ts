import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

const stateKey = Symbol.for("openbooks.mrp-buy-route-test");
const state: { gate: { user: { id: string; orgId: string }; permissions: Set<string>; allowedSubsidiaryIds: null } | null } = { gate: null };
Object.assign(globalThis, { [stateKey]: state });
const gates = `const s=globalThis[Symbol.for("openbooks.mrp-buy-route-test")]; export async function guardFeaturePermission(){return s.gate ?? new Response(null,{status:401})}`;
const authz = `export function guardSubsidiaryScope(){return null}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "@/lib/feature-gates" || (specifier === "../../../lib/feature-gates" && context.parentURL?.includes("/_order/handlers"))) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(gates)}` };
  if (specifier === "@/lib/authz" && context.parentURL?.includes("/convert/route")) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(authz)}` };
  return next(specifier, context);
} });
const routeSpecifier: string = "./route.ts?mrp-buy-route-test";
const { POST } = await import(routeSpecifier) as typeof import("./route.ts");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { runMrp, confirmPlannedOrder } = await import("@openbooks/engine/src/manufacturing/mrp.ts");
const { upsertItemPolicy } = await import("@openbooks/engine/src/manufacturing/item-policies.ts");
const { businessToday } = await import("@openbooks/engine/src/platform/business-date.ts");
const tx = <T>(work: (runner: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => withBypassContext(() => db.transaction(work));
const plus = (day: string, count: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10); };

test("buy suggestions create one vendor purchase draft and preserve conversion refusals", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "MRP buyer", "admin"));
  state.gate = { user: { id: actorId, orgId: org.orgId }, permissions: new Set(["manufacturing.manage", "ap.create"]), allowedSubsidiaryIds: null };
  try {
    await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true,"manufacturingMrp":true,"orders":true}'::jsonb) where id=${org.orgId}`));
    const due = plus(await businessToday(org.orgId), 30);
    for (const itemId of [org.items.assembly, org.items.standard]) {
      await tx((runner) => upsertItemPolicy(runner, org.orgId, actorId, itemId, { supplyMethod: "buy", leadTimeDays: 3, safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", scrapPctPlanned: "0" }));
      await withBypassContext(async () => {
        const documentId = randomUUID();
        await db.execute(sql`insert into documents (id,org_id,kind,document_number,party_id,subsidiary_id,document_date,due_date,currency,status,subtotal,tax_total,total,created_by,updated_by) values (${documentId},${org.orgId},'sales_order',${`SO-${documentId.slice(0, 8)}`},${org.customerId},${org.subsidiaryId},${org.date},${due},'CAD','draft','1','0','1',${actorId},${actorId})`);
        await db.execute(sql`insert into document_lines (org_id,document_id,line_number,account_id,item_id,quantity,unit_price,amount,tax_input_amount,tax_amount,created_by,updated_by) values (${org.orgId},${documentId},1,${org.accounts.revenue},${itemId},'1','1','1','1','0',${actorId},${actorId})`);
        await db.execute(sql`update documents set status='approved',updated_at=now() where org_id=${org.orgId} and id=${documentId}`);
      });
    }
    const first = await tx((runner) => runMrp(runner, org.orgId, actorId, { subsidiaryId: org.subsidiaryId, horizonDays: 60, capacityCheck: false }));
    const plans = await withBypassContext(async () => (await db.execute<{ id: string; item_id: string; quantity: string; due_date: string }>(sql`select id,item_id,quantity::text,due_date::text from mfg_planned_orders where org_id=${org.orgId} and run_id=${first.id} order by item_id`)).rows);
    assert.equal(plans.length, 2);
    await tx(async (runner) => { for (const plan of plans) await confirmPlannedOrder(runner, org.orgId, actorId, plan.id); });
    const call = (id: string, body: object) => POST(new Request("http://openbooks.test/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
    const missingVendor = await call(plans[0]!.id, {});
    assert.equal(missingVendor.status, 400);
    assert.equal((await missingVendor.json() as { code: string }).code, "mrp_vendor_required");
    const converted = await call(plans[0]!.id, { vendorId: org.vendorId });
    assert.equal(converted.status, 201, JSON.stringify(await converted.clone().json()));
    const result = await converted.json() as { id: string };
    const { doc, line, itemName, baseUnit } = await withBypassContext(async () => ({
      doc: (await db.execute<{ party_id: string; due_date: string }>(sql`select party_id,due_date::text from documents where org_id=${org.orgId} and id=${result.id} and kind='purchase_order'`)).rows[0]!,
      line: (await db.execute<{ item_id: string; quantity: string; unit: string; description: string; quantity_matches: boolean }>(sql`select l.item_id,l.quantity::text,l.unit,l.description,l.quantity=p.quantity as quantity_matches from document_lines l join mfg_planned_orders p on p.org_id=l.org_id and p.converted_ref_id=l.document_id where l.org_id=${org.orgId} and l.document_id=${result.id}`)).rows[0]!,
      itemName: (await db.execute<{ name: string }>(sql`select name from items where org_id=${org.orgId} and id=${plans[0]!.item_id}`)).rows[0]!.name,
      baseUnit: (await db.execute<{ base_unit: string }>(sql`select base_unit from item_inventory_profiles where org_id=${org.orgId} and item_id=${plans[0]!.item_id}`)).rows[0]!.base_unit,
    }));
    assert.equal(doc.party_id, org.vendorId); assert.equal(doc.due_date, plans[0]!.due_date); assert.equal(line.item_id, plans[0]!.item_id); assert.equal(line.quantity_matches, true); assert.equal(line.unit, baseUnit);
    assert.equal(line.description, `${itemName} for MRP run ${first.number}`);
    const replay = await call(plans[0]!.id, {}); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { id: result.id, action: "buy", replayed: true });
    await tx((runner) => runMrp(runner, org.orgId, actorId, { subsidiaryId: org.subsidiaryId, horizonDays: 60, capacityCheck: false }));
    const superseded = await call(plans[1]!.id, { vendorId: org.vendorId });
    assert.equal(superseded.status, 409); assert.equal((await superseded.json() as { code: string }).code, "mrp_run_superseded");
    assert.equal(await withBypassContext(async () => (await db.execute<{ count: string }>(sql`select count(*)::text as count from documents where org_id=${org.orgId} and kind='purchase_order'`)).rows[0]?.count), "1");
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
    hooks.deregister();
  }
});
