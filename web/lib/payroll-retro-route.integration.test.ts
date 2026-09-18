import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "./authz";

const state: { gate: Authz | null } = { gate: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.payroll-retro-route")] = state;
// The route imports the JSON boundary through the web `@/` alias, which tsx
// resolves only under the web tsconfig. Map it to the real module so the
// route under test runs its production body parsing.
const apiJsonUrl = new URL("./api/json.ts", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "@/lib/api/json") return { shortCircuit: true, url: apiJsonUrl };
  if (specifier === "../../../../lib/feature-gates" && decodeURIComponent(context.parentURL ?? "").endsWith("/api/payroll/retro/route.ts")) {
    return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
      "export async function guardFeaturePermission(){return globalThis[Symbol.for('openbooks.payroll-retro-route')].gate}") };
  }
  return next(specifier, context);
} });
const { seedAdoption } = await import("@openbooks/engine/src/payroll-filing-test-fixtures.ts");
const { dropScratchOrgReporting } = await import("@openbooks/engine/src/test-fixtures.ts");
const { withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { POST } = await import("../app/api/payroll/retro/route");

/**
 * The retro workspace always sends `excludeSourcePayRunDocumentIds: []`
 * (its initial exclusion state), so the route must read an empty list as
 * "nothing excluded" — the same as an absent key. Refusing [] with 422
 * breaks every UI propose that excludes nothing, which is nearly all of
 * them. Same for an explicitly empty employeePartyIds.
 */

function runGate(fx: { orgId: string; actorId: string }): Authz {
  return {
    user: { orgId: fx.orgId, id: fx.actorId },
    permissions: new Set(["payroll.run"]),
    allowedSubsidiaryIds: null,
  } as Authz;
}

async function propose(body: Record<string, unknown>) {
  return POST(
    new Request("https://openbooks.test/api/payroll/retro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("propose accepts an explicitly empty exclusion list", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    // The route reads schedules/runs through RLS; the mocked gate only
    // supplies identity, so run the call under the org scope the real
    // middleware would set.
    const res = await withOrgContext(fx.orgId, () => propose({
      action: "propose",
      payScheduleId: fx.scheduleId,
      payDate: "2026-07-21",
      excludeSourcePayRunDocumentIds: [],
    }));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
    const body = await res.json() as { payableTotal: string };
    assert.equal(body.payableTotal, "0.0000");
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("propose still refuses malformed lists", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    for (const body of [
      { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", excludeSourcePayRunDocumentIds: ["nope"] },
      { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", excludeSourcePayRunDocumentIds: "nope" },
      { action: "propose", payScheduleId: fx.scheduleId, payDate: "2026-07-21", employeePartyIds: ["nope"] },
    ]) {
      const res = await propose(body);
      assert.equal(res.status, 422, JSON.stringify(await res.clone().json()).slice(0, 200));
    }
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});

test("propose accepts an explicitly empty employee list", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const fx = await withBypassContext(() => seedAdoption());
  try {
    state.gate = runGate(fx);
    const res = await withOrgContext(fx.orgId, () => propose({
      action: "propose",
      payScheduleId: fx.scheduleId,
      payDate: "2026-07-21",
      employeePartyIds: [],
    }));
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()).slice(0, 300));
  } finally { state.gate = null; await dropScratchOrgReporting(fx.orgId); }
});
