import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const state = { allowed: true, calls: [] as unknown[][], refusal: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("tax-basis-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:tax-basis-route-auth" };
    if (specifier === "@openbooks/engine/src/tax-returns/asset-basis-workpaper.ts")
      return { shortCircuit: true, url: "mock:tax-basis-route-domain" };
    if (specifier === "@openbooks/engine/src/tax-returns/asset-basis-policy.ts")
      return next(
        new URL(
          "../../../../../../engine/src/tax-returns/asset-basis-policy.ts",
          import.meta.url,
        ).href,
        context,
      );
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
    if (url === "mock:tax-basis-route-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(){return globalThis[Symbol.for('tax-basis-route')].allowed?{user:{id:'actor',orgId:'org'},allowedSubsidiaryIds:null}:NextResponse.json({error:'missing permission'},{status:403})}`,
      };
    if (url === "mock:tax-basis-route-domain")
      return {
        shortCircuit: true,
        format: "module",
        source: `export class TaxAssetBasisError extends Error { readonly name='TaxAssetBasisError' }
        export async function listTaxAssetBasisSources(...args){const s=globalThis[Symbol.for('tax-basis-route')];s.calls.push(['list',...args]);if(s.refusal)throw new Error(s.refusal);return {assetId:args[1],assetNumber:'FA-1',sources:[]}}
        export async function proposeTaxAssetBasis(...args){const s=globalThis[Symbol.for('tax-basis-route')];s.calls.push(['propose',...args]);if(s.refusal)throw new Error(s.refusal);return 'change'}`,
      };
    return next(url, context);
  },
});
const route = await import("./route.ts");
hooks.deregister();
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new Request("http://openbooks.test/tax-basis", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const valid = {
  sourceChangeId: id,
  reason: "Record the statutory disposal basis",
  assessment: "NAL worksheet and contemporaneous FMV appraisal",
  idempotencyKey: "tax-1",
  regimes: [
    {
      regime: "ca_cca",
      relationship: "arms_length",
      originalCapitalCost: "10000.00",
    },
  ],
};

test("tax basis proposal preserves source, regimes and authenticated identity", async () => {
  state.calls = [];
  state.refusal = "";
  state.allowed = true;
  const r = await route.POST(request(valid), context);
  assert.equal(r.status, 201);
  assert.deepEqual(state.calls[0], ["propose", "org", id, "actor", valid]);
});

test("null sourceChangeId is accepted for a legacy event and reaches the domain", async () => {
  state.calls = [];
  state.refusal = "";
  const body = {
    ...valid,
    sourceChangeId: null,
    sourceEventId: id,
  };
  const r = await route.POST(request(body), context);
  assert.equal(r.status, 201);
  assert.deepEqual(state.calls[0], ["propose", "org", id, "actor", body]);
});

test("malformed source ids never reach the domain", async () => {
  state.calls = [];
  state.allowed = true;
  const r = await route.POST(request({ ...valid, sourceChangeId: "not-a-uuid" }), context);
  assert.equal(r.status, 422);
  assert.equal(state.calls.length, 0);
});

test("named domain refusals survive the boundary and permission denial cannot call the command", async () => {
  state.allowed = true;
  state.refusal = "sourceOperation is required to decide buyer-side facts";
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
