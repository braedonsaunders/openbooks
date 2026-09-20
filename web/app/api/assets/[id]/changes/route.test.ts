import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const state = { allowed: true, calls: [] as unknown[][], refusal: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("asset-change-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:asset-change-route-auth" };
    if (specifier === "@openbooks/engine/src/assets/asset-changes.ts")
      return { shortCircuit: true, url: "mock:asset-change-route-domain" };
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
    if (url === "mock:asset-change-route-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(){return globalThis[Symbol.for('asset-change-route')].allowed?{user:{id:'actor',orgId:'org'},allowedSubsidiaryIds:null}:NextResponse.json({error:'missing permission'},{status:403})}`,
      };
    if (url === "mock:asset-change-route-domain")
      return {
        shortCircuit: true,
        format: "module",
        source: `export async function proposeAssetChange(...args){const s=globalThis[Symbol.for('asset-change-route')];s.calls.push(args);if(s.refusal)throw new Error(s.refusal);return 'change'}`,
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
  operation: "partial_disposal",
  effectiveOn: "2026-08-01",
  reason: "Dispose the identified component",
  idempotencyKey: "asset-1",
  assessment: "Identical components share the same service history",
  portion: { percent: "25.0000" },
  proceeds: "600.0000",
  proceedsAccountId: id,
};
test("real asset proposal schema preserves money and authenticated identity", async () => {
  state.calls = [];
  state.refusal = "";
  state.allowed = true;
  const r = await route.POST(request(valid), context);
  assert.equal(r.status, 200);
  assert.deepEqual(state.calls[0], ["org", id, "actor", valid]);
});
test("invalid asset amounts, scope and dates never reach the domain", async () => {
  for (const patch of [
    { effectiveOn: "2026-02-30" },
    { proceeds: "12,34" },
    { proceeds: "1.00001" },
    { proceedsAccountId: "wrong" },
    { portion: { books: [] } },
    { assessment: "" },
  ]) {
    state.allowed = true;
    state.calls = [];
    const r = await route.POST(request({ ...valid, ...patch }), context);
    assert.equal(r.status, 422);
    assert.equal(state.calls.length, 0);
  }
});
test("asset refusals survive the boundary and permission denial cannot call the command", async () => {
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

test("group component amounts and service reach the actual proposal schema without coercion", async () => {
  state.calls = [];
  state.allowed = true;
  state.refusal = "";
  const group = {
    cost: "1200.0000",
    accumulated: "900.0000",
    salvage: "0.0000",
    remainingPlan: [{ date: "2026-09-30", amount: "700.0000" }],
    unimpairedAccumulated: "850.0000",
    unimpairedRemainingPlan: [{ date: "2026-09-30", amount: "750.0000" }],
    unimpairedRemovedPlan: [{ date: "2026-09-30", amount: "350.0000" }],
  };
  const body = {
    ...valid,
    portion: {
      books: [
        {
          bookId: id,
          cost: "600.0000",
          accumulated: "400.0000",
          salvage: "0.0000",
          group,
        },
      ],
    },
  };
  assert.equal((await route.POST(request(body), context)).status, 200);
  assert.deepEqual(state.calls[0]![3], body);
  state.calls = [];
  const invalid = {
    ...body,
    portion: {
      books: [{ ...body.portion.books[0], group: { ...group, cost: "1,200" } }],
    },
  };
  assert.equal((await route.POST(request(invalid), context)).status, 422);
  assert.equal(state.calls.length, 0);
});
