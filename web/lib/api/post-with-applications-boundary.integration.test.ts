import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Route-level proof for the provider-FX observation id on payment posting:
// the real POST handler must refuse a junk settlementFxRateId with the field
// path before any SQL runs, and an absent id must stay optional (passing
// body parsing and reaching the document lookup). Only the auth boundary is
// stubbed, in the real Authz shape with an unrestricted scope; parsing, the
// document lookup, and the database are real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz") {
      return { shortCircuit: true, url: "mock:posting-gate" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:posting-gate") {
      return {
        format: "module",
        shortCircuit: true,
        source: `const key = Symbol.for('openbooks.posting-fx-gate')
          export async function getAuthz() { return globalThis[key] ?? null }
          export function can() { return true }
          export function guardSubsidiaryScope() { return null }`,
      };
    }
    return nextLoad(url, context);
  },
});

const gateKey = Symbol.for("openbooks.posting-fx-gate");
const { withBypassContext: withBypass } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { POST } = await import("../../app/api/payments/post-with-applications/route.ts");

function gateFor(orgId: string): void {
  (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
    user: { id: "posting-fx-test", orgId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/payments/post-with-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  ) as Promise<Response>;
}

const allocation = (settlementFxRateId: string | null | undefined) => ({
  openLineId: randomUUID(),
  sourceTransactionAmount: "100.0000",
  targetTransactionAmount: "100.0000",
  settlementRate: "1",
  settlementRateSource: "same_currency",
  settlementRateReference: "test",
  settlementFxRateId,
});

test("payment posting refuses a junk provider FX observation id with its field path", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    gateFor(scratch.orgId);
    const response = await post({ documentId: randomUUID(), allocations: [allocation("garbage")] });
    assert.equal(response.status, 400);
    const payload = (await response.json()) as { issues: { path: string }[] };
    assert.equal(payload.issues[0]?.path, "allocations.0.settlementFxRateId");
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

test("payment posting keeps the provider FX observation id optional", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    gateFor(scratch.orgId);
    // Absent and explicit-null ids both pass body parsing and reach the
    // document lookup, which refuses the unknown document — never a 400.
    for (const settlementFxRateId of [undefined, null]) {
      const response = await post({ documentId: randomUUID(), allocations: [allocation(settlementFxRateId!)] });
      assert.equal(response.status, 404, `expected lookup 404, got ${response.status}`);
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
