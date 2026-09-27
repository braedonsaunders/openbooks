import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// approvals-links resolves through the ENGINE's flow registry, so this test
// imports the real registry and the real resolver, stubbing only the
// database (never called here).

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

const { getFlowAdapter, listFlowSubjectProfiles } = await import(
  "@openbooks/engine/src/flows/registry.ts"
);
const { approvalRecordHref } = await import("./approvals-links.ts");

const PROBE_ID = "55555555-5555-4555-8555-555555555555";
const APP_ROUTES = fileURLToPath(new URL("../app/(app)/", import.meta.url));

/** True when a Next.js page serves `path` (dynamic `[segment]` dirs match any value). */
function pageExists(path: string): boolean {
  let dir = APP_ROUTES;
  for (const segment of path.split("/").filter(Boolean)) {
    const next = existsSync(join(dir, segment))
      ? segment
      : readdirSync(dir).find((entry) => /^\[[^.\]]+\]$/.test(entry));
    if (!next) return false;
    dir = join(dir, next);
  }
  return existsSync(join(dir, "page.tsx"));
}

test("every gatable subject kind links to a page that exists", () => {
  // A non-document subject opens where its adapter's deepLink says, so the
  // approvals hub and notifications can never disagree; every link must
  // land on a real page, or a kind is registered with no surface.
  const kinds = listFlowSubjectProfiles().map((profile) => profile.subjectKind);
  assert.ok(kinds.length > 0, "the engine must declare gatable subject kinds");
  const defects = kinds.flatMap((kind) => {
    const adapter = getFlowAdapter(kind);
    const href = approvalRecordHref(kind, PROBE_ID);
    if (href == null) return [`${kind}: no record link`];
    if (adapter && adapter.scope.via !== "document" && href !== adapter.deepLink(PROBE_ID)) {
      return [`${kind}: ${href} is not the adapter's deepLink ${adapter.deepLink(PROBE_ID)}`];
    }
    const path = href.split("?")[0]!;
    return pageExists(path) ? [] : [`${kind}: ${path} is not a page`];
  });
  assert.deepEqual(defects, [], `approval record links:\n  ${defects.join("\n  ")}`);
});
