import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Real-Postgres coverage for the asset reverse-event record boundary: only the
// authz gate is stubbed, every other import (JSON parsing, calendar dates,
// the lifecycle engine) is the code the route serves.
const stateKey = Symbol.for("openbooks.asset-reverse-event-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-reverse-event-route-test')]
  export async function guardFeaturePermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      // Anchor at the web/ root instead of assuming the importer's depth: this
      // route sits one level deeper than the [id] routes the pattern was copied from.
      const webRoot = context.parentURL.slice(0, context.parentURL.indexOf("/web/") + 5);
      return nextResolve(new URL(`./${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    if (
      specifier === "../../../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/assets/")
    ) {
      return { url: "mock:asset-reverse-event-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-reverse-event-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-reverse-event-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { buildSchedule } = await import("@openbooks/engine/src/assets/depreciation.ts");
const { disposeAsset, remeasureAsset } = await import("@openbooks/engine/src/assets/asset-lifecycle.ts");
const { proposeAssetChange, applyAssetChange } = await import("@openbooks/engine/src/assets/asset-changes.ts");
import type { AssetChangeInput } from "@openbooks/engine/src/assets/asset-changes.ts";
const { submitFinancialChange } = await import("@openbooks/engine/src/flows/financial-changes-adapter.ts");
const { decideGate } = await import("@openbooks/engine/src/flows/gates.ts");
const {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  seedApprovalFlow,
} = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  assetId: string;
  date: string;
}

async function seedAsset(tag: string): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const categoryId = randomUUID();
  const assetId = randomUUID();
  await db.execute(sql`
    insert into asset_categories
      (id, org_id, name, asset_account_id, accumulated_depreciation_account_id,
       depreciation_expense_account_id, gain_loss_account_id, default_method,
       default_life_months, default_convention, tax_attributes, is_active)
    values (${categoryId}, ${org.orgId}, 'Reverse-route equipment', ${org.accounts.invAsset},
            ${org.accounts.clearing}, ${org.accounts.adjustment}, ${org.accounts.adjustment},
            'straight_line', 12, 'full_month', '{}'::jsonb, true)`);
  await db.execute(sql`
    insert into fixed_assets
      (id, org_id, subsidiary_id, category_id, asset_number, name, status,
       acquired_on, in_service_on, acquisition_cost, salvage_value,
       depreciation_method, useful_life_months, custom)
    values (${assetId}, ${org.orgId}, ${org.subsidiaryId}, ${categoryId}, ${tag},
            'Reverse-route asset', 'in_service', ${org.date}, ${org.date}, '12000.0000',
            '2000.0000', 'straight_line', 12, '{}'::jsonb)`);
  await buildSchedule(assetId, org.orgId, actorId, org.bookId);
  return { orgId: org.orgId, actorId, assetId, date: org.date };
}

function authed(fixture: Fixture, allowedSubsidiaryIds: Set<string> | null = null): void {
  routeState.authz = {
    user: { orgId: fixture.orgId, id: fixture.actorId },
    allowedSubsidiaryIds,
  };
}

function getRequest(fixture: Fixture): Request {
  return new Request(`http://openbooks.test/api/assets/${fixture.assetId}/reverse-event`);
}

function postRequest(fixture: Fixture, body: unknown): Request {
  return new Request(`http://openbooks.test/api/assets/${fixture.assetId}/reverse-event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function eventFor(orgId: string, entryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`select id from asset_events where org_id=${orgId} and journal_entry_id=${entryId}`)).rows[0]!.id;
}

async function writeCounts(orgId: string, assetId: string) {
  return (await db.execute<{ events: number; journals: number }>(sql`
    select (select count(*)::int from asset_events where org_id=${orgId} and asset_id=${assetId}) as events,
           (select count(*)::int from journal_entries where org_id=${orgId}) as journals`)).rows[0]!;
}

async function assetStatus(orgId: string, assetId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`select status from fixed_assets where org_id=${orgId} and id=${assetId}`)).rows[0]!.status;
}

test("reverse-event GET names a posted disposal as the reversible candidate", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-GET");
  try {
    authed(fixture);
    const disposal = await disposeAsset(fixture.orgId, fixture.assetId, {
      actorId: fixture.actorId,
      date: fixture.date,
      writeOff: true,
    });
    const response = await GET(getRequest(fixture), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(response.status, 200);
    const data = (await response.json()) as {
      events: { id: string; kind: string; reversible: boolean; entryNumber: string; blockReason: string | null }[];
    };
    const sourceEvent = await eventFor(fixture.orgId, disposal.entryId);
    const candidate = data.events.find((e) => e.id === sourceEvent);
    assert.ok(candidate, "the posted disposal must be listed");
    assert.equal(candidate.kind, "written_off");
    assert.equal(candidate.reversible, true);
    assert.equal(candidate.blockReason, null);
    assert.ok(candidate.entryNumber.length > 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("reverse-event POST restores a disposed asset and replays exactly once", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-POST");
  try {
    authed(fixture);
    const disposal = await disposeAsset(fixture.orgId, fixture.assetId, {
      actorId: fixture.actorId,
      date: fixture.date,
      writeOff: true,
    });
    assert.equal(await assetStatus(fixture.orgId, fixture.assetId), "written_off");
    const eventId = await eventFor(fixture.orgId, disposal.entryId);
    const body = { eventId, date: fixture.date, reason: "Restore asset after mistaken write-off" };

    const first = await POST(postRequest(fixture, body), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(first.status, 200, `reversal failed: ${JSON.stringify(await first.clone().json().catch(() => null))}`);
    const created = (await first.json()) as {
      assetId: string; sourceEventId: string; reversalEventId: string; reversalEntryId: string; created: boolean;
    };
    assert.equal(created.assetId, fixture.assetId);
    assert.equal(created.sourceEventId, eventId);
    assert.equal(created.created, true);
    assert.equal(await assetStatus(fixture.orgId, fixture.assetId), "in_service");

    const counts = await writeCounts(fixture.orgId, fixture.assetId);
    const replay = await POST(postRequest(fixture, body), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(replay.status, 200);
    const repeated = (await replay.json()) as typeof created;
    assert.equal(repeated.created, false);
    assert.equal(repeated.reversalEventId, created.reversalEventId);
    assert.equal(repeated.reversalEntryId, created.reversalEntryId);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), counts);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("reverse-event POST reverses an impairment through the record boundary", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-IMPAIR");
  try {
    authed(fixture);
    const impairment = await remeasureAsset(fixture.orgId, fixture.assetId, {
      newCarryingValue: "9000.0000",
      date: fixture.date,
      actorId: fixture.actorId,
    });
    const eventId = await eventFor(fixture.orgId, impairment.entryId);
    const response = await POST(
      postRequest(fixture, { eventId, date: fixture.date, reason: "Correct the overstated impairment assessment" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as { created: boolean; sourceEventId: string };
    assert.equal(result.created, true);
    assert.equal(result.sourceEventId, eventId);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("reverse-event POST refuses short reasons, bad dates, and malformed bodies without writing", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-REFUSE");
  try {
    authed(fixture);
    const disposal = await disposeAsset(fixture.orgId, fixture.assetId, {
      actorId: fixture.actorId,
      date: fixture.date,
      writeOff: true,
    });
    const eventId = await eventFor(fixture.orgId, disposal.entryId);
    const before = await writeCounts(fixture.orgId, fixture.assetId);
    for (const body of [
      { eventId, date: fixture.date, reason: "oops" },
      { eventId, date: fixture.date, reason: "   " },
      { eventId, date: "31-08-2026", reason: "Restore asset after mistaken write-off" },
      { eventId, date: "2026-02-30", reason: "Restore asset after mistaken write-off" },
    ]) {
      const response = await POST(postRequest(fixture, body), { params: Promise.resolve({ id: fixture.assetId }) });
      assert.equal(response.status, 422);
      assert.ok(((await response.json()) as { error?: string }).error);
    }
    const malformed = await POST(
      new Request(`http://openbooks.test/api/assets/${fixture.assetId}/reverse-event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(malformed.status, 400);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), before);
    assert.equal(await assetStatus(fixture.orgId, fixture.assetId), "written_off");
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});

test("reverse-event POST refuses a foreign asset event and an out-of-scope subsidiary", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-FOREIGN");
  const other = await seedAsset("REVERSE-FOREIGN-OTHER");
  try {
    const disposal = await disposeAsset(other.orgId, other.assetId, {
      actorId: other.actorId,
      date: other.date,
      writeOff: true,
    });
    const foreignEvent = await eventFor(other.orgId, disposal.entryId);

    authed(fixture);
    const before = await writeCounts(fixture.orgId, fixture.assetId);
    const foreign = await POST(
      postRequest(fixture, { eventId: foreignEvent, date: fixture.date, reason: "Restore asset after mistaken write-off" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(foreign.status, 422);
    assert.match(((await foreign.json()) as { error: string }).error, /not found/);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), before);

    authed(fixture, new Set([randomUUID()]));
    const scoped = await GET(getRequest(fixture), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(scoped.status, 404);
    const scopedPost = await POST(
      postRequest(fixture, { eventId: foreignEvent, date: fixture.date, reason: "Restore asset after mistaken write-off" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(scopedPost.status, 404);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), before);

    authed(fixture, new Set());
    const emptyGet = await GET(getRequest(fixture), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(emptyGet.status, 404);
    const emptyPost = await POST(
      postRequest(fixture, { eventId: foreignEvent, date: fixture.date, reason: "Restore asset after mistaken write-off" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(emptyPost.status, 404);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), before);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
    await dropScratchOrgReporting(other.orgId);
  }
});

test("reverse-event keeps approved multi-book change events on Accounting changes", { skip: !DB }, async () => {
  const fixture = await seedAsset("REVERSE-CHANGE");
  try {
    const flowActors = await seedFlowActors(fixture.orgId);
    const actors = { submitterId: flowActors.submitterId, approver1Id: flowActors.approver1Id };
    // Applying a 12-month-life change rebuilds the full remaining plan, so the
    // calendar must cover the whole horizon, not just the effective month.
    const calendar = (await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where org_id=${fixture.orgId} limit 1`)).rows[0]!.id;
    for (let y = 2026; y <= 2027; y++) {
      for (let m = y === 2026 ? 8 : 1; m <= (y === 2026 ? 12 : 6); m++) {
        const last = new Date(y, m, 0).getDate();
        const mm = String(m).padStart(2, "0");
        await db.execute(sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,custom) values(${randomUUID()},${fixture.orgId},${calendar},${y},${m},${`${y}-${mm}`},${`${y}-${mm}-01`},${`${y}-${mm}-${last}`},false,'{}'::jsonb)`);
      }
    }
    const clearing = (await db.execute<{ id: string }>(sql`select id from accounts where org_id=${fixture.orgId} limit 1`)).rows[0]!.id;
    await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${fixture.orgId},${actors.submitterId},'assets.manage','grant')`);
    await seedApprovalFlow(fixture.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    const input: AssetChangeInput = {
      operation: "partial_disposal",
      effectiveOn: fixture.date,
      reason: "Sold one quarter of the homogeneous production fixtures",
      assessment: "Identical components have equal cost and service; one quarter is derecognized",
      idempotencyKey: randomUUID(),
      portion: { percent: "25" },
      proceeds: "600",
      proceedsAccountId: clearing,
    };
    const changeId = await proposeAssetChange(fixture.orgId, fixture.assetId, actors.submitterId, input);
    await submitFinancialChange(fixture.orgId, changeId, actors.submitterId);
    const gate = (await db.execute<{ id: string }>(sql`select id from flow_gates where org_id=${fixture.orgId} and subject_id=${changeId} and status='pending'`)).rows[0]!;
    await decideGate({ gateId: gate.id, userId: actors.approver1Id, decision: "approved" });
    await applyAssetChange(fixture.orgId, changeId, actors.submitterId);
    const owned = (await db.execute<{ id: string }>(sql`select id from asset_events where org_id=${fixture.orgId} and asset_id=${fixture.assetId} and financial_change_id=${changeId} limit 1`)).rows[0];
    assert.ok(owned, "the approved change must own a lifecycle event");

    authed(fixture);
    const listing = await GET(getRequest(fixture), { params: Promise.resolve({ id: fixture.assetId }) });
    assert.equal(listing.status, 200);
    const listed = ((await listing.json()) as { events: { id: string; reversible: boolean; blockReason: string | null }[] })
      .events.find((e) => e.id === owned!.id);
    assert.equal(listed?.reversible, false);
    assert.equal(listed?.blockReason, "accounting_change");

    const before = await writeCounts(fixture.orgId, fixture.assetId);
    const refused = await POST(
      postRequest(fixture, { eventId: owned!.id, date: fixture.date, reason: "Bypass the change reversal workflow" }),
      { params: Promise.resolve({ id: fixture.assetId }) },
    );
    assert.equal(refused.status, 422);
    assert.match(((await refused.json()) as { error: string }).error, /Accounting changes/);
    assert.deepEqual(await writeCounts(fixture.orgId, fixture.assetId), before);
  } finally {
    routeState.authz = null;
    await dropScratchOrgReporting(fixture.orgId);
  }
});
