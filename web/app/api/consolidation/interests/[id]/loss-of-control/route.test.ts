import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const state = { allowed: true, calls: [] as unknown[][], refusal: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("control-loss-route")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // Resolve framework imports against this real file, not the virtual auth URL.
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return next(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:control-loss-route-auth" };
    if (specifier === "@openbooks/engine/src/consolidation/loss-of-control.ts")
      return { shortCircuit: true, url: "mock:control-loss-route-domain" };
    if (specifier === "@openbooks/engine/src/platform/db.ts")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const db={execute:async()=>({rows:[]})}",
      };
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
    if (url === "mock:control-loss-route-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';export async function guardFeaturePermission(){return globalThis[Symbol.for('control-loss-route')].allowed?{user:{id:'actor',orgId:'org'},allowedSubsidiaryIds:null}:NextResponse.json({error:'missing permission'},{status:403})}`,
      };
    if (url === "mock:control-loss-route-domain")
      return {
        shortCircuit: true,
        format: "module",
        source: `export class LossOfControlProposalError extends Error{constructor(status,message){super(message);this.status=status}}export async function loadLossOfControlProposalData(...args){const s=globalThis[Symbol.for('control-loss-route')];s.calls.push(args);if(s.refusal)throw new LossOfControlProposalError(404,s.refusal);return {proposal:true}}export async function proposeLossOfControl(...args){const s=globalThis[Symbol.for('control-loss-route')];s.calls.push(args);if(s.refusal)throw new Error(s.refusal);return 'change'}`,
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
  effectiveOn: "2026-07-20",
  reason: "Disposal of controlling interest",
  idempotencyKey: "loss-1",
  assessment: "Control ceases under the signed agreement",
  ociAssessment: "Reserve balances attributed to the parent",
  eliminationSubsidiaryId: id,
  proceeds: "1050.0000",
  proceedsAccountId: id,
  parentInvestmentCarrying: "900.0000",
  parentRetainedCarrying: "0.0000",
  parentToGroupRate: "1",
  investmentTranslationAccountId: id,
  retainedFairValue: "0.0000",
  retainedPercent: "0.0000",
  retainedMethod: "none",
  retainedAccountId: id,
  gainLossAccountId: id,
  parentGainLossAccountId: id,
  equityIncomeAccountId: id,
  distributionAccountId: null,
  distributionIncomeAccountId: null,
  rates: [{ subsidiaryId: id, rate: "1" }],
  additionalConsolidationLines: [],
  oci: [
    {
      accountId: id,
      balance: "-20.0000",
      treatment: "profit_loss",
      destinationAccountId: id,
      description: "Translation reserve",
    },
  ],
};
test("real loss-of-control schema preserves signed reserve evidence", async () => {
  state.calls = [];
  state.refusal = "";
  state.allowed = true;
  const r = await route.POST(request(valid), context);
  assert.equal(r.status, 200);
  assert.deepEqual(state.calls[0], ["org", id, "actor", valid]);
});
test("unreadable amounts and malformed control-loss evidence are refused before the command", async () => {
  for (const patch of [
    { proceeds: "12,34" },
    { proceeds: "1.00001" },
    { rates: [] },
    { effectiveOn: "2026-02-30" },
    { retainedMethod: "full" },
    { ociAssessment: "" },
    { additionalConsolidationLines: [{ lineId: "wrong", amount: "5" }] },
  ]) {
    state.calls = [];
    const r = await route.POST(request({ ...valid, ...patch }), context);
    assert.equal(r.status, 422);
    assert.equal(state.calls.length, 0);
  }
});
test("proposal data passes through and proposal refusals keep their status", async () => {
  state.calls = [];
  state.refusal = "";
  state.allowed = true;
  const ok = await route.GET(new Request("http://openbooks.test/x"), context);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { proposal: true });
  state.refusal = "ownership interest not found";
  const refused = await route.GET(
    new Request("http://openbooks.test/x"),
    context,
  );
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).error, state.refusal);
  state.refusal = "";
});
test("control-loss domain refusal and authorization are not swallowed", async () => {
  state.refusal =
    "The approved ledger evidence changed; propose a new disposal";
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
