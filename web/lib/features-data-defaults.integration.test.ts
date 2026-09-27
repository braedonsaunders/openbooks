import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const { featureDisableStatuses, isFeatureEnabled, resolvedFeatureState } = await import("./features.ts");
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

test("feature disable probes ignore secondary-book journal amounts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const secondaryBook = randomUUID();
    const secondSubsidiary = randomUUID();
    const entry = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${secondaryBook}, ${org.orgId}, 'ALT', 'Alternate', false, true, true)`);
      await db.execute(sql`insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, is_elimination, is_active)
        values (${secondSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Second entity', 'CAD', 'CA', false, true)`);
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,retainageReceivable}', ${JSON.stringify(org.accounts.revenue)}::jsonb, true)
        where id = ${org.orgId}`);
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${secondaryBook}, ${secondSubsidiary}, 'ALT-BOOK', ${org.date}, ${org.periodId}, 'posted', 'manual')`);
      await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
        values (${org.orgId}, ${entry}, 1, ${org.accounts.revenue}, ${secondSubsidiary}, '100', 'CAD', '80', '1.25'),
               (${org.orgId}, ${entry}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, '-100', 'CAD', '-80', '1.25')`);
    });
    const status = await withBypassContext(() => featureDisableStatuses(org.orgId, ['multiSubsidiary', 'multiCurrency', 'projects']));
    assert.equal(status.multiSubsidiary?.blocked, false);
    assert.equal(status.multiCurrency?.blocked, false);
    assert.ok(!status.projects?.impacts.some((impact) => impact.labelKey === 'outstandingRetainage'));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
