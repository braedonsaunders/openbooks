import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const state = {
  allowed: true,
  operation: "tax_basis",
  refusal: "",
  calls: [] as { command: string; args: unknown[] }[],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("tax-basis-actions")
] = state;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return next(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "../../_authorization")
      return { shortCircuit: true, url: "mock:tax-basis-action-auth" };
    if (
      specifier === "@openbooks/engine/src/assets/group-valuations.ts" ||
      specifier === "@openbooks/engine/src/consolidation/loss-of-control.ts" ||
      specifier === "@openbooks/engine/src/assets/asset-changes.ts" ||
      specifier === "@openbooks/engine/src/assets/asset-change-reversals.ts" ||
      specifier === "@openbooks/engine/src/revenue/lease-changes.ts" ||
      specifier === "@openbooks/engine/src/revenue/contract-modifications.ts" ||
      specifier === "@openbooks/engine/src/tax-returns/asset-basis-workpaper.ts"
    )
      return { shortCircuit: true, url: "mock:tax-basis-action-commands" };
    if (specifier === "@/lib/api/json")
      return next(
        new URL("../../../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:tax-basis-action-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `import {NextResponse} from 'next/server';
        export async function authorizeChange(){
          const s=globalThis[Symbol.for('tax-basis-actions')];
          return s.allowed ? {domain:'asset',operation:s.operation,auth:{user:{orgId:'org',id:'actor'}}}
            : NextResponse.json({error:'missing permission'},{status:403});
        }`,
      };
    if (url === "mock:tax-basis-action-commands")
      return {
        shortCircuit: true,
        format: "module",
        source: `
        async function run(command,...args){
          const s=globalThis[Symbol.for('tax-basis-actions')];s.calls.push({command,args});
          if(s.refusal)throw new Error(s.refusal);return 'new-change';
        }
        export const applyAssetGroupValuation=(...a)=>run('group',...a);
        export const applyLossOfControl=(...a)=>run('control',...a);
        export const applyLossOfControlReversal=(...a)=>run('controlReverse',...a);
        export const applyAssetChange=(...a)=>run('asset',...a);
        export const proposeAssetReversal=(...a)=>run('assetReverse',...a);
        export const applyLeaseChange=(...a)=>run('lease',...a);
        export const applyRevenueModification=(...a)=>run('revenue',...a);
        export const applyTaxAssetBasis=(...a)=>run('tax',...a);
        export const applyTaxAssetBasisReversal=(...a)=>run('taxReverse',...a);
        export const proposeTaxAssetBasisReversal=(...a)=>run('proposeTaxReverse',...a);
      `,
      };
    return next(url, context);
  },
});
const apply = await import("./apply/route.ts");
const reverse = await import("./reverse/route.ts");
hooks.deregister();
const context = { params: Promise.resolve({ id: "source-change" }) };
const request = (body?: unknown) =>
  new Request("http://openbooks.test/change", {
    method: "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
beforeEach(() => {
  state.allowed = true;
  state.operation = "tax_basis";
  state.refusal = "";
  state.calls = [];
});

test("approved tax basis uses its tax service and preserves the authenticated identity", async () => {
  assert.equal((await apply.POST(request(), context)).status, 200);
  assert.deepEqual(state.calls, [
    { command: "tax", args: ["org", "source-change", "actor"] },
  ]);
});
test("tax correction dispatch cannot fall through to book asset reversal", async () => {
  state.operation = "tax_basis_reversal";
  assert.equal((await apply.POST(request(), context)).status, 200);
  assert.equal(state.calls[0]?.command, "taxReverse");
});
test("ordinary component and group valuation apply routes retain their existing services", async () => {
  state.operation = "partial_disposal";
  await apply.POST(request(), context);
  state.operation = "group_valuation";
  await apply.POST(request(), context);
  assert.deepEqual(
    state.calls.map((call) => call.command),
    ["asset", "group"],
  );
});
test("tax correction proposes with a reason and no client-selected accounting date", async () => {
  const input = {
    reason: "Correct the independently assessed statutory allocation",
    idempotencyKey: "tax-correction",
  };
  const response = await reverse.POST(request(input), context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { changeId: "new-change" });
  assert.deepEqual(state.calls, [
    {
      command: "proposeTaxReverse",
      args: ["org", "source-change", "actor", input],
    },
  ]);
});
test("a different tax correction year and an unknown field are refused before calling the tax service", async () => {
  const input = {
    reason: "Correct the statutory allocation",
    idempotencyKey: "tax-correction",
  };
  assert.equal(
    (
      await reverse.POST(
        request({ ...input, effectiveOn: "2027-01-01" }),
        context,
      )
    ).status,
    422,
  );
  assert.equal(
    (await reverse.POST(request({ ...input, inventedBasis: "0" }), context))
      .status,
    422,
  );
  assert.equal(state.calls.length, 0);
});
test("book asset reversal still requires and forwards its actual effective date", async () => {
  state.operation = "partial_disposal";
  const input = {
    reason: "Reverse the component disposal",
    idempotencyKey: "book-correction",
  };
  assert.equal((await reverse.POST(request(input), context)).status, 422);
  const dated = { ...input, effectiveOn: "2026-09-01" };
  assert.equal((await reverse.POST(request(dated), context)).status, 200);
  assert.deepEqual(state.calls, [
    { command: "assetReverse", args: ["org", "source-change", "actor", dated] },
  ]);
});
test("a tax refusal survives the boundary and denied authorization calls no command", async () => {
  state.refusal =
    "Reverse the later tax workpaper before correcting this source";
  const response = await apply.POST(request(), context);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: state.refusal });
  state.allowed = false;
  state.calls = [];
  assert.equal((await apply.POST(request(), context)).status, 403);
  assert.equal((await reverse.POST(request({}), context)).status, 403);
  assert.equal(state.calls.length, 0);
});
