import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route boundary suite: filing-entity scoping and the declared translation
// policy must reach the engine verbatim, restricted callers keep the
// historical org-wide denial, and out-of-scope subsidiaries 404 — never widen
// into an org-wide return.
const stateKey = Symbol.for("openbooks.tax-return-route-test");
interface TaxReturnCall {
  orgId: string;
  formCode: string;
  from: string;
  to: string;
  adjustments: Record<string, string>;
  opts: Record<string, unknown>;
}
interface RouteState {
  calls: TaxReturnCall[];
}
const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const allowed = new Set(['sub-allowed'])
      export async function guardPermission(permission) {
        if (permission !== 'reports.read') {
          throw new Error('unexpected permission gate: ' + permission)
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: allowed }
      }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        if (subsidiaryId === null) return { status: 404, json: async () => ({ error: 'not found' }) }
        if (!authz.allowedSubsidiaryIds.has(subsidiaryId)) {
          return { status: 404, json: async () => ({ error: 'not found' }) }
        }
        return null
      }
    `,
  ],
  [
    "mock:tax-return",
    `
      const state = globalThis[Symbol.for('openbooks.tax-return-route-test')]
      export async function computeTaxReturn(orgId, formCode, from, to, adjustments, opts) {
        state.calls.push({ orgId, formCode, from, to, adjustments, opts })
        return { formCode, boxes: [] }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["@openbooks/engine/src/tax-returns/return.ts", "mock:tax-return"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function get(query: string): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/tax/returns/CA_GST34${query}`),
    { params: Promise.resolve({ code: "CA_GST34" }) },
  ) as Promise<Response>;
}

test("GET keeps the org-wide denial for restricted callers without a scope", async () => {
  routeState.calls.length = 0;

  const response = await get("?from=2026-07-01&to=2026-07-31");

  assert.equal(response.status, 404);
  assert.equal(routeState.calls.length, 0);
});

test("GET scopes an in-scope subsidiary to the filing entity", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-allowed",
  );

  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
  assert.deepEqual(routeState.calls[0]!.opts.filingEntity, {
    subsidiaryIds: ["sub-allowed"],
  });
  assert.equal("translation" in routeState.calls[0]!.opts, false);
});

test("GET refuses an out-of-scope subsidiary without reaching the engine", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-nope",
  );

  assert.equal(response.status, 404);
  assert.equal(routeState.calls.length, 0);
});

test("GET passes the declared translation policy and registration pin", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-allowed&registration=reg-1" +
      "&presentationCurrency=CAD&rateType=spot&rateDate=2026-07-31",
  );

  assert.equal(response.status, 200);
  assert.equal(routeState.calls.length, 1);
  assert.deepEqual(routeState.calls[0]!.opts.filingEntity, {
    subsidiaryIds: ["sub-allowed"],
    registrationId: "reg-1",
  });
  assert.deepEqual(routeState.calls[0]!.opts.translation, {
    presentationCurrency: "CAD",
    rateType: "spot",
    rateDate: "2026-07-31",
  });
});

test("GET refuses a decimal-comma adjustment by name instead of computing it as zero", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-allowed&adj_109=12,34",
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(body.error.includes("adjustment 109"), body.error);
  // The remedy rewrites with "." — never a silent 1234 (a 100x money error).
  assert.ok(body.error.includes("12.34"), body.error);
  assert.equal(routeState.calls.length, 0);
});

test("GET refuses a non-numeric adjustment by name", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-allowed&adj_109=abc",
  );

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.ok(body.error.includes("adjustment 109"), body.error);
  assert.equal(routeState.calls.length, 0);
});

test("GET passes a well-formed adjustment to the engine verbatim", async () => {
  routeState.calls.length = 0;

  const response = await get(
    "?from=2026-07-01&to=2026-07-31&subsidiary=sub-allowed&adj_109=12.34",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.calls[0]!.adjustments, { 109: "12.34" });
});

test("GET fails closed on an explicitly empty subsidiary filter", async () => {
  routeState.calls.length = 0;

  const response = await get("?from=2026-07-01&to=2026-07-31&subsidiary=");

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "subsidiary filter is empty",
  });
  assert.equal(routeState.calls.length, 0);
});
