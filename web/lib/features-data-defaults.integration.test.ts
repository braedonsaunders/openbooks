import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for the data-dependent feature defaults. An org
// with FX history (or two subsidiaries) but no explicit flag must read the
// SAME answer from the Features page model (resolvedFeatureState), the route
// guards (isFeatureEnabled), and the engine re-check
// (lockAndCheckOrgFeature): the application layer used to say ON while both
// enforcement points said OFF, so FX revaluation refused an org the UI
// presented as multi-currency. All three resolve through the single engine
// helper (engine/src/organization/feature-defaults.ts); an explicit stored boolean always
// wins in both directions.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' };
    }
    return next(specifier, context);
  },
});

const { db, withBypassContext, withOrgTransaction } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { lockAndCheckOrgFeature } = await import(
  "@openbooks/engine/src/organization/org-feature-lock.ts"
);
const { dataDependentFeatureDefault } = await import(
  "@openbooks/engine/src/organization/feature-defaults.ts"
);
const { isFeatureEnabled, resolvedFeatureState } = await import("./features.ts");
import type { FeatureState } from "./features.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function checkInTx(orgId: string, key: string): Promise<boolean> {
  return withOrgTransaction(orgId, () => lockAndCheckOrgFeature(db, orgId, key));
}

test("multiCurrency data default agrees across layers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = '{}'::jsonb where id = ${org.orgId}`));
    await withBypassContext(() => db.execute(sql`
      insert into fx_rates (org_id, as_of, from_currency, to_currency, rate_type, rate, source)
      values (${org.orgId}, '2026-07-01', 'USD', 'CAD', 'spot', 1.36, 'manual')`));
    const state = await withBypassContext(() => db.execute<{ f: FeatureState | null }>(sql`
      select settings->'features' as f from orgs where id = ${org.orgId}`));
    const raw = state.rows[0]?.f ?? {};
    assert.equal(await dataDependentFeatureDefault(db, org.orgId, "multiCurrency", raw), true);
    assert.equal((await withBypassContext(() => resolvedFeatureState(org.orgId))).multiCurrency, true);
    assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiCurrency")), true);
    assert.equal(await checkInTx(org.orgId, "multiCurrency"), true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multiCurrency explicit off wins over FX history", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = '{"features": {"multiCurrency": false}}'::jsonb where id = ${org.orgId}`));
    await withBypassContext(() => db.execute(sql`
      insert into fx_rates (org_id, as_of, from_currency, to_currency, rate_type, rate, source)
      values (${org.orgId}, '2026-07-01', 'USD', 'CAD', 'spot', 1.36, 'manual')`));
    assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiCurrency")), false);
    assert.equal(await checkInTx(org.orgId, "multiCurrency"), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multiCurrency stays off with no data and no flag", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = '{}'::jsonb where id = ${org.orgId}`));
    assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiCurrency")), false);
    assert.equal(await checkInTx(org.orgId, "multiCurrency"), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multiSubsidiary data default agrees across layers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = '{}'::jsonb where id = ${org.orgId}`));
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, parent_id, is_elimination, is_active)
      values (${randomUUID()}, ${org.orgId}, 'Second Co', 'CAD', 'CA', ${org.subsidiaryId}, false, true)`));
    assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiSubsidiary")), true);
    assert.equal(await checkInTx(org.orgId, "multiSubsidiary"), true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("multiSubsidiary stays off for a single-entity org", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = '{}'::jsonb where id = ${org.orgId}`));
    assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiSubsidiary")), false);
    assert.equal(await checkInTx(org.orgId, "multiSubsidiary"), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
