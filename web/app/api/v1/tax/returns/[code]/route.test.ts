import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-tax-return-route-test");
interface RouteState { input: unknown }
const routeState: RouteState = { input: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `export async function withV1Request(request, label, operation) {
      const result = await operation({ user: { orgId: "org-1" } }, { authz: { user: { orgId: "org-1" } } })
      return Response.json(result.body, { status: result.status })
    }`,
  ],
  [
    "mock:tax",
    `const state = globalThis[Symbol.for('openbooks.v1-tax-return-route-test')]
     export async function getApplicationTaxReturn(_context, input) {
       state.input = input
       return { formCode: input.formCode, boxes: [] }
     }`,
  ],
]);
const mockUrls = new Map<string, string>([
  ["../../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../../lib/application/tax-read", "mock:tax"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("GET /api/v1/tax/returns/[code] forwards the filing-entity reads", async () => {
  const response = await GET(
    new Request(
      "http://openbooks.test/api/v1/tax/returns/CA_GST34?from=2026-01-01&to=2026-03-31&subsidiary=sub-1,sub-2&presentationCurrency=cad&rateType=spot&rateDate=2026-03-31",
    ),
    { params: Promise.resolve({ code: "CA_GST34" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.input, {
    formCode: "CA_GST34",
    from: "2026-01-01",
    to: "2026-03-31",
    subsidiaryIds: ["sub-1", "sub-2"],
    registrationId: undefined,
    presentationCurrency: "cad",
    rateType: "spot",
    rateDate: "2026-03-31",
  });
});
