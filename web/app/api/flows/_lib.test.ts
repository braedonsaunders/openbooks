import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// gateErrorResponse is pure over the engine error — but its module shares
// imports with the DB-backed loaders, so stub the database, session, and
// feature reads (never called here) and keep the REAL mapping and the
// REAL engine error classes. A stubbed mapper would make every boundary
// assertion below hollow.
const bomb = `throw new Error("no database in this test")`;
// Every value the engine chain imports from the platform database module.
// The mapping under test never touches the database; these exist only so
// the real error classes load under plain node.
const dbStub = `const fail = () => { ${bomb} };
export const ambientTenantOrgId = (...args) => fail();
export const assertSafeRuntimeDatabaseRole = (...args) => fail();
export const currentRequestOrgResolver = (...args) => fail();
export const db = new Proxy({}, { get() { ${bomb} } });
export const env = new Proxy({}, { get() { ${bomb} } });
export const inDbTransaction = (...args) => fail();
export const longPool = new Proxy({}, { get() { ${bomb} } });
export const orgContext = (...args) => fail();
export const pool = new Proxy({}, { get() { ${bomb} } });
export const registerRequestOrgResolver = (...args) => fail();
export const schema = new Proxy({}, { get() { ${bomb} } });
export const withBypass = (...args) => fail();
export const withBypassContext = (...args) => fail();
export const withMaintenanceTransaction = (...args) => fail();
export const withOrg = (...args) => fail();
export const withOrgContext = (...args) => fail();
export const withOrgTransaction = (...args) => fail();
export const withTransactionSavepoint = (...args) => fail();`;

registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier === "@openbooks/engine/src/platform/db.ts" ||
      specifier === "../platform/db.ts"
    ) {
      return { shortCircuit: true, format: "module", url: "mock:platform-db" };
    }
    if (specifier === "../../../lib/authz") {
      return { shortCircuit: true, format: "module", url: "mock:flows-authz" };
    }
    if (specifier === "../../../lib/features") {
      return { shortCircuit: true, format: "module", url: "mock:flows-features" };
    }
    return next(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:platform-db") {
      return { format: "module", source: dbStub, shortCircuit: true };
    }
    if (url === "mock:flows-authz") {
      return {
        format: "module",
        source: `export async function getAuthz() { throw new Error("no session in this test") }`,
        shortCircuit: true,
      };
    }
    if (url === "mock:flows-features") {
      return {
        format: "module",
        source: `export async function isFeatureEnabled() { throw new Error("no features in this test") }`,
        shortCircuit: true,
      };
    }
    return nextLoad(url);
  },
});

const { DecisionFailedError, GateError, ReleaseError } = await import(
  "@openbooks/engine/src/flows/index.ts"
);
const { gateErrorResponse } = await import("./_lib.ts");

async function bodyText(response: Response): Promise<{ error?: unknown }> {
  return (await response.json()) as { error?: unknown };
}

// An approver with no linked person is refused by name during release;
// the decide unit rolls back (nothing recorded, gate still pending) and
// the wrapped refusal must reach the operator as a 422 with the remedy
// intact — never a 500, and never a success.
const NO_LINK_CAUSE =
  "the approver has no linked person — link the approver to a person in Admin → Users → Link person before they decide";

function releaseRefusal() {
  return new ReleaseError("approved", NO_LINK_CAUSE);
}

test("a retryable decision refusal answers 422 with the remedy intact", async () => {
  const response = gateErrorResponse(releaseRefusal());
  assert.equal(response.status, 422);
  const body = await bodyText(response);
  assert.match(String(body.error), /no linked person/);
  assert.match(String(body.error), /Link person/);
  assert.match(String(body.error), /not recorded/);
  assert.match(String(body.error), /still pending/);
});

test("every DecisionFailedError sibling maps by retryability, never blanket 500", async () => {
  const retryable = gateErrorResponse(
    new DecisionFailedError({ decision: "rejected", stage: "branch", cause: "gate branch failed" }),
  );
  assert.equal(retryable.status, 422);
  // A programming defect in the decide path stays a 500.
  const defect = gateErrorResponse(
    new DecisionFailedError({
      decision: "approved",
      stage: "release",
      cause: "cannot read property of undefined",
      retryable: false,
    }),
  );
  assert.equal(defect.status, 500);
  assert.match(String((await bodyText(defect)).error), /cannot read property/);
});

test("a stale-state decision failure answers 409", async () => {
  const response = gateErrorResponse(
    new DecisionFailedError({
      decision: "approved",
      stage: "release",
      cause: "this approval was already resolved by a concurrent decision",
    }),
  );
  assert.equal(response.status, 409);
});

test("plain gate refusals keep their existing mapping", async () => {
  assert.equal(gateErrorResponse(new GateError("approval not found")).status, 404);
  assert.equal(gateErrorResponse(new GateError("this approval was already resolved")).status, 409);
  assert.equal(gateErrorResponse(new GateError("not an approver for this gate")).status, 403);
  assert.equal(gateErrorResponse(new GateError("the gate is not submittable")).status, 422);
  const unknown = gateErrorResponse(new Error("boom"));
  assert.equal(unknown.status, 500);
  assert.deepEqual(await bodyText(unknown), { error: "internal error" });
});
