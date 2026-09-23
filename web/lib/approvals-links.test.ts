import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// approvals-links is client-safe, but exhaustiveness is a property of the
// ENGINE's gatable kinds — so this test imports the real flow registry and
// the real link map, stubbing only the database (never called here). A
// kind the engine can gate must never fall through to a null href
// silently again: the hrm_employment_change_request hire approval showed
// an opaque id with nowhere to click while offering Approve and Reject.

// Every value the engine chain imports from the platform database module.
const bomb = `throw new Error("no database in this test")`;
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
      return { shortCircuit: true, format: "module", url: "mock:approval-links-db" };
    }
    return next(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:approval-links-db") {
      return { format: "module", source: dbStub, shortCircuit: true };
    }
    return nextLoad(url);
  },
});

const { listFlowSubjectProfiles } = await import(
  "@openbooks/engine/src/flows/registry.ts"
);
const { approvalRecordHref } = await import("./approvals-links.ts");

const PROBE_ID = "55555555-5555-4555-8555-555555555555";

test("every subject kind the flows engine can gate has a record link", () => {
  const kinds = listFlowSubjectProfiles().map((profile) => profile.subjectKind);
  assert.ok(kinds.length > 0, "the engine must declare gatable subject kinds");
  const missing = kinds.filter((kind) => approvalRecordHref(kind, PROBE_ID) == null);
  assert.deepEqual(
    missing,
    [],
    "these engine-gatable kinds fall through to a null record link:\n  " + missing.join("\n  "),
  );
});

test("an employment change request links to its queue", () => {
  // The engine adapter's deepLink names the same URL: one declaration of
  // where an approver inspects the request (employee, kind, effective
  // date, requester), never a second drawer.
  assert.equal(
    approvalRecordHref("hrm_employment_change_request", PROBE_ID),
    `/hrm/change-requests?request=${PROBE_ID}`,
  );
});
