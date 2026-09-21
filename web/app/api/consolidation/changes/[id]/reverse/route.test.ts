import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = {
  enabled: true,
  allowed: true,
  domain: "consolidation",
  gateArgs: [] as string[],
  authorizations: [] as string[],
  calls: [] as unknown[][],
  refusal: "",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("control-loss-reversal-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return next(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:control-loss-reversal-gate" };
    if (specifier === "@/app/api/accounting/changes/_authorization")
      return {
        shortCircuit: true,
        url: "mock:control-loss-reversal-authority",
      };
    if (specifier === "@openbooks/engine/src/consolidation/loss-of-control.ts")
      return { shortCircuit: true, url: "mock:control-loss-reversal-command" };
    if (specifier === "@/lib/api/json")
      return next(
        new URL("../../../../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:control-loss-reversal-gate")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(...args){const s=globalThis[Symbol.for('control-loss-reversal-route')];s.gateArgs=args;return s.enabled?{user:{id:'actor',orgId:'org'}}:NextResponse.json({error:'not found'},{status:404})}`,
      };
    if (url === "mock:control-loss-reversal-authority")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function authorizeChange(id){const s=globalThis[Symbol.for('control-loss-reversal-route')];s.authorizations.push(id);return s.allowed?{auth:{user:{id:'actor',orgId:'org'}},domain:s.domain}:NextResponse.json({error:'change not found'},{status:404})}`,
      };
    if (url === "mock:control-loss-reversal-command")
      return {
        shortCircuit: true,
        format: "module",
        source: `export async function proposeLossOfControlReversal(...args){const s=globalThis[Symbol.for('control-loss-reversal-route')];s.calls.push(args);if(s.refusal)throw new Error(s.refusal);return 'reversal-proposal'}`,
      };
    return next(url, context);
  },
});
const route = await import("./route.ts");
hooks.deregister();
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new Request("http://openbooks.test/api/consolidation/changes/x/reverse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const body = {
  reason: "Correct the approved loss of control assessment",
  idempotencyKey: "reversal-request",
};
const reset = () =>
  Object.assign(state, {
    enabled: true,
    allowed: true,
    domain: "consolidation",
    gateArgs: [],
    authorizations: [],
    calls: [],
    refusal: "",
  });

test("disabled consolidation is refused before record authorization, parsing or reversal", async () => {
  reset();
  state.enabled = false;
  const response = await route.POST(
    new Request("http://openbooks.test/api/consolidation/changes/x/reverse", {
      method: "POST",
      body: "malformed JSON",
    }),
    context,
  );
  assert.equal(response.status, 404);
  assert.deepEqual(state.gateArgs, ["close.run", "multiSubsidiary"]);
  assert.deepEqual(state.authorizations, []);
  assert.deepEqual(state.calls, []);
});

test("enabled reversal retains subject authorization and the real reason schema", async () => {
  reset();
  const response = await route.POST(request(body), context);
  assert.equal(response.status, 200);
  assert.deepEqual(state.authorizations, [id]);
  assert.deepEqual(state.calls, [
    ["org", id, "actor", body.reason, body.idempotencyKey],
  ]);
  for (const invalid of [
    { ...body, reason: "no" },
    { ...body, idempotencyKey: "" },
  ]) {
    state.calls = [];
    assert.equal((await route.POST(request(invalid), context)).status, 422);
    assert.deepEqual(state.calls, []);
  }
  state.allowed = false;
  assert.equal((await route.POST(request(body), context)).status, 404);
  assert.deepEqual(state.calls, []);
});

test("a different accounting domain cannot use this reversal and financial refusals stay intact", async () => {
  reset();
  state.domain = "asset";
  assert.equal((await route.POST(request(body), context)).status, 422);
  assert.deepEqual(state.calls, []);
  state.domain = "consolidation";
  state.refusal = "The record changed after approval; create a new proposal";
  const response = await route.POST(request(body), context);
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, state.refusal);
});
