import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Regression for B-PRJ-06: web/lib/subcontracts-gate.ts re-implemented the
// feature registry's defaults and the projects-parent dependency as inline
// SQL. A non-boolean stored value (features.subcontracts='yes' via import)
// mis-resolved through the PG ::boolean cast ('yes' casts to TRUE, so the
// feature read ON against its off default; other spellings threw 22P02 and
// the guarded routes 500'd), while the canonical resolver (featureEnabled:
// non-boolean falls back to default) reads the feature cleanly off. The gate
// must call the canonical resolver: non-boolean values read as the canonical
// result with no 500, and a disabled projects parent disables subcontracts.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { guardSubcontractsFeature } = (await import("./subcontracts-gate.ts")) as typeof import(
  "./subcontracts-gate.ts"
);
hooks.deregister();

const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

async function setFeatures(orgId: string, features: Record<string, unknown>): Promise<void> {
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('features', ${JSON.stringify(features)}::jsonb)
     where id = ${orgId}`));
}

async function guard(orgId: string): Promise<number | null> {
  const res = await withBypassContext(() => guardSubcontractsFeature(orgId));
  if (res === null) return null;
  return res.status;
}

test("subcontracts gate resolves through the canonical feature registry", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    // As an import would store it: a JSON string, not a boolean. 'yes' casts
    // to TRUE in Postgres, so the old inline SQL read the feature ON against
    // its off default; the canonical default is off → guarded (404).
    await setFeatures(org.orgId, { subcontracts: "yes" });
    assert.equal(await guard(org.orgId), 404);

    // A spelling no ::boolean cast accepts must also guard, not 500.
    await setFeatures(org.orgId, { subcontracts: "maybe" });
    assert.equal(await guard(org.orgId), 404);

    // A disabled projects parent disables subcontracts even when stored on
    // (subcontracts declares requiresAll ['projects'] in the registry).
    await setFeatures(org.orgId, { projects: false, subcontracts: true });
    assert.equal(await guard(org.orgId), 404);

    // An explicitly enabled flag stays enabled under an enabled parent.
    await setFeatures(org.orgId, { projects: true, subcontracts: true });
    assert.equal(await guard(org.orgId), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
