import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { ManufacturingError } from "./errors.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { addWorkCenterRate, createWorkCenter, deactivateWorkCenter, endWorkCenterRate, reactivateWorkCenter, updateWorkCenter } from "./work-centers.ts";
import { activateRouting, archiveRouting, createNextRoutingVersion, createRouting, createRoutingOperation, updateRouting, updateRoutingOperation } from "./routings.ts";
import { getItemPolicy, upsertItemPolicy, type ItemPolicyInput } from "./item-policies.ts";
import { getManufacturingPolicies, updateManufacturingPolicies } from "./policies.ts";

type Fixture = { org: ScratchOrg; actorId: string };
const DB = Boolean(process.env.OPENBOOKS_DB_URL);
async function setup(): Promise<Fixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Shop lead", "admin"));
  await withBypassContext(async () => {
    const rows = await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"manufacturing":true,"inventory":true}'::jsonb) where id=${org.orgId} returning id`);
    assert.equal(rows.rows.length, 1);
  });
  return { org, actorId };
}
function run<T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return withBypassContext(() => db.transaction(fn));
}
function center(f: Fixture, code = `WC-${randomUUID()}`, patch: Partial<Parameters<typeof createWorkCenter>[3]> = {}) {
  return run((tx) => createWorkCenter(tx, f.org.orgId, f.actorId, {
    code, name: code, kind: "machine", capacityHoursPerDay: "8", efficiencyPct: "95",
    absorbsOverhead: false, ...patch,
  }));
}
function routing(f: Fixture, itemId: string, code = `RT-${randomUUID()}`) {
  return run((tx) => createRouting(tx, f.org.orgId, f.actorId, {
    producedItemId: itemId, code, name: code, effectiveFrom: "2026-01-01", overheadBasis: "labor_hours",
  }));
}
async function operation(f: Fixture, routingId: string, centerId: string, sequence = 10, setupMinutes = "5") {
  return run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, routingId, {
    sequence, name: `Operation ${sequence}`, workCenterId: centerId, setupMinutes, runMinutesPerUnit: "1",
  }));
}
const basePolicy: ItemPolicyInput = {
  supplyMethod: "buy", leadTimeDays: 4, safetyStockQty: "2.5", minimumQty: "1", orderMultipleQty: "5", scrapPctPlanned: "2.5",
};
async function rejected(work: Promise<unknown>, code: string, phrase?: string, caseName = "") {
  await assert.rejects(work, (error: unknown) => error instanceof ManufacturingError
    && error.code === code && (!phrase || error.message.includes(phrase)), caseName);
}

const refusalCases: Array<{ name: string; run: (f: Fixture) => Promise<unknown>; code: string; phrase?: string }> = [
  { name: "efficiency must be above zero", code: "invalid_efficiency", run: (f) => center(f, undefined, { efficiencyPct: "0" }) },
  { name: "distinct work centers cannot share a code", code: "work_center_code_conflict", phrase: "already belongs to work center", run: async (f) => {
    const first = await center(f, "WC-COLLISION");
    assert.equal(first.name, "WC-COLLISION");
    return center(f, "WC-COLLISION", { name: "Different center" });
  } },
  { name: "labor centers need an active department", code: "invalid_department", run: (f) => center(f, undefined, { kind: "labor", departmentId: randomUUID() }) },
  { name: "overhead treatment is explicit", code: "required_field", run: (f) => center(f, undefined, { absorbsOverhead: undefined as never }) },
  { name: "calendar belongs to this organization", code: "invalid_calendar", run: (f) => center(f, undefined, { calendarId: randomUUID() }) },
  { name: "rate periods collide only within their own center", code: "rate_overlap", phrase: "2026-01-01 to 2026-02-01", run: async (f) => {
    const first = await center(f); const second = await center(f);
    await run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(first.id), { machineRatePerHour: "12.50", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-01" }));
    await run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(second.id), { machineRatePerHour: "9", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-01" }));
    return run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(first.id), { machineRatePerHour: "13", effectiveFrom: "2026-01-15", effectiveTo: "2026-03-01" }));
  } },
  { name: "operation cannot consume zero time", code: "operation_no_time", phrase: "delete it or give it time", run: async (f) => {
    const wc = await center(f); const rt = await routing(f, f.org.items.standard);
    return run((tx) => createRoutingOperation(tx, f.org.orgId, f.actorId, String(rt.id), { sequence: 10, name: "Zero time", workCenterId: String(wc.id), setupMinutes: "0", runMinutesPerUnit: "0" }));
  } },
  { name: "operation sequence is unique within a routing", code: "operation_sequence_duplicate", phrase: "Operation 10", run: async (f) => {
    const wc = await center(f); const rt = await routing(f, f.org.items.component); await operation(f, String(rt.id), String(wc.id));
    return operation(f, String(rt.id), String(wc.id));
  } },
  { name: "active routing versions cannot be edited", code: "routing_not_draft", phrase: "create a new version", run: async (f) => {
    const wc = await center(f); const rt = await routing(f, f.org.items.fifo); await operation(f, String(rt.id), String(wc.id));
    await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(rt.id)));
    return run((tx) => updateRouting(tx, f.org.orgId, f.actorId, String(rt.id), { name: "Changed" }));
  } },
  { name: "active versions report the other version and effectivity", code: "routing_version_overlap", phrase: "version 1 (2026-01-01 to open-ended)", run: async (f) => {
    const wc = await center(f); const first = await routing(f, f.org.items.assembly, "ROUTING-A"); await operation(f, String(first.id), String(wc.id));
    const next = await run((tx) => createNextRoutingVersion(tx, f.org.orgId, f.actorId, String(first.id)));
    await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(first.id)));
    return run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(next.id)));
  } },
  { name: "archive names open work orders", code: "routing_in_use", phrase: "WO-OPEN-42", run: async (f) => {
    const rt = await routing(f, f.org.items.service);
    await run(async (tx) => { await tx.execute(sql`insert into mfg_work_orders (org_id, number, produced_item_id, routing_id, quantity_ordered, unit, status, source) values (${f.org.orgId}, 'WO-OPEN-42', ${f.org.items.service}, ${String(rt.id)}, '1', 'ea', 'draft', 'manual')`); });
    return run((tx) => archiveRouting(tx, f.org.orgId, f.actorId, String(rt.id)));
  } },
  { name: "transfer needs two active stock locations", code: "transfer_locations_required", run: async (f) => {
    await withBypassContext(async () => { const rows = await db.execute(sql`update stock_locations set is_active=false where org_id=${f.org.orgId} and id=${f.org.stockLocationId2} returning id`); assert.equal(rows.rows.length, 1); });
    return run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...basePolicy, supplyMethod: "transfer" }));
  } },
  { name: "lead time is a non-negative integer", code: "invalid_lead_time", run: (f) => run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...basePolicy, leadTimeDays: 1.5 })) },
  { name: "planning quantities are non-negative exact decimals", code: "invalid_decimal", run: (f) => run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...basePolicy, safetyStockQty: "-0.1" })) },
  { name: "planned scrap remains below one hundred percent", code: "invalid_scrap_pct", run: (f) => run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.component, { ...basePolicy, scrapPctPlanned: "100" })) },
  { name: "completion tolerance cannot exceed one hundred", code: "invalid_tolerance", run: (f) => run((tx) => updateManufacturingPolicies(tx, f.org.orgId, f.actorId, { shortagePolicy: "warn", completionTolerancePct: "100.1", abnormalScrapApprovalThreshold: null })) },
];

test("manufacturing master refusal cases", { skip: !DB }, async () => {
  const f = await setup();
  try {
    for (const row of refusalCases) await rejected(row.run(f), row.code, row.phrase, row.name);
  } finally { await dropScratchOrg(f.org.orgId); }
});

test("manufacturing masters create, update, transition, and read their configuration", { skip: !DB }, async () => {
  const f = await setup();
  try {
    const wc = await center(f, "WC-HAPPY");
    const updatedCenter = await run((tx) => updateWorkCenter(tx, f.org.orgId, f.actorId, String(wc.id), { name: "Assembly machine", efficiencyPct: "100" }));
    assert.equal(updatedCenter.efficiencyPct, "100.0000");
    const rate = await run((tx) => addWorkCenterRate(tx, f.org.orgId, f.actorId, String(wc.id), { machineRatePerHour: "25.75", effectiveFrom: "2026-01-01" }));
    const endedRate = await run((tx) => endWorkCenterRate(tx, f.org.orgId, f.actorId, String(wc.id), String(rate.id), "2026-05-01"));
    assert.equal(endedRate.effectiveTo, "2026-05-01");
    await run((tx) => deactivateWorkCenter(tx, f.org.orgId, f.actorId, String(wc.id)));
    await run((tx) => reactivateWorkCenter(tx, f.org.orgId, f.actorId, String(wc.id)));

    const first = await routing(f, f.org.items.assembly, "RT-HAPPY");
    const op = await operation(f, String(first.id), String(wc.id));
    await run((tx) => updateRoutingOperation(tx, f.org.orgId, f.actorId, String(first.id), String(op.id), { name: "Cut" }));
    await run((tx) => updateRouting(tx, f.org.orgId, f.actorId, String(first.id), { name: "Assembly route", effectiveTo: "2027-01-01" }));
    await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(first.id)));
    const second = await run((tx) => createNextRoutingVersion(tx, f.org.orgId, f.actorId, String(first.id)));
    assert.equal(second.operations.length, 1);
    await run((tx) => updateRouting(tx, f.org.orgId, f.actorId, String(second.id), { effectiveFrom: "2027-01-01", effectiveTo: null }));
    await run((tx) => activateRouting(tx, f.org.orgId, f.actorId, String(second.id)));
    await run((tx) => archiveRouting(tx, f.org.orgId, f.actorId, String(first.id)));
    await run((tx) => archiveRouting(tx, f.org.orgId, f.actorId, String(second.id)));

    const policy = await run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.assembly, basePolicy));
    assert.equal(policy.supplyMethod, "buy");
    const updatedPolicy = await run((tx) => upsertItemPolicy(tx, f.org.orgId, f.actorId, f.org.items.assembly, { ...basePolicy, supplyMethod: "transfer" }));
    assert.equal((await run((tx) => getItemPolicy(tx, f.org.orgId, f.org.items.assembly)))?.id, updatedPolicy.id);
    const defaults = await run((tx) => getManufacturingPolicies(tx, f.org.orgId));
    assert.deepEqual(defaults, { shortagePolicy: "warn", completionTolerancePct: "1", abnormalScrapApprovalThreshold: null });
    const policies = await run((tx) => updateManufacturingPolicies(tx, f.org.orgId, f.actorId, { shortagePolicy: "refuse", completionTolerancePct: "1.5", abnormalScrapApprovalThreshold: "20.25" }));
    assert.deepEqual(policies, { shortagePolicy: "refuse", completionTolerancePct: "1.5", abnormalScrapApprovalThreshold: "20.2500" });
  } finally { await dropScratchOrg(f.org.orgId); }
});
