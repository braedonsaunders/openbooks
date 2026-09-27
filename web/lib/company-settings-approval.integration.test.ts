import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * Company Settings persists the vendor-bill release policy in org settings
 * JSON (default OFF), validates its shape, and audits the change. The Flows
 * engine and the Setup page both read the same key, so this is the single
 * source of truth — not a parallel gate.
 */
const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { readCompanySettings, updateCompanySettings } = await import('./company-settings')

async function orgSettings(orgId: string) {
  return withBypassContext(async () =>
    (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${orgId}`)).rows[0]!.settings,
  )
}

test('vendor-bill approval requirement defaults OFF and persists through Company Settings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    const before = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal(before.status, 200)
    assert.equal((before.body.org as Record<string, unknown>).requireVendorBillApproval, false)

    const saved = await withBypassContext(() => updateCompanySettings(me, { requireVendorBillApproval: true }))
    assert.equal(saved.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireVendorBillApproval, true)
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).requireVendorBillApproval, true)

    // Sibling settings keys survive the merge (no clobber).
    const settings = await orgSettings(org.orgId)
    assert.ok(settings.controlAccounts, 'control accounts survive the approvals write')

    // Reversible, and the reversal is audited with before/after state.
    const off = await withBypassContext(() => updateCompanySettings(me, { requireVendorBillApproval: false }))
    assert.equal(off.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireVendorBillApproval, false)
    const audits = await withBypassContext(async () =>
      (await db.execute<{ changes: Record<string, unknown> }>(sql`
        select changes from audit_log where org_id = ${org.orgId} and table_name = 'orgs' and action = 'update'`)).rows,
    )
    assert.ok(
      audits.some((row) => JSON.stringify(row.changes.requireVendorBillApproval) === '[false,true]'),
      `the ON flip is audited with before/after, got ${JSON.stringify(audits.map((row) => row.changes))}`,
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('vendor-bill approval requirement refuses non-boolean input', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    for (const bad of ['yes', 1, null, {}, []]) {
      const res = await withBypassContext(() => updateCompanySettings({ orgId: org.orgId, id: actor }, { requireVendorBillApproval: bad }))
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`)
    }
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown> | undefined)?.requireVendorBillApproval, undefined)
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

// IN11: the stock-count independent-review switch persists in the same
// orgs.settings.approvals object (default OFF), validates booleans, and
// audits flips — the engine gate reads this key, so this stays the single
// source of truth, not a parallel gate.
test('stock-count review requirement defaults OFF and persists through Company Settings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
    const me = { orgId: org.orgId, id: actor }

    const before = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal(before.status, 200)
    assert.equal((before.body.org as Record<string, unknown>).requireStockCountReview, false)

    const saved = await withBypassContext(() => updateCompanySettings(me, { requireStockCountReview: true }))
    assert.equal(saved.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireStockCountReview, true)
    const after = await withBypassContext(() => readCompanySettings(org.orgId))
    assert.equal((after.body.org as Record<string, unknown>).requireStockCountReview, true)

    for (const bad of ['yes', 1, null, {}, []]) {
      const res = await withBypassContext(() => updateCompanySettings(me, { requireStockCountReview: bad }))
      assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`)
    }

    const off = await withBypassContext(() => updateCompanySettings(me, { requireStockCountReview: false }))
    assert.equal(off.status, 200)
    assert.equal(((await orgSettings(org.orgId)).approvals as Record<string, unknown>).requireStockCountReview, false)
    const audits = await withBypassContext(async () =>
      (await db.execute<{ changes: Record<string, unknown> }>(sql`
        select changes from audit_log where org_id = ${org.orgId} and table_name = 'orgs' and action = 'update'`)).rows,
    )
    assert.ok(
      audits.some((row) => JSON.stringify(row.changes.requireStockCountReview) === '[false,true]'),
      `the ON flip is audited with before/after, got ${JSON.stringify(audits.map((row) => row.changes))}`,
    )
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})


const consolidatedRows = [
  { label: "company settings timezone", register: async () => {
        /**
         * Company Settings owns the org's business time zone: it reads the
         * effective zone (UTC when unset), validates and canonicalizes writes, and
         * audits the change. Aliases a runtime accepts but supportedValuesOf omits
         * (US/Eastern) store canonical and keep working; unknown zones refuse by
         * name instead of accruing UTC days.
         */
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
        const { businessTimeZone, businessToday } = await import('@openbooks/engine/src/platform/business-date.ts')
        const { readCompanySettings, updateCompanySettings } = await import('./company-settings')
        
        async function orgSettings(orgId: string) {
          return withBypassContext(async () =>
            (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${orgId}`)).rows[0]!.settings,
          )
        }
        
        async function audits(orgId: string) {
          return withBypassContext(async () =>
            (await db.execute<{ changes: Record<string, unknown> }>(sql`
              select changes from audit_log where org_id = ${orgId} and table_name = 'orgs' and action = 'update'`)).rows,
          )
        }
        
        test('business time zone defaults to UTC and round-trips through Company Settings', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
            const me = { orgId: org.orgId, id: actor }
        
            const before = await withBypassContext(() => readCompanySettings(org.orgId))
            assert.equal(before.status, 200)
            assert.equal((before.body.org as Record<string, unknown>).timeZone, 'UTC')
        
            const saved = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'America/Toronto' }))
            assert.equal(saved.status, 200)
            assert.equal((await orgSettings(org.orgId)).timeZone, 'America/Toronto')
            const after = await withBypassContext(() => readCompanySettings(org.orgId))
            assert.equal((after.body.org as Record<string, unknown>).timeZone, 'America/Toronto')
        
            // Sibling settings keys survive the merge (no clobber).
            const settings = await orgSettings(org.orgId)
            assert.ok(settings.controlAccounts, 'control accounts survive the time-zone write')
        
            // The change is audited with before/after state.
            const rows = await audits(org.orgId)
            assert.ok(
              rows.some((row) => JSON.stringify(row.changes.timeZone) === '[null,"America/Toronto"]'),
              `the zone flip is audited with before/after, got ${JSON.stringify(rows.map((row) => row.changes))}`,
            )
        
            // Saving the effective zone again is a no-op, not a second audit row.
            const auditCount = rows.length
            const repeat = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'America/Toronto' }))
            assert.equal(repeat.status, 200)
            assert.equal((await audits(org.orgId)).length, auditCount)
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
        
        test('an alias is canonicalized at save and days in its canonical zone', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
            const me = { orgId: org.orgId, id: actor }
        
            const saved = await withBypassContext(() => updateCompanySettings(me, { timeZone: 'US/Eastern' }))
            assert.equal(saved.status, 200)
            assert.equal((await orgSettings(org.orgId)).timeZone, 'America/New_York')
            const after = await withBypassContext(() => readCompanySettings(org.orgId))
            assert.equal((after.body.org as Record<string, unknown>).timeZone, 'America/New_York')
        
            // A stored alias drives business dates in its zone, never UTC:
            // 2026-09-23T03:30Z is still Sep 22 on the US east coast.
            await withBypassContext(() => withSimClock('2026-09-23T03:30:00Z', async () => {
              assert.equal(await businessTimeZone(org.orgId), 'America/New_York')
              assert.equal(await businessToday(org.orgId), '2026-09-22')
            }))
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
        
        test('an unknown zone is refused at save by name and stores nothing', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
            const me = { orgId: org.orgId, id: actor }
        
            for (const bad of ['Mars/Olympus_Mons', 'Not/AZone', 42, {}, []]) {
              const res = await withBypassContext(() => updateCompanySettings(me, { timeZone: bad }))
              assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`)
              assert.match(
                String((res.body as Record<string, unknown>).error),
                /not a known IANA time zone/,
                'the refusal names the defect, not just the field',
              )
            }
            assert.equal((await orgSettings(org.orgId)).timeZone, undefined)
            assert.equal((await audits(org.orgId)).length, 0)
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
        
        test('clearing the zone returns the org to the UTC default and audits the removal', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg())
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Admin', 'admin'))
            const me = { orgId: org.orgId, id: actor }
        
            assert.equal((await withBypassContext(() => updateCompanySettings(me, { timeZone: 'Pacific/Auckland' }))).status, 200)
            const cleared = await withBypassContext(() => updateCompanySettings(me, { timeZone: null }))
            assert.equal(cleared.status, 200)
            assert.equal((await orgSettings(org.orgId)).timeZone, undefined)
            const after = await withBypassContext(() => readCompanySettings(org.orgId))
            assert.equal((after.body.org as Record<string, unknown>).timeZone, 'UTC')
            const rows = await audits(org.orgId)
            assert.ok(
              rows.some((row) => JSON.stringify(row.changes.timeZone) === '["Pacific/Auckland",null]'),
              `the clear is audited with before/after, got ${JSON.stringify(rows.map((row) => row.changes))}`,
            )
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId))
          }
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();


const featureDefaultsCases = [
  { label: "features data defaults", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { sql } = await import("drizzle-orm");
        type FeatureState = import("./features.ts").FeatureState;
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
        const { seedFeatureDisableBookScope } = await import("../testing/report-fixtures.ts");

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

        test("feature defaults ignore secondary-book history", { skip: !DB }, async () => {
          const org = await createScratchOrg();
          try {
            await withBypassContext(() => db.execute(sql`
              update orgs set settings = '{}'::jsonb where id = ${org.orgId}`));
            assert.equal(await withBypassContext(() => isFeatureEnabled(org.orgId, "multiSubsidiary")), false);
            assert.equal(await checkInTx(org.orgId, "multiSubsidiary"), false);
            await seedFeatureDisableBookScope(org);
            const status = await withBypassContext(() => featureDisableStatuses(org.orgId, ['multiSubsidiary', 'multiCurrency', 'projects']));
            assert.equal(status.multiSubsidiary?.blocked, false);
            assert.equal(status.multiCurrency?.blocked, false);
            assert.ok(!status.projects?.impacts.some((impact) => impact.labelKey === 'outstandingRetainage'));
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });
  } },
] as const;

for (const row of featureDefaultsCases) await row.register();
