import assert from "node:assert/strict";
import test from "node:test";

// --- Setup-gated resource catalog (web/lib/data-io/resources.ts) --------------
// The catalog loads its native dependencies in an independent test process,
// retaining real SQL builders and the scratch database for feature checks.

async function catalogModules() {
  const { getResource, listResources } = await import("./resources.ts");
  const { SETUP_ENTITY_BY_KEY, SETUP_ENTITIES } = await import("../setup/registry.ts");
  const { resolvedFeatureState } = await import("../features.ts");
  const { sql } = await import("drizzle-orm");
  const { db } = await import("@openbooks/engine/platform/db");
  const { createScratchOrg, dropScratchOrgReporting } =
    await import("@openbooks/engine/testing/fixtures");
  return {
    getResource,
    listResources,
    SETUP_ENTITY_BY_KEY,
    SETUP_ENTITIES,
    resolvedFeatureState,
    sql,
    db,
    createScratchOrg,
    dropScratchOrgReporting,
  };
}

/** Pin the org's feature flags, then read the state back so a zero-row write
 *  fails loudly here instead of silently testing the defaults. */
async function setCatalogFeatures(
  modules: Awaited<ReturnType<typeof catalogModules>>,
  orgId: string,
  flags: Record<string, boolean>,
): Promise<void> {
  await modules.db.execute(
    modules.sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb, true) where id = ${orgId}`,
  );
  const state = await modules.resolvedFeatureState(orgId);
  for (const [key, value] of Object.entries(flags)) {
    assert.equal(state[key], value, `feature flag ${key} did not persist`);
  }
}

/** A test-local any-of descriptor. Its table does not exist, so resolving a
 *  resource for it must never touch storage — the catalog only describes. */
function registerCatalogProbe(
  modules: Awaited<ReturnType<typeof catalogModules>>,
  key: string,
  featureKeysAny: string[],
): void {
  modules.SETUP_ENTITY_BY_KEY.set(key, {
    key,
    table: "catalog_probe_missing_table",
    groupKey: "projects",
    iconKey: "briefcase",
    orgScoped: true,
    hasActive: false,
    featureKeysAny,
    columns: [],
    fields: [],
  });
  modules.SETUP_ENTITIES.push(modules.SETUP_ENTITY_BY_KEY.get(key)!);
}

test(
  "setup resource catalog honors an any-of descriptor through the shared gate",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const modules = await catalogModules();
    const org = await modules.createScratchOrg();
    const probeKey = "catalog-any-of-probe";
    registerCatalogProbe(modules, probeKey, ["projects", "manufacturing"]);
    try {
      await setCatalogFeatures(modules, org.orgId, { projects: false, manufacturing: false });
      const closed = await modules.listResources(org.orgId);
      assert.ok(
        !closed.some((descriptor) => descriptor.key === probeKey),
        "a both-off any-of entity is hidden from the catalog",
      );
      assert.equal(await modules.getResource(org.orgId, probeKey), null);
      // Either member on admits through the same helper — describing the
      // resource needs no storage behind the gate.
      await setCatalogFeatures(modules, org.orgId, {
        projects: false,
        inventory: true,
        manufacturing: true,
      });
      const admitted = await modules.listResources(org.orgId);
      assert.ok(
        admitted.some((descriptor) => descriptor.key === probeKey),
        "one member on lists the entity",
      );
      assert.ok(
        await modules.getResource(org.orgId, probeKey),
        "one member on resolves the resource",
      );
    } finally {
      modules.SETUP_ENTITY_BY_KEY.delete(probeKey);
      modules.SETUP_ENTITIES.splice(
        modules.SETUP_ENTITIES.findIndex((entity) => entity.key === probeKey),
        1,
      );
      await modules.dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "setup resource catalog fails closed on unknown keys",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const modules = await catalogModules();
    const org = await modules.createScratchOrg();
    const probeKey = "catalog-unknown-probe";
    registerCatalogProbe(modules, probeKey, ["no-such-feature"]);
    try {
      await setCatalogFeatures(modules, org.orgId, {
        projects: true,
        manufacturing: true,
        inventory: true,
      });
      const listed = await modules.listResources(org.orgId);
      assert.ok(
        !listed.some((descriptor) => descriptor.key === probeKey),
        "an unknown member never admits",
      );
      assert.equal(await modules.getResource(org.orgId, probeKey), null);
    } finally {
      modules.SETUP_ENTITY_BY_KEY.delete(probeKey);
      modules.SETUP_ENTITIES.splice(
        modules.SETUP_ENTITIES.findIndex((entity) => entity.key === probeKey),
        1,
      );
      await modules.dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "setup resource catalog keeps single-key behavior",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const modules = await catalogModules();
    const org = await modules.createScratchOrg();
    try {
      await setCatalogFeatures(modules, org.orgId, { projects: false });
      const closed = await modules.listResources(org.orgId);
      assert.ok(!closed.some((descriptor) => descriptor.key === "overhead-rates"));
      assert.equal(await modules.getResource(org.orgId, "overhead-rates"), null);
      await setCatalogFeatures(modules, org.orgId, { projects: true });
      const admitted = await modules.listResources(org.orgId);
      assert.ok(admitted.some((descriptor) => descriptor.key === "overhead-rates"));
      assert.ok(await modules.getResource(org.orgId, "overhead-rates"));
    } finally {
      await modules.dropScratchOrgReporting(org.orgId);
    }
  },
);
