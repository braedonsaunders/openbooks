import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-tax-return-route-test");
interface RouteState { input: unknown }
const routeState: RouteState = { input: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../../lib/api/v1-request": `export async function withV1Request(request, label, operation) {
      const result = await operation({ user: { orgId: "org-1" } }, { authz: { user: { orgId: "org-1" } } })
      return Response.json(result.body, { status: result.status })
    }`,
    "../../../../../../lib/application/tax-read": `const state = globalThis[Symbol.for('openbooks.v1-tax-return-route-test')]
     export async function getApplicationTaxReturn(_context, input) {
       state.input = input
       return { formCode: input.formCode, boxes: [] }
     }`,
  },
});
const { GET } = (await import("./route.ts")) as typeof import("./route.ts");

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
