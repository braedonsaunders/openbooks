import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const state = {
  allowed: true,
  featureEnabled: true,
  gateArgs: [] as string[],
  calls: [] as unknown[][],
  refusal: "",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("revenue-modification-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // Resolve framework imports against this real file, not the virtual auth URL.
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return next(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:revenue-change-auth" };
    if (specifier === "@openbooks/engine/src/revenue/contract-modifications.ts")
      return { shortCircuit: true, url: "mock:revenue-change-command" };
    if (specifier === "@/lib/api/json")
      return next(
        new URL("../../../../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    if (specifier === "@/lib/list-params")
      return next(
        new URL("../../../../../../lib/list-params.ts", import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:revenue-change-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(...args){const s=globalThis[Symbol.for('revenue-modification-route')];s.gateArgs=args;if(!s.allowed)return NextResponse.json({error:'missing permission'},{status:403});if(!s.featureEnabled)return NextResponse.json({error:'not found'},{status:404});return {user:{id:'actor',orgId:'org'}}}`,
      };
    if (url === "mock:revenue-change-command")
      return {
        shortCircuit: true,
        format: "module",
        source: `export async function proposeRevenueModification(...args){const s=globalThis[Symbol.for('revenue-modification-route')];s.calls.push(args);if(s.refusal)throw new Error(s.refusal);return {changeId:'change'}}`,
      };
    return next(url, context);
  },
});
const route = await import("./route.ts");
hooks.deregister();
const id = "00000000-0000-4000-8000-000000000001";
const valid = {
  effectiveOn: "2026-08-01",
  reason: "Signed scope change",
  idempotencyKey: "request-1",
  subsidiaryId: id,
  enforceableRightsEvidence: "The parties signed amended obligations",
  assessment: "Remaining services are distinct, same functional currency",
  bookRates: [{ bookId: id, fxRate: "1" }],
  groups: [
    {
      treatment: "prospective",
      existingObligationIds: [id],
      considerationChange: "600.0000",
      remainingDistinct: true,
      additionsAtStandalonePrice: false,
      promises: [
        {
          existingId: id,
          description: "Remaining service",
          standaloneSellingPrice: "2600.0000",
          recognitionRuleId: id,
          recognitionEndsOn: "2026-12-31",
          percentComplete: "25.0000",
          deferredAccountId: id,
          recognizedAccountId: id,
        },
      ],
    },
  ],
};
const request = (body: unknown) =>
  new Request("http://openbooks.test/api/revenue/contracts/x/modifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const context = { params: Promise.resolve({ id }) };
test("the actual JSON and decimal schemas preserve a signed amendment and pass authenticated identity", async () => {
  state.allowed = true;
  state.refusal = "";
  state.calls = [];
  const res = await route.POST(request(valid), context);
  assert.equal(res.status, 200);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]![0], "org");
  assert.equal(state.calls[0]![2], "actor");
  assert.deepEqual(state.calls[0]![3], valid);
  assert.deepEqual(state.gateArgs, ["ar.post", "revenueRecognition"]);
});

test("disabled revenue recognition refuses before body parsing or proposing an amendment", async () => {
  state.allowed = true;
  state.featureEnabled = false;
  state.calls = [];
  try {
    const response = await route.POST(
      new Request(
        "http://openbooks.test/api/revenue/contracts/x/modifications",
        { method: "POST", body: "malformed JSON" },
      ),
      context,
    );
    assert.equal(response.status, 404);
    assert.deepEqual(state.gateArgs, ["ar.post", "revenueRecognition"]);
    assert.equal(state.calls.length, 0);
  } finally {
    state.featureEnabled = true;
  }
});
test("malformed scope, dates, decimals and evidence never reach the domain command", async () => {
  for (const patch of [
    { effectiveOn: "2026-02-30" },
    { subsidiaryId: "not-a-uuid" },
    { reason: "no" },
    { groups: [] },
    { groups: [{ ...valid.groups[0], considerationChange: "12,34" }] },
    { groups: [{ ...valid.groups[0], considerationChange: "0.00001" }] },
    { enforceableRightsEvidence: "" },
  ]) {
    state.allowed = true;
    state.refusal = "";
    state.calls = [];
    const res = await route.POST(request({ ...valid, ...patch }), context);
    assert.equal(res.status, 422);
    assert.equal(state.calls.length, 0);
  }
});
test("an accounting refusal is returned intact and unauthorized requests cannot create proposals", async () => {
  state.allowed = true;
  state.calls = [];
  state.refusal = "The record changed after approval; create a new proposal";
  const res = await route.POST(request(valid), context);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: string }).error, state.refusal);
  state.allowed = false;
  state.calls = [];
  const forbidden = await route.POST(request(valid), context);
  assert.equal(forbidden.status, 403);
  assert.equal(state.calls.length, 0);
  state.allowed = true;
  state.refusal = "";
});
