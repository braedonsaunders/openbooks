import { createManufacturingOperator, createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, type SqlExecutor } from "../platform/db.ts";
import { ManufacturingError } from "./errors.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, type ScratchOrg } from "../testing/fixtures.ts";
import { submitFinancialChange, FinancialChangeSubmitError } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { MANUFACTURING_BOM_APPROVAL_OPERATION, proposeFinancialChange } from "../platform/financial-changes.ts";
import { createWorkCenter } from "./work-centers.ts";
import { activateRouting, activateRoutingDirect, createNextRoutingVersion, createRouting, createRoutingOperation, proposeRoutingActivation, routingDirectApplyAllowed, updateRouting } from "./routings.ts";
import { createWorkOrder, releaseWorkOrder } from "./work-orders.ts";
import { manufacturingOptions } from "./workspace.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string; departmentId: string };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createManufacturingOperator(org.orgId, "Shop lead"));
  const wipId = randomUUID();
  await withBypassContext(async () => {
    const account = await db.execute(sql`insert into accounts
      (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
      values(${wipId},${org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true) returning id`);
    assert.equal(account.rows.length, 1);
    const result = await db.execute(sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb),'{controlAccounts}',
      coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('mfgWip',${wipId}::text),true) where id=${org.orgId} returning id`);
    assert.equal(result.rows.length, 1);
  });
  const departmentId = String((await withBypassContext(() => db.execute(sql`insert into departments (org_id, name) values (${org.orgId}, 'Assembly') returning id`))).rows[0]!.id);
  const rate = await withBypassContext(() => db.execute(sql`insert into labor_cost_rates
    (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
    values (${org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2026-01-01', true, ${actorId}, ${actorId}) returning id`));
  assert.equal(rate.rows.length, 1);
  return { org, actorId, departmentId };
}

async function draftRouting(f: Fixture, itemId: string, from = "2026-01-01", withOperation = true) {
  const code = `WC-${randomUUID()}`;
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code, name: code, kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false, departmentId: f.departmentId,
  }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: itemId, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: from,
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
  }));
  if (withOperation) {
    await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
      sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "5", runMinutesPerUnit: "1",
    }));
  }
  return String(routing.id);
}

function direct(f: Fixture, routingId: string, reason = "Activate the configured production revision") {
  return run((tx) => activateRoutingDirect(tx, f.org.orgId, f.actorId, routingId, {
    subsidiaryId: f.org.subsidiaryId, reason, idempotencyKey: randomUUID(),
  }));
}

async function rejected(work: Promise<unknown>, code: string, phrase?: string, caseName = "") {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError
    && error.code === code && (!phrase || error.message.includes(phrase) || error.remedy?.includes(phrase))
    && Boolean(error.remedy?.trim()), caseName);
}

test("routing no-flow activation then work-order selection", { skip: !DB }, async () => {
  const f = await setup();
  try {
    assert.equal(await run((tx) => routingDirectApplyAllowed(tx, f.org.orgId)), true);
    const routingId = await draftRouting(f, f.org.items.assembly);
    const before = await run((tx) => manufacturingOptions(tx, f.org.orgId, null));
    assert.equal(before.routings.some((row) => row.value === routingId), false);
    const after = await direct(f, routingId);
    assert.equal(after.status, "active");
    const change = await withBypassContext(async () => (await db.execute<{ status: string; submitted_by: string; approved_by: string; payload: unknown; result: unknown }>(sql`select status, submitted_by, approved_by, payload, result from financial_changes where org_id=${f.org.orgId} and subject_id=${routingId} and operation='routing_revision_activation'`)).rows[0]);
    assert.equal(change?.status, "applied");
    assert.equal(change?.approved_by, f.actorId);
    assert.equal(change?.submitted_by, f.actorId);
    const decision = (change?.payload as { decision?: { mode?: unknown; policy?: { flowConfigured?: unknown } } }).decision;
    assert.equal(decision?.mode, "automatic");
    assert.equal(decision?.policy?.flowConfigured, false);
    const options = await run((tx) => manufacturingOptions(tx, f.org.orgId, null));
    assert.equal(options.routings.some((row) => row.value === routingId && row.parentId === f.org.items.assembly), true);
    const draft = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
      producedItemId: f.org.items.assembly, routingId, quantityOrdered: "1", subsidiaryId: f.org.subsidiaryId,
      issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: f.org.date,
    }));
    const released = await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    assert.equal(released.status, "released");
    assert.equal(released.routingId, routingId);
    assert.equal(released.routingVersion, 1);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("routing no-flow activation supersedes the prior revision", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const first = await draftRouting(f, f.org.items.assembly, "2026-01-01");
    await direct(f, first);
    const next = await run((tx) => createNextRoutingVersion(tx, f.org.orgId, f.actorId, first));
    await run((tx) => updateRouting(tx, f.org.orgId, f.actorId, String(next.id), { effectiveFrom: "2026-06-01", effectiveTo: null }));
    await direct(f, String(next.id));
    const rows = await withBypassContext(async () => (await db.execute<{ id: string; status: string; effective_to: string | null }>(sql`select id, status, effective_to::text as effective_to from mfg_routings where org_id=${f.org.orgId} and produced_item_id=${f.org.items.assembly} order by version`)).rows);
    assert.deepEqual(rows.map((row) => [row.status, row.effective_to]), [["active", "2026-06-01"], ["active", null]]);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("flow-governed routing still requires approval", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const approver = await withBypassContext(() => createWorkOperator(f.org.orgId, "Engineering approver", ["manufacturing.manage"]));
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approver }], mode: "any", preventSelfApproval: true }));
    assert.equal(await run((tx) => routingDirectApplyAllowed(tx, f.org.orgId)), false);
    const routingId = await draftRouting(f, f.org.items.assembly);
    await rejected(direct(f, routingId), "routing_flow_governed", "Propose revision approval", "direct apply under a configured flow");
    const proposal = await run((tx) => proposeRoutingActivation(tx, f.org.orgId, f.actorId, routingId, {
      subsidiaryId: f.org.subsidiaryId, reason: "Approve the configured production revision", idempotencyKey: randomUUID(),
    }));
    await submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId);
    const gates = (await withBypassContext(async () => db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`))).rows;
    assert.equal(gates.length, 1);
    await decideGate({ gateId: gates[0]!.id, userId: approver, decision: "approved" });
    const activated = await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, routingId, proposal.changeId));
    assert.equal(activated.status, "active");
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("routing no-flow guard admissions are pinned and scoped", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const defs = await withBypassContext(async () => (await db.execute<{ name: string; def: string }>(sql`select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('manufacturing_routing_revision_guard','financial_change_self_decision_guard','production_bom_revision_guard')`)).rows);
    assert.equal(defs.length, 3);
    for (const row of defs) {
      assert.match(row.def, /flowConfigured/, `${row.name} must admit the automatic no-flow decision`);
      assert.match(row.def, /routing_revision_activation|bom_revision_activation/, `${row.name} admission must stay scoped to manufacturing revision activation`);
    }
    const changeId = await run((tx) => proposeFinancialChange(tx, {
      orgId: f.org.orgId, actorId: f.actorId, subsidiaryId: f.org.subsidiaryId, domain: "manufacturing",
      subjectId: f.org.items.assembly, operation: MANUFACTURING_BOM_APPROVAL_OPERATION, effectiveOn: "2026-01-01",
      reason: "Approve the configured bill of materials", idempotencyKey: randomUUID(),
      payload: { assemblyItemId: f.org.items.assembly, requiredSubsidiaryIds: [f.org.subsidiaryId], components: [{ componentItemId: f.org.items.component, quantityPer: "1" }] },
      beforeState: { lines: [] },
    }));
    await run((tx) => tx.execute(sql`update financial_changes set status='pending',updated_by=${f.actorId},updated_at=now() where org_id=${f.org.orgId} and id=${changeId} and status='draft'`));
    const failure = await run((tx) => tx.execute(sql`update financial_changes set status='approved',approved_by=${f.actorId},approved_at=now(),updated_by=${f.actorId},updated_at=now() where org_id=${f.org.orgId} and id=${changeId} and status='pending'`)).then(() => null, (error: unknown) => error);
    assert.ok(failure, "a non-routing self decision must be refused");
    const text = String((failure as { cause?: { message?: unknown } }).cause?.message ?? failure);
    assert.match(text, /must explicitly permit a native self decision/);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("routing proposal confirm records a submittable change with and without a Flow", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const bare = await draftRouting(f, f.org.items.assembly);
    const proposal = await run((tx) => proposeRoutingActivation(tx, f.org.orgId, f.actorId, bare, {
      subsidiaryId: f.org.subsidiaryId, reason: "Approve the configured production revision", idempotencyKey: randomUUID(),
    }));
    assert.ok(proposal.changeId);
    const failure = await withBypassContext(() => submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId)).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof FinancialChangeSubmitError);
    assert.equal(failure.status, 422);
    assert.match(failure.message, /configure an enabled Accounting event approval flow/);
    const approver = await withBypassContext(() => createWorkOperator(f.org.orgId, "Engineering approver", ["manufacturing.manage"]));
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approver }], mode: "any", preventSelfApproval: true }));
    const second = await draftRouting(f, f.org.items.standard);
    const governed = await run((tx) => proposeRoutingActivation(tx, f.org.orgId, f.actorId, second, {
      subsidiaryId: f.org.subsidiaryId, reason: "Approve the configured production revision", idempotencyKey: randomUUID(),
    }));
    await withBypassContext(() => submitFinancialChange(f.org.orgId, governed.changeId, f.actorId));
    const gates = (await withBypassContext(async () => db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${governed.changeId} and status='pending'`))).rows;
    assert.equal(gates.length, 1);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("routing direct activation refusals are typed", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const bare = await draftRouting(f, f.org.items.standard, "2026-01-01", false);
    await rejected(direct(f, bare), "routing_operations_required", "requires operations", "activation without operations");
    await rejected(run((tx) => activateRoutingDirect(tx, f.org.orgId, f.actorId, bare, {
      subsidiaryId: f.org.subsidiaryId, reason: "short", idempotencyKey: randomUUID(),
    })), "routing_proposal_invalid", "8–1,000", "short reason");
    const routingId = await draftRouting(f, f.org.items.assembly);
    await direct(f, routingId);
    await rejected(direct(f, routingId), "routing_not_draft", "Only a draft routing", "activation of an active revision");
    const overlapping = await run((tx) => createNextRoutingVersion(tx, f.org.orgId, f.actorId, routingId));
    await rejected(direct(f, String(overlapping.id)), "routing_version_overlap", "version 1", "overlapping successor window");
  } finally { await dropScratchOrg(f.org.orgId); }
});
