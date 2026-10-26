import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../../testing/stub-modules";

const stateKey = Symbol.for("openbooks.party-tax-id-validation-route-test");
class TestVatValidationError extends Error {}
const state = {
  VatValidationError: TestVatValidationError,
  transactionCommitted: false,
  transactionRolledBack: false,
  markedUnverified: false,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/api/route": `const state = globalThis[Symbol.for('openbooks.party-tax-id-validation-route-test')]
      export function defineRoute({ handler }) {
        return async (_request, context) => handler({ authz: { user: { orgId: 'org-1', id: 'actor-1' } }, params: await context.params })
      }`,
    "@/lib/api/error-response": `export function apiErrorResponse(_error, options) { return Response.json({ error: 'unexpected' }, { status: options.safeStatus }) }`,
    "@openbooks/engine/platform/database": `const state = globalThis[Symbol.for('openbooks.party-tax-id-validation-route-test')]
      export async function withOrgTransaction(_orgId, work) {
        try {
          const result = await work()
          state.transactionCommitted = true
          return result
        } catch (error) {
          state.transactionRolledBack = true
          throw error
        }
      }`,
    "@openbooks/engine/tax": `const state = globalThis[Symbol.for('openbooks.party-tax-id-validation-route-test')]
      export async function validateStoredTaxId() {
        state.markedUnverified = true
        throw new state.VatValidationError('authority outage')
      }`,
    "@openbooks/engine/connectors": `const state = globalThis[Symbol.for('openbooks.party-tax-id-validation-route-test')]
      export const VatValidationError = state.VatValidationError`,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

test("authority outages commit the unverified state before returning the retry response", async () => {
  state.transactionCommitted = false;
  state.transactionRolledBack = false;
  state.markedUnverified = false;
  const response = await POST(
    new Request(
      "http://openbooks.test/api/party-tax-ids/11111111-1111-4111-8111-111111111111/validate",
    ),
    {
      params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }),
    },
  );
  assert.equal(response.status, 422);
  assert.equal(state.markedUnverified, true);
  assert.equal(state.transactionCommitted, true);
  assert.equal(state.transactionRolledBack, false);
});
