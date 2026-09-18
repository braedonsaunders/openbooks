import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The recon tile's denial path must skip the banking reader entirely — not
// merely hide its result. This test runs with NO database configured: any
// query attempt throws, so a null return proves the reader was never
// called. (The seeded green path lives in
// _metrics-recon-tile.integration.test.ts.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { loadReconSummary } = await import("./_metrics.ts");
type Authz = import("@/lib/authz.ts").Authz;

assert.equal(!!process.env.OPENBOOKS_DB_URL, false, "this proof is only valid with no database configured");

function deniedAuthz(): Authz {
  return {
    user: {
      id: "denied-user", email: "denied-user@test", name: "Denied", orgId: "org-denied",
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: "org-denied", isSuperAdmin: false,
      homeUserId: "denied-user", homeOrgId: "org-denied",
    },
    // Every dashboard permission EXCEPT banking.read.
    permissions: new Set(["dashboard.read", "gl.read", "ar.read", "ap.read"]),
    allowedSubsidiaryIds: null,
  };
}

test("loadReconSummary returns null before any query for a caller without banking.read", async () => {
  assert.equal(await loadReconSummary(deniedAuthz()), null);
});
