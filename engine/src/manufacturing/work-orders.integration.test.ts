import { approveFixtureRouting, createManufacturingOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, type ScratchOrg } from "../testing/fixtures.ts";
import { AvailabilityRefusal } from "../inventory/availability.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { postManufacturingEntry } from "./journal.ts";
import { ManufacturingError } from "./errors.ts";
import { createWorkOrder, getWorkOrder, updateDraftWorkOrder, releaseWorkOrder, holdWorkOrder, resumeWorkOrder, startWorkOrder, cancelWorkOrder, startWorkOrderOperation, pauseWorkOrderOperation, resumeWorkOrderOperation } from "./work-orders.ts";
import { createWorkCenter } from "./work-centers.ts";
import { createNextRoutingVersion, createRouting, createRoutingOperation, updateRouting } from "./routings.ts";
import { updateManufacturingPolicies } from "./policies.ts";
import { upsertItemPolicy } from "./item-policies.ts";
import { createSandbox } from "../sandbox/lifecycle.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; departmentId: string };
type Case = { name: string; run: (fixture: Fixture) => Promise<void> };
const itemPolicy = { supplyMethod: "buy" as const, leadTimeDays: null, safetyStockQty: "0", minimumQty: "0", orderMultipleQty: "0", scrapPctPlanned: "0" };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }

async function withSandboxClone(f: Fixture, work: (orgId: string) => Promise<void>) {
  const clone = await withBypassContext(() => createSandbox({ productionOrgId: f.org.orgId, name: `Manufacturing ${randomUUID()}`, tier: "full", masked: false }));
  try {
    await work(clone.sandboxOrgId);
  } finally {
    assert.equal((await withBypassContext(() => db.execute(sql`update orgs set name='Scratch Manufacturing clone' where id=${clone.sandboxOrgId} and env_kind='sandbox' returning id`))).rows.length, 1);
    await dropScratchOrg(clone.sandboxOrgId);
  }
}

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createManufacturingOperator(org.orgId, "Shop lead"));
  const wipId = randomUUID();
  await withBypassContext(async () => {
    const account = await db.execute(sql`insert into accounts
      (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
      values(${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
    assert.equal(account.rows.length, 1, "child release requires a genuine manufacturing WIP account");
    const result = await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb),'{controlAccounts}',
      coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('mfgWip',${wipId}::text),true) where id=${org.orgId} returning id`);
    assert.equal(result.rows.length, 1);
  });
  // Releasing a work order snapshots its work centers' department rates.
  const departmentId = String((await withBypassContext(() => db.execute(sql`insert into departments (org_id, name) values (${org.orgId}, 'Assembly') returning id`))).rows[0]!.id);
  const rate = await withBypassContext(() => db.execute(sql`insert into labor_cost_rates
    (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId}) returning id`));
  assert.equal(rate.rows.length, 1, "material/lifecycle cases require an explicit standard labor rate covering release");
  return { org, actorId, departmentId };
}

async function route(f: Fixture, itemId: string, from = "2026-01-01", to: string | null = null) {
  const code = `WC-${randomUUID()}`;
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code, name: code, kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false, departmentId: f.departmentId,
  }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: itemId, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: from, effectiveTo: to,
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
  }));
  await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
    sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "5", runMinutesPerUnit: "1",
  }));
  await approveFixtureRouting(f.org.orgId, f.actorId, String(routing.id));
  return String(routing.id);
}

async function order(f: Fixture, producedItemId = f.org.items.assembly, plannedStart = f.org.date, quantityOrdered = "1") {
  return run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
    producedItemId, quantityOrdered, subsidiaryId: f.org.subsidiaryId,
    issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart,
  }));
}

async function refuse(work: Promise<unknown>, code: string, text: string) {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError
    && error.code === code && error.message.includes(text) && Boolean(error.remedy?.trim()), `${code} should name its remedy and affected record`);
}

const cases: Case[] = [
  { name: "draft create, edit, and cancel", run: async (f) => {
    const draft = await order(f); const edited = await run((tx) => updateDraftWorkOrder(tx, f.org.orgId, f.actorId, draft.id, { quantityOrdered: "2", plannedEnd: "2026-07-20" }));
    assert.equal(edited.quantityOrdered, "2.0000"); assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, draft.id))).status, "cancelled");
  } },
  { name: "routing selection names the item and effective versions", run: async (f) => {
    const first = await route(f, f.org.items.assembly, "2026-01-01", "2026-06-30");
    const next = await run((tx) => createNextRoutingVersion(tx, f.org.orgId, f.actorId, first));
    await run((tx) => updateRouting(tx, f.org.orgId, f.actorId, String(next.id), { effectiveFrom: "2026-08-01", effectiveTo: null }));
    await approveFixtureRouting(f.org.orgId, f.actorId, String(next.id));
    await route(f, f.org.items.standard);
    const draft = await order(f, f.org.items.assembly, "2026-07-15");
    await refuse(run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "routing_not_effective", "Assembly");
  } },
  { name: "missing inventory profile passes through availability refusal", run: async (f) => {
    await route(f, f.org.items.assembly);
    await withBypassContext(async () => db.execute(sql`insert into bom_components (org_id, assembly_item_id, component_item_id, quantity_per, sort_order) values (${f.org.orgId}, ${f.org.items.assembly}, ${f.org.items.service}, '1', 2) returning id`));
    const draft = await order(f);
    await assert.rejects(run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), (error: unknown) => error instanceof AvailabilityRefusal && error.code === "item_not_stocked" && /Inventory costing/.test(error.remedy));
  } },
  { name: "component account mapping names the component", run: async (f) => {
    await route(f, f.org.items.assembly);
    await withBypassContext(async () => {
      const changed = await db.execute(sql`update item_inventory_profiles set asset_account_id=${f.org.accounts.cogs} where org_id=${f.org.orgId} and item_id=${f.org.items.component} returning item_id`);
      assert.equal(changed.rows.length, 1);
    });
    const draft = await order(f);
    await refuse(run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "component_asset_account_missing", "Component");
  } },
  { name: "warn shortages, then refuse against another released reservation", run: async (f) => {
    await route(f, f.org.items.assembly);
    await receiveInventory(f.org.orgId, f.actorId, { itemId: f.org.items.component, stockLocationId: f.org.stockLocationId, quantity: "2.5", unitCost: "1", subsidiaryId: f.org.subsidiaryId, date: f.org.date, offsetAccountId: f.org.accounts.clearing });
    await run((tx) => updateManufacturingPolicies(tx, f.org.orgId, f.actorId, { shortagePolicy: "warn", completionTolerancePct: "1", abnormalScrapApprovalThreshold: null }));
    const first = await order(f, f.org.items.assembly, f.org.date, "1.5"); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, first.id));
    const firstLine = await withBypassContext(async () => db.execute<{ shortage_qty: string }>(sql`select shortage_qty::text from mfg_wo_materials where org_id=${f.org.orgId} and work_order_id=${first.id}`));
    assert.equal(firstLine.rows[0]?.shortage_qty, "0.5000");
    await run((tx) => updateManufacturingPolicies(tx, f.org.orgId, f.actorId, { shortagePolicy: "refuse", completionTolerancePct: "1", abnormalScrapApprovalThreshold: null }));
    const second = await order(f, f.org.items.assembly, f.org.date, "0.5");
    await refuse(run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, second.id)), "work_order_shortage", "Component: 1");
  } },
  { name: "make subassembly creates and releases a child", run: async (f) => {
    await route(f, f.org.items.assembly);
    await run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, itemPolicy));
    await withBypassContext(async () => db.execute(sql`insert into bom_components (org_id, assembly_item_id, component_item_id, quantity_per, sort_order) values (${f.org.orgId}, ${f.org.items.component}, ${f.org.items.standard}, '1', 0) returning id`));
    await route(f, f.org.items.component);
    await run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...itemPolicy, supplyMethod: "make" }));
    const parent = await order(f); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, parent.id));
    const children = await withBypassContext(async () => db.execute<{ status: string; source: string; parent_wo_id: string }>(sql`select status,source,parent_wo_id from mfg_work_orders where org_id=${f.org.orgId} and parent_wo_id=${parent.id}`));
    assert.deepEqual(children.rows, [{ status: "released", source: "parent", parent_wo_id: parent.id }]);
    await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, parent.id, "Stop production"));
    const cancelled = await withBypassContext(async () => db.execute<{ status: string }>(sql`select status from mfg_work_orders where org_id=${f.org.orgId} and parent_wo_id=${parent.id}`));
    assert.equal(cancelled.rows[0]?.status, "cancelled");
  } },
  { name: "hold blocks work-order start", run: async (f) => {
    await route(f, f.org.items.assembly); const draft = await order(f); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    await refuse(run((tx) => updateDraftWorkOrder(tx, f.org.orgId, f.actorId, draft.id, { quantityOrdered: "2" })), "work_order_not_draft", "cannot be edited");
    await refuse(run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, draft.id, " ")), "hold_reason_required", "required");
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, draft.id, "Quality review"));
    await refuse(run((tx) => startWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "work_order_on_hold", "Quality review");
    const operation = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${draft.id}`)).rows[0]!);
    await refuse(run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id)), "work_order_on_hold", "Quality review");
    await refuse(run((tx) => pauseWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id, "Tool change")), "work_order_on_hold", "Quality review");
    await refuse(run((tx) => resumeWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id)), "work_order_on_hold", "Quality review");
    await withSandboxClone(f, async (orgId) => {
      const cloneOrder = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from mfg_work_orders where org_id=${orgId} and number=${draft.number}`)).rows[0]!.id);
      assert.equal((await run((tx) => resumeWorkOrder(tx, orgId, f.actorId, cloneOrder))).status, "released");
    });
    assert.equal((await run((tx) => resumeWorkOrder(tx, f.org.orgId, f.actorId, draft.id))).status, "released");
    await run((tx) => holdWorkOrder(tx, f.org.orgId, f.actorId, draft.id, "End of run"));
    await refuse(run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "cancel_reason_required", "requires a reason");
    assert.equal((await run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, draft.id, "Stop after hold"))).status, "cancelled");
  } },
  { name: "configured release flow cannot be bypassed at the service", run: async (f) => {
    await route(f, f.org.items.assembly); const draft = await order(f);
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, {
      subjectKind: "work_order", assignees: [{ type: "user", userId: f.actorId }], mode: "any",
    }));
    await refuse(run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "work_order_approval_required", "configured work-order flow");
  } },
  { name: "parent cancellation refuses a started child by number", run: async (f) => {
    await route(f, f.org.items.assembly);
    await run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...itemPolicy, supplyMethod: "make" }));
    await withBypassContext(async () => db.execute(sql`insert into bom_components (org_id, assembly_item_id, component_item_id, quantity_per, sort_order) values (${f.org.orgId}, ${f.org.items.component}, ${f.org.items.standard}, '1', 0) returning id`));
    await route(f, f.org.items.component);
    const parent = await order(f); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, parent.id));
    const child = await withBypassContext(async () => (await db.execute<{ id: string; number: string }>(sql`select id,number from mfg_work_orders where org_id=${f.org.orgId} and parent_wo_id=${parent.id}`)).rows[0]!);
    await run((tx) => startWorkOrder(tx, f.org.orgId, f.actorId, child.id));
    await refuse(run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, parent.id, "Stop parent")), "started_child_work_orders", child.number);
  } },
  { name: "cancel refuses a posted manufacturing entry by number", run: async (f) => {
    await route(f, f.org.items.assembly); const draft = await order(f); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    await refuse(run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, draft.id)), "cancel_reason_required", "requires a reason");
    const entryNumber = `MFG-${randomUUID()}`;
    await run((tx) => postManufacturingEntry(tx, { orgId: f.org.orgId, bookId: f.org.bookId, subsidiaryId: f.org.subsidiaryId, actorId: f.actorId, currency: "CAD", periodId: f.org.periodId, date: f.org.date, entryNumber, memo: "Production cost", lines: [{ accountId: f.org.accounts.invAsset, amount: "10" }, { accountId: f.org.accounts.cogs, amount: "-10" }], custom: { workOrderNumber: draft.number, bomRevision: "test-revision", routingVersion: "1" } }));
    await refuse(run((tx) => cancelWorkOrder(tx, f.org.orgId, f.actorId, draft.id, "Cancel")), "work_order_has_postings", entryNumber);
  } },
  { name: "release, start, and operation start pause resume", run: async (f) => {
    await route(f, f.org.items.assembly);
    const profile = await withBypassContext(async () => db.execute(sql`update item_inventory_profiles set costing_method='standard', standard_cost='12.34' where org_id=${f.org.orgId} and item_id=${f.org.items.assembly} returning item_id`));
    assert.equal(profile.rows.length, 1);
    const draft = await order(f); await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    const frozen = await run((tx) => getWorkOrder(tx, f.org.orgId, draft.id));
    assert.equal(frozen?.routingVersion, 1); assert.match(frozen?.bomRevision ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(frozen?.standardCostSnapshot, "12.3400");
    await run((tx) => startWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    const operation = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`select id from mfg_wo_operations where org_id=${f.org.orgId} and work_order_id=${draft.id}`)).rows[0]!);
    await run((tx) => startWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id));
    await refuse(run((tx) => pauseWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id, " ")), "pause_reason_required", "reason");
    await run((tx) => pauseWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id, "Tool change"));
    const resumed = await run((tx) => resumeWorkOrderOperation(tx, f.org.orgId, f.actorId, draft.id, operation.id));
    assert.equal(resumed.status, "running"); assert.equal(resumed.pause_reason, null);
  } },
  {name:"lifecycle commands and their successful replays refuse revoked authority without changing orders or operations",run:async f=>{
    await route(f,f.org.items.assembly);
    const draft=await order(f);
    const cancelled=await order(f);await run(tx=>cancelWorkOrder(tx,f.org.orgId,f.actorId,cancelled.id));
    const active=await order(f);await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,active.id));
    const operation=(await run(tx=>getWorkOrder(tx,f.org.orgId,active.id)))!.operations[0]!;
    await run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id));
    await run(tx=>pauseWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id,"Material staging"));
    await run(tx=>resumeWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id));
    const held=await order(f);await run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,held.id));await run(tx=>holdWorkOrder(tx,f.org.orgId,f.actorId,held.id,"Awaiting components"));
    const state=()=>run(async tx=>(await tx.execute(sql`select
      (select jsonb_agg(to_jsonb(w) order by id) from mfg_work_orders w where org_id=${f.org.orgId}) as orders,
      (select jsonb_agg(to_jsonb(o) order by id) from mfg_wo_operations o where org_id=${f.org.orgId}) as operations,
      (select count(*)::text from journal_entries where org_id=${f.org.orgId}) as entries,
      (select count(*)::text from audit_log where org_id=${f.org.orgId}) as audits`)).rows[0]);
    const before=await state();
    await run(async tx=>assert.ok((await tx.execute(sql`update app_roles set permissions='["manufacturing.read","items.post"]'::jsonb
      where org_id=${f.org.orgId} and id in(select role_id from role_assignments where org_id=${f.org.orgId} and user_id=${f.actorId}) returning id`)).rows.length));
    for(const command of [
      ()=>run(tx=>updateDraftWorkOrder(tx,f.org.orgId,f.actorId,draft.id,{quantityOrdered:"2"})),
      ()=>run(tx=>releaseWorkOrder(tx,f.org.orgId,f.actorId,draft.id)),
      ()=>run(tx=>cancelWorkOrder(tx,f.org.orgId,f.actorId,cancelled.id)),
      ()=>run(tx=>cancelWorkOrder(tx,f.org.orgId,f.actorId,draft.id)),
      ()=>run(tx=>holdWorkOrder(tx,f.org.orgId,f.actorId,held.id,"Awaiting components")),
      ()=>run(tx=>resumeWorkOrder(tx,f.org.orgId,f.actorId,held.id)),
      ()=>run(tx=>resumeWorkOrder(tx,f.org.orgId,f.actorId,active.id)),
      ()=>run(tx=>startWorkOrder(tx,f.org.orgId,f.actorId,active.id)),
      ()=>run(tx=>startWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id)),
      ()=>run(tx=>pauseWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id,"Awaiting tool")),
      ()=>run(tx=>resumeWorkOrderOperation(tx,f.org.orgId,f.actorId,active.id,operation.id)),
      ()=>run(tx=>holdWorkOrder(tx,f.org.orgId,randomUUID(),active.id,"Unknown actor")),
    ]) await assert.rejects(command());
    assert.deepEqual(await state(),before);
  }},

];

test("work-order lifecycle case table", { skip: !DB }, async () => {
  for (const scenario of cases) {
    const fixture = await setup();
    try { await scenario.run(fixture); }
    catch (error) { throw new Error(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    finally { await dropScratchOrg(fixture.org.orgId); }
  }
});
