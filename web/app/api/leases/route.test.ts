import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const key = Symbol.for("openbooks.lease-lifecycle-routes");
const state = { allowed: true, calls: [] as unknown[][], refusal: "" };
(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = state;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Resolve framework imports against this real file, not the virtual auth URL.
    if (specifier === "next/server" && context.parentURL?.startsWith("mock:"))
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    if (specifier === "server-only")
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, url: "mock:lease-auth" };
    if (
      specifier === "@openbooks/engine/src/revenue/leases.ts" ||
      specifier === "@openbooks/engine/src/revenue/lease-changes.ts"
    )
      return { shortCircuit: true, url: "mock:lease-commands" };
    if (specifier === "@/lib/api/json")
      return nextResolve(
        new URL("../../../lib/api/json.ts", import.meta.url).href,
        context,
      );
    if (specifier === "@/lib/list-params")
      return nextResolve(
        new URL("../../../lib/list-params.ts", import.meta.url).href,
        context,
      );
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:lease-auth")
      return {
        shortCircuit: true,
        format: "module",
        source: `
      import { NextResponse } from 'next/server';
      const state=globalThis[Symbol.for('openbooks.lease-lifecycle-routes')];
      export async function guardFeaturePermission(){return state.allowed?{user:{orgId:'org',id:'actor'}}:NextResponse.json({error:'missing permission'},{status:403})}
    `,
      };
    if (url === "mock:lease-commands")
      return {
        shortCircuit: true,
        format: "module",
        source: `
      const state=globalThis[Symbol.for('openbooks.lease-lifecycle-routes')];
      async function execute(...args){state.calls.push(args);if(state.refusal)throw new Error(state.refusal);return {leaseId:'lease',changeId:'change'}}
      export const createLeaseAgreement=execute,commenceLease=execute,postDueLeaseSchedules=execute,proposeLeaseChange=execute;
    `,
      };
    return nextLoad(url, context);
  },
});
// Keep the real parseJsonBody + zod schema + decimal/calendar classifiers.
const create = await import("./route.ts");
const change = await import("./[id]/changes/route.ts");
hooks.deregister();
const id = "00000000-0000-4000-8000-000000000001";
const agreement = {
  subsidiaryId: id,
  leaseNumber: "L-1",
  commencementOn: "2026-07-01",
  termPeriods: 12,
  paymentFrequency: "monthly",
  paymentTiming: "advance",
  paymentAmount: "1000.0000",
  annualDiscountRatePercent: "6",
  classificationInputs: {},
  accounts: {
    rouAsset: id,
    leaseLiability: id,
    interestExpense: id,
    amortizationExpense: id,
    leaseExpense: id,
    payment: id,
  },
};
const request = (body: unknown) =>
  new Request("http://openbooks.test/api/leases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
function reset() {
  state.calls.length = 0;
  state.allowed = true;
  state.refusal = "";
}
test("a valid contractual advance reaches the service unchanged with the authenticated actor", async () => {
  reset();
  const response = await create.POST(request(agreement));
  assert.equal(response.status, 200);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]![0], "org");
  assert.equal(state.calls[0]![1], "actor");
  assert.equal(
    (state.calls[0]![2] as typeof agreement).paymentTiming,
    "advance",
  );
});
test("money precision, impossible calendar dates and invalid references are rejected before persistence", async () => {
  for (const patch of [
    { paymentAmount: "1.23456" },
    { paymentAmount: "1,234" },
    { commencementOn: "2026-02-30" },
    { termPeriods: 1.2 },
    { subsidiaryId: "other-org" },
    { paymentTiming: "pretend_arrears" },
  ]) {
    reset();
    const response = await create.POST(request({ ...agreement, ...patch }));
    assert.equal(response.status, 400);
    assert.equal(state.calls.length, 0);
    const body = (await response.json()) as { error: string };
    assert.ok(body.error);
  }
});
test("null, array and malformed JSON bodies cannot reach the lease writer", async () => {
  for (const body of [null, []]) {
    reset();
    assert.equal((await create.POST(request(body))).status, 400);
    assert.equal(state.calls.length, 0);
  }
  reset();
  const response = await create.POST(
    new Request("http://openbooks.test", { method: "POST", body: "{broken" }),
  );
  assert.equal(response.status, 400);
  assert.equal(state.calls.length, 0);
});
test("permission denial precedes writes and engine refusals reach the operator verbatim", async () => {
  reset();
  state.allowed = false;
  assert.equal((await create.POST(request(agreement))).status, 403);
  assert.equal(state.calls.length, 0);
  reset();
  state.refusal =
    "select the account holding previously recorded costs, prepayments and incentives";
  const response = await create.POST(request(agreement));
  assert.equal(response.status, 422);
  assert.equal(
    ((await response.json()) as { error: string }).error,
    state.refusal,
  );
});
test("a modification needs an effective date, reason, assessment and stable request key", async () => {
  const valid = {
    operation: "termination",
    effectiveOn: "2026-07-16",
    reason: "Signed early termination",
    assessment: "Full right of use surrendered",
    idempotencyKey: "stable-1",
    scopeReductionPercent: "100",
    settlementPayment: "-100",
    gainLossAccountId: id,
  };
  for (const patch of [
    { assessment: "" },
    { reason: "" },
    { idempotencyKey: "" },
    { gainLossAccountId: "missing" },
    { effectiveOn: "2026-13-01" },
  ]) {
    reset();
    const response = await change.POST(request({ ...valid, ...patch }), {
      params: Promise.resolve({ id }),
    });
    assert.equal(response.status, 400);
    assert.equal(state.calls.length, 0);
  }
  reset();
  assert.equal(
    (await change.POST(request(valid), { params: Promise.resolve({ id }) }))
      .status,
    200,
  );
  assert.equal(state.calls[0]![2], "actor");
  assert.equal(
    (state.calls[0]![3] as typeof valid).settlementPayment,
    "-100.0000",
  );
});
