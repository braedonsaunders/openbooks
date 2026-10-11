import { createManufacturingOperator, createWorkOperator } from "../testing/manufacturing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, type SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, type ScratchOrg } from "../testing/fixtures.ts";
import { submitFinancialChange, FinancialChangeSubmitError } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { BomPolicyError, applyBomRevision, readBomPolicyVersion, saveBomPolicy, submitBomRevision } from "./bom-policy.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { createWorkCenter } from "../manufacturing/work-centers.ts";
import { activateRoutingDirect, createRouting, createRoutingOperation } from "../manufacturing/routings.ts";
import { applyStandardRollup, previewStandardRollup, proposeStandardRollup } from "../manufacturing/standard-rollup.ts";
import { createWorkOrder, releaseWorkOrder } from "../manufacturing/work-orders.ts";
import { explodeBom } from "../manufacturing/bom-explode.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
type Fixture = { org: ScratchOrg; actorId: string };
function run<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> { return withBypassContext(() => db.transaction(work)); }

async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createManufacturingOperator(org.orgId, "Shop lead"));
  await withBypassContext(async () => {
    const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true,"warehousing":true}'::jsonb) where id=${org.orgId} returning id`);
    assert.equal(rows.rows.length, 1);
  });
  return { org, actorId };
}

async function propose(f: Fixture, extraComponents = 2) {
  const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, f.org.items.assembly));
  const existing = await run((tx) => tx.execute<{ componentItemId: string; quantityPer: string; effectiveFrom: string | null; effectiveTo: string | null }>(sql`select component_item_id as "componentItemId", quantity_per::text as "quantityPer", effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo" from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly} order by sort_order`));
  assert.ok(existing.rows.length >= 1, "the scratch recipe carries a retained line");
  const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
  const spares = [f.org.items.component, f.org.items.standard, f.org.items.fifo, f.org.items.movingAvg].filter((id) => !existing.rows.some((row) => row.componentItemId === id));
  assert.ok(spares.length >= extraComponents, "the scratch catalog carries spare components");
  const components = [
    ...existing.rows.map((row) => ({ componentItemId: row.componentItemId, quantityPer: row.quantityPer, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, operationSeq: null, scrapPct: null, isByproduct: false })),
    ...spares.slice(0, extraComponents).map((componentItemId) => ({ componentItemId, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false })),
  ];
  const proposal = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
    assemblyItemId: f.org.items.assembly, expectedVersion: version, reason: "Approve the next material requirement",
    subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components,
  }));
  assert.ok("changeId" in proposal);
  return { changeId: proposal.changeId as string, lineCount: components.length };
}

async function changeRow(f: Fixture, changeId: string) {
  return (await withBypassContext(async () => db.execute<{ status: string; submitted_by: string; approved_by: string | null; payload: unknown }>(sql`select status, submitted_by, approved_by, payload from financial_changes where org_id=${f.org.orgId} and id=${changeId}`))).rows[0];
}

test("BOM proposal applies with no Flow", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const { changeId, lineCount } = await propose(f);
    assert.equal(lineCount, 3);
    const proposed = await changeRow(f, changeId);
    assert.equal(proposed?.status, "draft");
    const decision = (proposed?.payload as { decision?: { mode?: unknown; policy?: { flowConfigured?: unknown } } }).decision;
    assert.equal(decision?.mode, "automatic");
    assert.equal(decision?.policy?.flowConfigured, false);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    const applied = await changeRow(f, changeId);
    assert.equal(applied?.status, "applied");
    assert.equal(applied?.approved_by, f.actorId);
    assert.equal(applied?.submitted_by, f.actorId);
    const lines = await run((tx) => tx.execute<{ n: string }>(sql`select count(*) as n from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`));
    assert.equal(lines.rows[0]?.n, "3");
    const audit = await run((tx) => tx.execute<{ changes: unknown }>(sql`select changes from audit_log where org_id=${f.org.orgId} and table_name='bom_components' and row_id=${f.org.items.assembly} order by id desc limit 1`));
    assert.equal((audit.rows[0]?.changes as { approvalChangeId?: string }).approvalChangeId, changeId);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("BOM routes through gates when a Flow exists", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const approver = await withBypassContext(() => createWorkOperator(f.org.orgId, "Recipe decision", ["manufacturing.manage", "admin.setup.manage"]));
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approver }], mode: "any", preventSelfApproval: true }));
    const { changeId } = await propose(f);
    const proposed = await changeRow(f, changeId);
    assert.equal((proposed?.payload as { decision?: unknown }).decision, undefined);
    const before = await run((tx) => tx.execute<{ n: string }>(sql`select count(*) as n from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`));
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    assert.equal((await changeRow(f, changeId))?.status, "pending");
    const gates = (await withBypassContext(async () => db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${changeId} and status='pending'`))).rows;
    assert.equal(gates.length, 1);
    assert.deepEqual((await run((tx) => tx.execute<{ n: string }>(sql`select count(*) as n from bom_components where org_id=${f.org.orgId} and assembly_item_id=${f.org.items.assembly}`))).rows, before.rows);
    await decideGate({ gateId: gates[0]!.id, userId: approver, decision: "approved" });
    const result = await withBypassContext(() => applyBomRevision(f.org.orgId, f.actorId, changeId));
    assert.equal(result.componentCount, 3);
    assert.equal((await changeRow(f, changeId))?.status, "applied");
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("submit without a governing Flow is a 4xx refusal with text", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const { changeId } = await propose(f);
    const failure = await withBypassContext(() => submitFinancialChange(f.org.orgId, changeId, f.actorId)).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof FinancialChangeSubmitError);
    assert.equal((failure as FinancialChangeSubmitError).status, 422);
    assert.equal((failure as FinancialChangeSubmitError).code, "financial_change_flow_required");
    assert.match((failure as Error).message, /configure an enabled Accounting event approval flow/);
    assert.ok((failure as FinancialChangeSubmitError).remedy?.trim());
    assert.equal((await changeRow(f, changeId))?.status, "draft");
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("submit under a silent configured Flow is a 4xx refusal with text", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const approver = await withBypassContext(() => createWorkOperator(f.org.orgId, "Recipe decision", ["manufacturing.manage", "admin.setup.manage"]));
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approver }], mode: "any", trigger: "on_create" }));
    const { changeId } = await propose(f);
    const failure = await withBypassContext(() => submitFinancialChange(f.org.orgId, changeId, f.actorId)).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof FinancialChangeSubmitError);
    assert.equal((failure as FinancialChangeSubmitError).status, 422);
    assert.match((failure as Error).message, /configure an enabled Accounting event approval flow/);
  } finally { await dropScratchOrg(f.org.orgId); }
});

function pastDate(today: string, days: number) {
  const date = new Date(today + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

async function releaseReady(f: Fixture) {
  const wipId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into accounts
      (id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
      values(${wipId},${f.org.orgId},'1210','Manufacturing WIP','asset_current_other',false,true,false,false,'[]'::jsonb,'{}'::jsonb,true)`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('mfgWip',${wipId}::text),true) where id=${f.org.orgId}`);
  });
  const departmentId = String((await withBypassContext(() => db.execute(sql`insert into departments (org_id, name) values (${f.org.orgId}, 'Assembly') returning id`))).rows[0]!.id);
  await withBypassContext(() => db.execute(sql`insert into labor_cost_rates
    (org_id, department_id, currency, rate, basis, annual_hours, effective_from, is_active, created_by, updated_by)
    values (${f.org.orgId}, ${departmentId}, 'CAD', '0', 'hour', '2080', '2020-01-01', true, ${f.actorId}, ${f.actorId})`));
  return departmentId;
}

async function emptyAssemblyItem(f: Fixture) {
  for (const itemId of [f.org.items.standard, f.org.items.fifo, f.org.items.movingAvg, f.org.items.component]) {
    const item = (await run((tx) => tx.execute<{ kind: string }>(sql`select kind from items where org_id=${f.org.orgId} and id=${itemId}`))).rows[0];
    if (!item || item.kind === "kit") continue;
    const lines = (await run((tx) => tx.execute(sql`select id from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId} limit 1`))).rows;
    if (lines.length === 0) return itemId;
  }
  throw new Error("the scratch catalog carries no line-free assembly-capable item");
}

async function activeRoute(f: Fixture, itemId: string, from: string, departmentId: string, operations: Array<{ sequence: number; backflushAt: "none" | "start" | "finish" }> = [{ sequence: 10, backflushAt: "none" }]) {
  const code = `WC-${randomUUID()}`;
  const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code, name: code, kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false, departmentId,
  }));
  const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: itemId, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: from,
    defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
  }));
  for (const operation of operations) {
    await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
      sequence: operation.sequence, name: `Assemble ${operation.sequence}`, workCenterId: String(center.id),
      setupMinutes: "5", runMinutesPerUnit: "1", backflushAt: operation.backflushAt,
    }));
  }
  await run((tx) => activateRoutingDirect(tx, f.org.orgId, f.actorId, String(routing.id), {
    subsidiaryId: f.org.subsidiaryId, reason: "Activate the configured production revision", idempotencyKey: randomUUID(),
  }));
  return routing;
}

function backdatedLines(f: Fixture, itemId: string, from: string) {
  return [f.org.items.component, f.org.items.standard, f.org.items.fifo, f.org.items.movingAvg]
    .filter((id) => id !== itemId).slice(0, 3)
    .map((componentItemId) => ({ componentItemId, quantityPer: "1", effectiveFrom: from, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false }));
}

test("back-dated first revision applies with no production and serves back-dated orders", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const past = pastDate(today, 60);
    assert.ok(past < today);
    const reason = "Record the opening recipe for converting historical production";
    const proposal = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason,
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components: backdatedLines(f, itemId, past),
    }));
    assert.ok("changeId" in proposal);
    const changeId = proposal.changeId as string;
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    assert.equal((await changeRow(f, changeId))?.status, "applied");
    const stored = (await run((tx) => tx.execute<{ effectiveFrom: string | null }>(sql`select effective_from::text as "effectiveFrom" from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId}`))).rows;
    assert.equal(stored.length, 3);
    assert.ok(stored.every((row) => row.effectiveFrom === past));
    const exploded = await run((tx) => explodeBom(tx, f.org.orgId, itemId, "1", past));
    assert.equal(exploded.components.length, 3);
    const audit = await run((tx) => tx.execute<{ reason: string; approval: string }>(sql`select changes->>'reason' as reason, changes->>'approvalChangeId' as approval from audit_log where org_id=${f.org.orgId} and table_name='bom_components' and row_id=${itemId} order by id desc limit 1`));
    assert.equal(audit.rows[0]?.reason, reason);
    assert.equal(audit.rows[0]?.approval, changeId);
    await activeRoute(f, itemId, past, departmentId);
    const draft = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
      producedItemId: itemId, quantityOrdered: "1", subsidiaryId: f.org.subsidiaryId,
      issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: past,
    }));
    const released = await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    assert.equal(released.status, "released");
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("back-dated first revision refuses naming posted production", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const past = pastDate(today, 60);
    const current = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: backdatedLines(f, itemId, past).map((line) => ({ ...line, effectiveFrom: today })),
    }));
    assert.ok("changeId" in current);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, current.changeId as string));
    await activeRoute(f, itemId, past, departmentId);
    const draft = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
      producedItemId: itemId, quantityOrdered: "1", subsidiaryId: f.org.subsidiaryId,
      issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: today,
    }));
    const released = await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    assert.equal(released.status, "released");
    const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, itemId));
    await assert.rejects(run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: version, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components: backdatedLines(f, itemId, past),
    })), (error: unknown) => error instanceof BomPolicyError && error.code === "bom_backdated_revision" && error.message.includes(released.number));
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("back-dated revision of an existing recipe applies with no production", { skip: !DB }, async () => {
  const f = await setup();
  try {
    await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const past30 = pastDate(today, 30);
    const past60 = pastDate(today, 60);
    assert.ok(past60 < past30 && past30 < today);
    const reason = "Record the opening recipe for converting historical production";
    const line = (componentItemId: string, effectiveFrom: string) =>
      ({ componentItemId, quantityPer: "1", effectiveFrom, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false });
    const spares = [f.org.items.component, f.org.items.standard, f.org.items.fifo, f.org.items.movingAvg].filter((id) => id !== itemId);
    assert.ok(spares.length >= 2);
    const first = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason,
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components: [line(spares[0]!, past30)],
    }));
    assert.ok("changeId" in first);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, first.changeId as string));
    const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, itemId));
    const revision = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: version, reason,
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [line(spares[0]!, past30), line(spares[1]!, past60)],
    }));
    assert.ok("changeId" in revision);
    const changeId = revision.changeId as string;
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    assert.equal((await changeRow(f, changeId))?.status, "applied");
    const stored = (await run((tx) => tx.execute<{ effectiveFrom: string | null }>(sql`select effective_from::text as "effectiveFrom" from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId} order by effective_from nulls first`))).rows;
    assert.deepEqual(stored.map((row) => row.effectiveFrom), [past60, past30]);
    const audit = await run((tx) => tx.execute<{ before: unknown[]; after: unknown[] }>(sql`select changes->'before' as before, changes->'after' as after from audit_log where org_id=${f.org.orgId} and table_name='bom_components' and row_id=${itemId} order by id desc limit 1`));
    assert.equal(audit.rows[0]?.before.length, 1);
    assert.equal(audit.rows[0]?.after.length, 2);
    const exploded = await run((tx) => explodeBom(tx, f.org.orgId, itemId, "1", past60));
    assert.equal(exploded.components.length, 1);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("back-dated revision of an existing recipe refuses naming posted production", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const past = pastDate(today, 60);
    const current = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: backdatedLines(f, itemId, past).map((line) => ({ ...line, effectiveFrom: today })),
    }));
    assert.ok("changeId" in current);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, current.changeId as string));
    await activeRoute(f, itemId, past, departmentId);
    const draft = await run((tx) => createWorkOrder(tx, f.org.orgId, f.actorId, {
      producedItemId: itemId, quantityOrdered: "1", subsidiaryId: f.org.subsidiaryId,
      issueLocationId: f.org.stockLocationId, receiptLocationId: f.org.stockLocationId2, plannedStart: today,
    }));
    const released = await run((tx) => releaseWorkOrder(tx, f.org.orgId, f.actorId, draft.id));
    assert.equal(released.status, "released");
    const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, itemId));
    await assert.rejects(run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: version, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components: backdatedLines(f, itemId, past),
    })), (error: unknown) => error instanceof BomPolicyError && error.code === "bom_backdated_revision" && error.message.includes(released.number));
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("back-dated revision refuses naming an applied standard-cost roll-up", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    // The standard-costed widget carries the roll-up; its component needs a
    // standard cost for the preview to measure.
    const itemId = f.org.items.standard;
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const past = pastDate(today, 60);
    const first = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [{ componentItemId: f.org.items.component, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false }],
    }));
    assert.ok("changeId" in first);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, first.changeId as string));
    await withBypassContext(async () => {
      await db.execute(sql`update item_inventory_profiles set standard_cost='3' where org_id=${f.org.orgId} and item_id=${f.org.items.component}`);
    });
    const code = `WC-${randomUUID()}`;
    const center = await run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
      code, name: code, kind: "labor", capacityHoursPerDay: "8", efficiencyPct: "100", absorbsOverhead: false, departmentId,
    }));
    const routing = await run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
      producedItemId: itemId, code: `RT-${randomUUID()}`, name: "Assembly route", effectiveFrom: past,
      defaultIssueLocationId: f.org.stockLocationId, defaultReceiptLocationId: f.org.stockLocationId2, overheadBasis: "units",
    }));
    await run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(routing.id), {
      sequence: 10, name: "Assemble", workCenterId: String(center.id), setupMinutes: "0", runMinutesPerUnit: "1",
    }));
    await run((tx) => activateRoutingDirect(tx, f.org.orgId, f.actorId, String(routing.id), {
      subsidiaryId: f.org.subsidiaryId, reason: "Activate the configured production revision", idempotencyKey: randomUUID(),
    }));
    const basis = { itemId, subsidiaryId: f.org.subsidiaryId, onDate: today, batchQuantity: "10" };
    const preview = await run((tx) => previewStandardRollup(tx, f.org.orgId, f.actorId, basis));
    const proposal = await run((tx) => proposeStandardRollup(tx, f.org.orgId, f.actorId, {
      ...basis, reason: "Review standard material and cell conversion costs", idempotencyKey: randomUUID(), expectedDigest: preview.digest,
    }));
    const approver = await withBypassContext(() => createWorkOperator(f.org.orgId, "Cost approver", ["manufacturing.manage", "items.manage"]));
    await withBypassContext(() => seedApprovalFlow(f.org.orgId, { subjectKind: "financial_change", assignees: [{ type: "user", userId: approver }], mode: "any", preventSelfApproval: true }));
    await withBypassContext(() => submitFinancialChange(f.org.orgId, proposal.changeId, f.actorId));
    const gate = await run(async (tx) => (await tx.execute<{ id: string }>(sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='financial_change' and subject_id=${proposal.changeId} and status='pending'`)).rows[0]!);
    await withBypassContext(() => decideGate({ gateId: gate.id, userId: approver, decision: "approved" }));
    await withBypassContext(() => applyStandardRollup(f.org.orgId, f.actorId, proposal.changeId));
    const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, itemId));
    await assert.rejects(run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: version, reason: "Record the opening recipe for converting historical production",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [
        { componentItemId: f.org.items.component, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false },
        { componentItemId: f.org.items.fifo, quantityPer: "1", effectiveFrom: past, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false },
      ],
    })), (error: unknown) => error instanceof BomPolicyError && error.code === "bom_backdated_revision" && /roll-up/.test(error.message) && error.message.includes(today));
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("recipe revision round-trips per-line fields through propose, submit and apply", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const [firstComponent, secondComponent] = [f.org.items.component, f.org.items.standard, f.org.items.fifo, f.org.items.movingAvg].filter((id) => id !== itemId);
    const components = [
      { componentItemId: firstComponent!, quantityPer: "2", effectiveFrom: today, effectiveTo: null, operationSeq: 10, scrapPct: "5", isByproduct: false },
      { componentItemId: secondComponent!, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: 20, scrapPct: null, isByproduct: true, quantityBasis: "per_unit" as const, formulaOutputQuantity: "1", outputCostWeight: "2" },
    ];
    const proposal = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Approve the next material requirement with joint output",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(), components,
    }));
    assert.ok("changeId" in proposal);
    const changeId = proposal.changeId as string;
    const frozen = (await changeRow(f, changeId))?.payload as { components: Array<Record<string, unknown>> };
    assert.equal(frozen.components[0]?.operationSeq, 10);
    assert.equal(Number(frozen.components[0]?.scrapPct), 5);
    assert.equal(frozen.components[1]?.operationSeq, 20);
    assert.equal(frozen.components[1]?.isByproduct, true);
    assert.equal(Number(frozen.components[1]?.outputCostWeight), 2);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    assert.equal((await changeRow(f, changeId))?.status, "applied");
    const stored = (await run((tx) => tx.execute<{
      componentItemId: string; operationSeq: number | null; scrap: string | null; basis: string; formula: string; byproduct: boolean; weight: string | null;
    }>(sql`select component_item_id as "componentItemId", operation_seq as "operationSeq", scrap_pct::text as scrap,
      quantity_basis as basis, formula_output_quantity::text as formula, is_byproduct as byproduct, output_cost_weight::text as weight
      from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId} order by sort_order`))).rows;
    assert.equal(stored.length, 2);
    assert.deepEqual([stored[0]?.operationSeq, Number(stored[0]?.scrap), stored[0]?.basis, stored[0]?.byproduct, stored[0]?.weight],
      [10, 5, "per_unit", false, null]);
    assert.deepEqual([stored[1]?.operationSeq, stored[1]?.scrap, stored[1]?.basis, Number(stored[1]?.formula), stored[1]?.byproduct, Number(stored[1]?.weight)],
      [20, null, "per_unit", 1, true, 2]);
    const audit = await run((tx) => tx.execute<{ after: Array<Record<string, unknown>> }>(sql`select changes->'after' as after from audit_log where org_id=${f.org.orgId} and table_name='bom_components' and row_id=${itemId} order by id desc limit 1`));
    assert.equal(audit.rows[0]?.after.length, 2);
    assert.equal(audit.rows[0]?.after[0]?.operationSeq, 10);
    assert.equal(Number(audit.rows[0]?.after[1]?.outputCostWeight), 2);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("re-added line defaults its operation sequence from a single consuming operation", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    await activeRoute(f, itemId, pastDate(today, 60), departmentId, [{ sequence: 10, backflushAt: "finish" }]);
    const proposal = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Approve the next material requirement",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [{ componentItemId: f.org.items.component, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false }],
    }));
    assert.ok("changeId" in proposal);
    const changeId = proposal.changeId as string;
    assert.equal(((await changeRow(f, changeId))?.payload as { components: Array<{ operationSeq: number | null }> }).components[0]?.operationSeq, 10);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, changeId));
    const stored = (await run((tx) => tx.execute<{ operationSeq: number | null }>(sql`select operation_seq as "operationSeq" from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId}`))).rows;
    assert.deepEqual(stored.map((row) => row.operationSeq), [10]);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("blank operation sequence is refused with several consuming operations", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    const routing = await activeRoute(f, itemId, pastDate(today, 60), departmentId, [{ sequence: 10, backflushAt: "finish" }, { sequence: 20, backflushAt: "start" }]);
    const version = await run((tx) => readBomPolicyVersion(tx, f.org.orgId, itemId));
    await assert.rejects(run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: version, reason: "Approve the next material requirement",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [{ componentItemId: f.org.items.component, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false }],
    })), (error: unknown) => error instanceof BomPolicyError && error.code === "bom_operation_seq_required"
      && error.message.includes(String((routing as unknown as { code: string }).code)) && /10.*20/.test(error.message));
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("blank operation sequence stands without a consuming operation", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const departmentId = await releaseReady(f);
    const itemId = await emptyAssemblyItem(f);
    const today = await run((tx) => businessTodayInTx(tx, f.org.orgId));
    await activeRoute(f, itemId, pastDate(today, 60), departmentId);
    const proposal = await run((tx) => saveBomPolicy(tx, f.org.orgId, f.actorId, {
      assemblyItemId: itemId, expectedVersion: null, reason: "Approve the next material requirement",
      subsidiaryId: f.org.subsidiaryId, requestKey: randomUUID(),
      components: [{ componentItemId: f.org.items.component, quantityPer: "1", effectiveFrom: today, effectiveTo: null, operationSeq: null, scrapPct: null, isByproduct: false }],
    }));
    assert.ok("changeId" in proposal);
    await withBypassContext(() => submitBomRevision(f.org.orgId, f.actorId, proposal.changeId as string));
    const stored = (await run((tx) => tx.execute<{ operationSeq: number | null }>(sql`select operation_seq as "operationSeq" from bom_components where org_id=${f.org.orgId} and assembly_item_id=${itemId}`))).rows;
    assert.deepEqual(stored.map((row) => row.operationSeq), [null]);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("BOM direct submit refusals are typed", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const { changeId } = await propose(f);
    const peer = await withBypassContext(() => createWorkOperator(f.org.orgId, "Peer operator", ["manufacturing.manage", "admin.setup.manage"]));
    await assert.rejects(withBypassContext(() => submitBomRevision(f.org.orgId, peer, changeId)), (error: unknown) => error instanceof BomPolicyError && /proposer/.test(error.message) && error.status === 422);
    const stranger = await withBypassContext(() => createWorkOperator(f.org.orgId, "Outside operator", ["manufacturing.read"]));
    await assert.rejects(withBypassContext(() => submitBomRevision(f.org.orgId, stranger, changeId)), (error: unknown) => error instanceof ScopeNotFoundError);
    await assert.rejects(withBypassContext(() => submitBomRevision(f.org.orgId, randomUUID(), changeId)), (error: unknown) => error instanceof ScopeNotFoundError);
  } finally { await dropScratchOrg(f.org.orgId); }
});
