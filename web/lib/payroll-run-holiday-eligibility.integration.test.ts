import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-run-holiday-eligibility")] = state;
// The route imports the JSON boundary through the web `@/` alias, which tsx
// resolves only under the web tsconfig. Map it to the real module so the
// route under test runs its production body parsing.
const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
// Fleet worktrees carry a real (copied) root node_modules, so engine imports
// resolve inside this worktree already; only web-only shims need rewriting.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
  if (specifier === "../../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/runs/[id]/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-run-holiday-eligibility')].gate}") };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { seedAdoption } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { createPayRun } = await import("@openbooks/engine/src/payroll-run.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { POST } = await import("../app/api/payroll/runs/[id]/route");

/**
 * A web-driven pay run spanning a paid statutory holiday must be calculable:
 * the engine demands explicit employer attestations (commission status /
 * last-and-first-shift absence) wherever a declaring rule reads them, so the
 * calculate/dry-run actions must accept that fact map and pass it through.
 * Without it, every December run in a declaring jurisdiction fails closed
 * with no remedy the UI or API can offer.
 */

function runGate(fx: { orgId: string; actorId: string }): Authz {
  return {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set(["payroll.run"]),
    allowedSubsidiaryIds: null,
  } as Authz;
}

async function christmasRun(fx: Awaited<ReturnType<typeof seedAdoption>>) {
  // Mirror a pack-installed tenant: the first install-pack enables statutory
  // holiday pay, without which the engine skips the holiday path entirely
  // and no attestation is ever demanded (a vacuous pass).
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(settings, '{payroll,statutoryHolidayPay}', 'true')
     where id = ${fx.orgId}`);
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
      is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${fx.employeeId}, '2025-12-22', 8, 'approved', false,
      'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);
  // Explicit period: Christmas Day 2025 lands inside it, so Ontario's
  // last-and-first-shift rule demands the absence assertion.
  return createPayRun({
    orgId: fx.orgId,
    actorId: fx.actorId,
    payScheduleId: fx.scheduleId,
    periodStart: "2025-12-21",
    periodEnd: "2026-01-03",
  });
}

async function calculate(documentId: string, body: Record<string, unknown>) {
  return POST(
    new Request("https://openbooks.test/api/payroll/runs/fixture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
}

test("calculate without attestations reports the statutory-holiday demand", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    const res = await calculate(documentId, { action: "calculate" });
    assert.equal(res.status, 200);
    const body = await res.json() as { errors: { employee: string; message: string }[] };
    assert.ok(
      body.errors.some((e) => e.message.includes("last-and-first-shift")),
      `expected the absence-assertion demand, got ${JSON.stringify(body.errors)}`,
    );
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("calculate accepts holidayEligibility and clears the demand", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    const res = await calculate(documentId, {
      action: "calculate",
      holidayEligibility: { [fx.employeeId]: { absentWithoutConsent: false } },
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 500));
    const body = await res.json() as { ok: boolean; errors: { message: string }[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.errors, []);
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("calculate refuses malformed holidayEligibility", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await seedAdoption();
  try {
    state.gate = runGate(fx);
    const { documentId } = await christmasRun(fx);
    for (const bad of [
      { "not-a-uuid": { absentWithoutConsent: false } },
      { [fx.employeeId]: { absentWithoutConsent: "no" } },
      { [fx.employeeId]: { paidOnCommission: 1 } },
      { [fx.employeeId]: { frobnicated: true } },
    ]) {
      const res = await calculate(documentId, { action: "calculate", holidayEligibility: bad });
      assert.equal(res.status, 422, JSON.stringify(await res.clone().json()).slice(0, 300));
    }
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
