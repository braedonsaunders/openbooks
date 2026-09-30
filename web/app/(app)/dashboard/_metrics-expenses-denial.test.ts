import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Same shape as the recon denial proof: no database configured, so any
// query attempt throws and a null return proves the reader was never called.
registerHooks({
  resolve(specifier, context, nextResolve) {

    if (specifier.startsWith("@openbooks/engine/src/")) {
      return nextResolve(
        new URL(`../../../../engine/${specifier.slice("@openbooks/engine/".length)}`, import.meta.url).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
});

const { loadExpenseSummary } = await import("./_metrics.ts");
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
    // Every dashboard permission EXCEPT expenses.read.
    permissions: new Set(["dashboard.read", "gl.read", "banking.read"]),
    allowedSubsidiaryIds: null,
  };
}

test("loadExpenseSummary returns null before any query for a caller without expenses.read", async () => {
  assert.equal(await loadExpenseSummary(deniedAuthz()), null);
});
