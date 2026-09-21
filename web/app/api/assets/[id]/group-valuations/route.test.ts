import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const state = { allowed: true, calls: [] as unknown[][], refusal: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("asset-group-valuation-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // Resolve framework imports against this real file, not the virtual auth URL.
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return next(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return {
        shortCircuit: true,
        url: "mock:asset-group-valuation-route-auth",
      };
    if (specifier === "@openbooks/engine/src/assets/group-valuations.ts")
      return {
        shortCircuit: true,
        url: "mock:asset-group-valuation-route-domain",
      };
    if (specifier === "@openbooks/engine/src/platform/db.ts")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const db={execute:async()=>({rows:[]})}",
      };
    if (specifier === "@/lib/api/json")
      return next(
        new URL("../../../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    if (specifier === "@/lib/list-params")
      return next(
        new URL("../../../../../lib/list-params.ts", import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:asset-group-valuation-route-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(){return globalThis[Symbol.for('asset-group-valuation-route')].allowed?{user:{id:'actor',orgId:'org'},allowedSubsidiaryIds:null}:NextResponse.json({error:'missing permission'},{status:403})}`,
      };
    if (url === "mock:asset-group-valuation-route-domain")
      return {
        shortCircuit: true,
        format: "module",
        source: `export async function proposeAssetGroupValuation(...args){const s=globalThis[Symbol.for('asset-group-valuation-route')];s.calls.push(args);if(s.refusal)throw new Error(s.refusal);return 'change'}`,
      };
    return next(url, context);
  },
});
const route = await import("./route.ts");
hooks.deregister();
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new Request("http://openbooks.test/change", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = {
  sourceEventId: id,
  effectiveOn: "2026-08-31",
  carryingValue: "1000.0000",
  buyerToGroupRate: "1",
  assessment: "Recoverability remains above historical group basis",
  reason: "Measure the group valuation independently",
  idempotencyKey: "group-1",
  remainingPlan: [{ date: "2026-09-30", amount: "1000.0000" }],
};
test("real group valuation proposal schema preserves money and authenticated identity", async () => {
  state.calls = [];
  state.refusal = "";
  state.allowed = true;
  const r = await route.POST(request(valid), context);
  assert.equal(r.status, 201);
  assert.deepEqual(state.calls[0], ["org", id, "actor", valid]);
});
test("invalid group amounts, source and dates never reach the domain", async () => {
  for (const patch of [
    { effectiveOn: "2026-02-30" },
    { carryingValue: "12,34" },
    { carryingValue: "1.00001" },
    { sourceEventId: "wrong" },
    { assessment: "" },
    { remainingPlan: [{ date: "2026-09-31", amount: "1000" }] },
  ]) {
    state.allowed = true;
    state.calls = [];
    const r = await route.POST(request({ ...valid, ...patch }), context);
    assert.equal(r.status, 422);
    assert.equal(state.calls.length, 0);
  }
});
test("group valuation refusals survive the boundary and permission denial cannot call the command", async () => {
  state.allowed = true;
  state.refusal = "Post elapsed depreciation before changing its basis";
  const r = await route.POST(request(valid), context);
  assert.equal(r.status, 422);
  assert.equal((await r.json()).error, state.refusal);
  state.allowed = false;
  state.calls = [];
  assert.equal((await route.POST(request(valid), context)).status, 403);
  assert.equal(state.calls.length, 0);
  state.allowed = true;
  state.refusal = "";
});
