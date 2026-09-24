import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-set-scope-diff")] = state;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-set-scope-diff')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createPayRun } = await import("@openbooks/engine/src/payroll/run-lifecycle.ts"), { seedPayrollComponents } = await import("@openbooks/engine/src/payroll/run-setup.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST } = await import("../app/api/payroll/runs/[id]/route");

/**
 * set-scope against a roster holding a deactivated employee — the persona
 * replay for item 43 — plus the diff proof: members whose scope is not
 * changing are never re-validated and never rewritten.
 *
 * Real route, real engine, real database; only the feature gate is stubbed.
 */

interface ScopeFixture {
  orgId: string;
  actorId: string;
  documentId: string;
  activeId: string;
  deactivatedId: string;
}

async function scopeFixture(): Promise<ScopeFixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      features: { payroll: true },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId, "CA");
  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values
      (${scheduleId}, ${org.orgId}, 'Scope Schedule', 'biweekly', 26, '2026-07-18',
       3, true, ${actorId}, ${actorId})
  `);
  const activeId = randomUUID();
  const deactivatedId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${activeId}, ${org.orgId}, 'person', 'Scope Active', true, '{}'::jsonb),
           (${deactivatedId}, ${org.orgId}, 'person', 'Scope Deactivated', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into employee_payroll_profiles
      (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
       federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
    values
      (${org.orgId}, ${activeId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId}),
      (${org.orgId}, ${deactivatedId}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId})
  `);
  const run = await createPayRun({
    orgId: org.orgId,
    actorId,
    payScheduleId: scheduleId,
    periodStart: "2026-07-05",
    periodEnd: "2026-07-18",
  });
  return { orgId: org.orgId, actorId, documentId: run.documentId, activeId, deactivatedId };
}

async function deactivate(orgId: string, employeeId: string): Promise<void> {
  // Actions → Deactivate, the product's own supported remedy.
  await withBypassContext(() => db.execute(sql`
    update parties set is_active = false where org_id = ${orgId} and id = ${employeeId}`));
}

async function adjustmentSnapshot(orgId: string, documentId: string): Promise<unknown> {
  return (await withOrgContext(orgId, () => db.execute<{ state: unknown }>(sql`select jsonb_build_object(
    'run',(select to_jsonb(r) from pay_runs r where org_id=${orgId} and document_id=${documentId}),
    'adjustments',(select jsonb_agg(to_jsonb(a) order by employee_party_id, adjustment_type)
                     from pay_run_adjustments a where org_id=${orgId} and pay_run_document_id=${documentId})
    ) as state`))).rows[0]!.state;
}

function send(fx: Pick<ScopeFixture, "orgId" | "documentId">, body: Record<string, unknown>): Promise<Response> {
  return withOrgContext(fx.orgId, () => POST(new Request("https://openbooks.test/api/payroll/runs/fixture", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: fx.documentId }) }));
}

async function setup(): Promise<ScopeFixture> {
  const fx = await withBypassContext(() => scopeFixture());
  state.gate = {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set(["payroll.run"]),
    allowedSubsidiaryIds: null,
  } as Authz;
  return fx;
}

test("set-scope removes a deactivated roster member instead of rolling back 422", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await setup();
  try {
    await deactivate(fx.orgId, fx.deactivatedId);
    const response = await send(fx, {
      action: "set-scope",
      employeePartyIds: [fx.activeId],
      rosterPartyIds: [fx.activeId, fx.deactivatedId],
    });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    // True deltas: the active member stays (no change), the deactivated one
    // is newly excluded — not an echo of the input lists.
    assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 1 });
    const excluded = await withOrgContext(fx.orgId, () => db.execute<{ employee_party_id: string }>(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${fx.orgId} and pay_run_document_id = ${fx.documentId}
         and adjustment_type = 'exclude'`));
    assert.deepEqual(excluded.rows, [{ employee_party_id: fx.deactivatedId }]);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("set-scope still refuses to re-add a deactivated member, naming them", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await setup();
  try {
    await deactivate(fx.orgId, fx.deactivatedId);
    // First remove them (the newly permitted direction), so re-adding is an
    // actual change the mutator must validate.
    const removed = await send(fx, {
      action: "set-scope",
      employeePartyIds: [fx.activeId],
      rosterPartyIds: [fx.activeId, fx.deactivatedId],
    });
    assert.equal(removed.status, 200);
    const before = await adjustmentSnapshot(fx.orgId, fx.documentId);
    const response = await send(fx, {
      action: "set-scope",
      employeePartyIds: [fx.activeId, fx.deactivatedId],
      rosterPartyIds: [fx.activeId, fx.deactivatedId],
    });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /employee "Scope Deactivated" is not an active member/);
    assert.match(body.error, /deactivated/);
    assert.deepEqual(await adjustmentSnapshot(fx.orgId, fx.documentId), before, "refusal must commit nothing");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("set-scope replays nothing when the requested scope already holds", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await setup();
  try {
    await deactivate(fx.orgId, fx.deactivatedId);
    const first = await send(fx, {
      action: "set-scope",
      employeePartyIds: [fx.activeId],
      rosterPartyIds: [fx.activeId, fx.deactivatedId],
    });
    assert.equal(first.status, 200);
    const before = await adjustmentSnapshot(fx.orgId, fx.documentId);
    // Identical request: both members are staying where they are, so no
    // mutation runs — the deactivated member is never re-validated.
    const second = await send(fx, {
      action: "set-scope",
      employeePartyIds: [fx.activeId],
      rosterPartyIds: [fx.activeId, fx.deactivatedId],
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true, included: 0, excluded: 0 });
    assert.deepEqual(await adjustmentSnapshot(fx.orgId, fx.documentId), before, "a no-change scope must write nothing");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("set-scope on an empty roster is a no-op", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await setup();
  try {
    const response = await send(fx, { action: "set-scope", employeePartyIds: [], rosterPartyIds: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 0 });
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("set-scope reports true deltas, and an off-roster keep id is refused by name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // The input-echo defect: the response counted the request lists
  // ({included: keep.size}), so a roster of 10 with 3 already excluded and a
  // keep of 5 reported {included: 5, excluded: 5} while only 2 memberships
  // changed — and keep ids that are not on the roster at all were counted as
  // included although nothing was written for them.
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const fx = await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({ features: { payroll: true } })}::jsonb
       where id = ${org.orgId}`);
    await seedPayrollComponents(org.orgId, actorId, "CA");
    const scheduleId = randomUUID();
    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active, created_by, updated_by)
      values
        (${scheduleId}, ${org.orgId}, 'Scope Schedule', 'biweekly', 26, '2026-07-18',
         3, true, ${actorId}, ${actorId})`);
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      const id = randomUUID();
      ids.push(id);
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${id}, ${org.orgId}, 'person', ${`Scope ${n}`}, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_payroll_profiles
          (org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
           federal_claim_code, provincial_claim_code, is_active, created_by, updated_by)
        values
          (${org.orgId}, ${id}, ${scheduleId}, 'CA', 'ON', 'salary', 1, 1, true, ${actorId}, ${actorId})`);
    }
    const run = await createPayRun({
      orgId: org.orgId, actorId, payScheduleId: scheduleId,
      periodStart: "2026-07-05", periodEnd: "2026-07-18",
    });
    return { orgId: org.orgId, actorId, documentId: run.documentId, roster: ids };
  });
  state.gate = {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set(["payroll.run"]),
    allowedSubsidiaryIds: null,
  } as Authz;
  try {
    // Three already excluded: only memberships that actually change count.
    const seed = await send(fx, {
      action: "set-scope",
      employeePartyIds: fx.roster.slice(3),
      rosterPartyIds: fx.roster,
    });
    assert.equal(seed.status, 200);
    assert.deepEqual(await seed.json(), { ok: true, included: 0, excluded: 3 });
    // Keep 5 of the 7 included: exactly 2 memberships change.
    const response = await send(fx, {
      action: "set-scope",
      employeePartyIds: fx.roster.slice(3, 8),
      rosterPartyIds: fx.roster,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, included: 0, excluded: 2 });

    // A keep id that is not on the roster is refused naming it — it used to
    // be counted as included while nothing was written for it.
    const stranger = randomUUID();
    const refused = await send(fx, {
      action: "set-scope",
      employeePartyIds: [...fx.roster.slice(3, 8), stranger],
      rosterPartyIds: fx.roster,
    });
    assert.equal(refused.status, 422);
    const body = (await refused.json()) as { error: string };
    assert.ok(body.error.includes(stranger), "the refusal names the off-roster id");
    assert.match(body.error, /not on this run's roster/);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
