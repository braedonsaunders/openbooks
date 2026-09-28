import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";

const { listSetupRecords } = await import("./setup-read");
const { getSetupRecord, listSetupEntities } = await import("./setup-read");
const { SETUP_ENTITY_BY_KEY, resolveSetupEntityGate } = await import("../setup/registry");
const { resolvedFeatureState } = await import("../features");
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

test("unknown setup entities return the catalog remedy without querying records", async () => {
  const context = {
    authz: { user: { orgId: "setup-read-unit-test" }, permissions: new Set(["admin.setup.manage"]) },
    source: "api",
    requestId: "setup-read-unit-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;

  await assert.rejects(
    listSetupRecords(context, { entityKey: "not-a-setup-entity" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "not_found"
      && error.status === 404
      && error.message === "setup entity not found; list enabled entities from GET /api/v1/setup",
  );
});

function readContext(orgId: string): ApplicationContext {
  return {
    authz: {
      user: { orgId },
      permissions: new Set(["admin.setup.manage"]),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: "setup-read-gate-test",
    apiKeyId: null,
  } as unknown as ApplicationContext;
}

/** Pin the org's feature flags, then read the state back so a zero-row write
 *  fails loudly here instead of silently testing the defaults. */
async function setOrgFeatures(orgId: string, flags: Record<string, boolean>): Promise<void> {
  await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify(flags)}::jsonb, true) where id = ${orgId}`);
  const state = await resolvedFeatureState(orgId);
  for (const [key, value] of Object.entries(flags)) {
    assert.equal(state[key], value, `feature flag ${key} did not persist`);
  }
}

/** A test-local any-of descriptor. Its table does not exist, so any storage
 *  touch would throw a database error — a 404 proves the refusal lands first. */
function registerAnyOfProbe(key: string, featureKeysAny: string[]): void {
  SETUP_ENTITY_BY_KEY.set(key, {
    key,
    table: "c7a_consumer_probe_missing_table",
    groupKey: "projects",
    iconKey: "briefcase",
    orgScoped: true,
    hasActive: false,
    featureKeysAny,
    columns: [],
    fields: [],
  });
}

async function assertSetupMissing(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ApplicationError
      && error.code === "not_found"
      && error.status === 404
      && error.message === "setup entity not found; list enabled entities from GET /api/v1/setup",
  );
}

test("setup catalog and reads honor an any-of descriptor through the shared gate", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const probeKey = "c7a-read-any-of-probe";
  registerAnyOfProbe(probeKey, ["projects", "manufacturing"]);
  try {
    await setOrgFeatures(org.orgId, { projects: false, manufacturing: false });
    // The catalog reports the closed verdict from the shared helper.
    const closed = await listSetupEntities(readContext(org.orgId));
    assert.equal(closed.entities.find((entity) => entity.key === probeKey)?.enabled, false);
    assert.equal(
      resolveSetupEntityGate({ featureKeysAny: ["projects", "manufacturing"] }, { projects: false, manufacturing: false }).enabled,
      false,
    );
    // Both reads refuse with the same not-found before the missing table is touched.
    await assertSetupMissing(listSetupRecords(readContext(org.orgId), { entityKey: probeKey }));
    await assertSetupMissing(getSetupRecord(readContext(org.orgId), { entityKey: probeKey, id: randomUUID() }));
    // Either member on admits through the same helper — observed via the
    // catalog, which needs no storage behind the gate.
    await setOrgFeatures(org.orgId, { projects: true, manufacturing: false });
    const admitted = await listSetupEntities(readContext(org.orgId));
    assert.equal(admitted.entities.find((entity) => entity.key === probeKey)?.enabled, true);
  } finally {
    SETUP_ENTITY_BY_KEY.delete(probeKey);
    await dropScratchOrgReporting(org.orgId);
  }
});

test("setup reads fail closed on unknown keys and conflicting descriptors", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const unknownKey = "c7a-read-unknown-probe";
  const conflictKey = "c7a-read-conflict-probe";
  registerAnyOfProbe(unknownKey, ["no-such-feature"]);
  SETUP_ENTITY_BY_KEY.set(conflictKey, {
    key: conflictKey,
    table: "c7a_consumer_probe_missing_table",
    groupKey: "projects",
    iconKey: "briefcase",
    orgScoped: true,
    hasActive: false,
    featureKey: "projects",
    featureKeysAny: ["projects", "manufacturing"],
    columns: [],
    fields: [],
  });
  try {
    // Every named feature is on: only the unknown member and the descriptor
    // conflict itself can still refuse.
    await setOrgFeatures(org.orgId, { projects: true, manufacturing: true, inventory: true });
    await assertSetupMissing(listSetupRecords(readContext(org.orgId), { entityKey: unknownKey }));
    await assertSetupMissing(listSetupRecords(readContext(org.orgId), { entityKey: conflictKey }));
    const catalog = await listSetupEntities(readContext(org.orgId));
    assert.equal(catalog.entities.find((entity) => entity.key === unknownKey)?.enabled, false);
    assert.equal(catalog.entities.find((entity) => entity.key === conflictKey)?.enabled, false);
  } finally {
    SETUP_ENTITY_BY_KEY.delete(unknownKey);
    SETUP_ENTITY_BY_KEY.delete(conflictKey);
    await dropScratchOrgReporting(org.orgId);
  }
});

test("setup reads keep single-key behavior", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setOrgFeatures(org.orgId, { projects: false });
    await assertSetupMissing(listSetupRecords(readContext(org.orgId), { entityKey: "overhead-rates" }));
    const closed = await listSetupEntities(readContext(org.orgId));
    assert.equal(closed.entities.find((entity) => entity.key === "overhead-rates")?.enabled, false);
    await setOrgFeatures(org.orgId, { projects: true });
    const admitted = await listSetupEntities(readContext(org.orgId));
    assert.equal(admitted.entities.find((entity) => entity.key === "overhead-rates")?.enabled, true);
    const result = await listSetupRecords(readContext(org.orgId), { entityKey: "overhead-rates" });
    assert.equal(result.entityKey, "overhead-rates");
    assert.equal(typeof result.total, "number");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
