import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withOrg } from "../platform/db.ts";
import { loadEntities } from "./migrate.ts";
import type { MigrationSource } from "./source.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!env.OPENBOOKS_DB_URL;

test(
  "master-data row upsert failures are reported separately with their source error",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
        name: "migration-test",
        refKey: "migrationTest",
        baseCurrency: "CAD",
        accountingPeriods: async () => [],
        entities: async () => [],
        nativeChanges: async () => {
          throw new Error("not used by this test");
        },
        trialBalance: async () => [],
        monthlyActivity: async () => [],
      };
      const stats = await withOrg(org.orgId, () =>
        loadEntities(
          source,
          org.orgId,
          null,
          undefined,
          undefined,
          [
            {
              resource: "items",
              records: [
                {
                  sourceRef: "broken-item",
                  fields: {
                    name: "Broken item",
                    kind: "service",
                    defaultCost: "not-a-decimal",
                  },
                },
                {
                  sourceRef: "good-item",
                  fields: { name: "Good item", kind: "service" },
                },
              ],
            },
          ],
        ),
      );

      assert.deepEqual(stats.items, {
        created: 1,
        updated: 0,
        skipped: 0,
        failed: 1,
        errors: [
          {
            sourceRef: "broken-item",
            message: "item default cost must be an exact decimal",
          },
        ],
      });
      const landed = await withOrg(org.orgId, () =>
        db.execute<{ sourceRef: string }>(sql`
          select custom->>'migrationTest' as "sourceRef"
            from items
           where org_id = ${org.orgId}
             and custom->>'migrationTest' = 'good-item'
        `),
      );
      assert.deepEqual(landed.rows, [{ sourceRef: "good-item" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "master-data row failures carry the database SQLSTATE and cause",
  { skip: !DB },
  async () => {
    // A database rejection behind a driver wrapper must not be recorded as a
    // bare "Failed query: …": the run summary needs the SQLSTATE and the
    // reason or the next 42702 hides the same way. A non-numeric credit limit
    // reaches PostgreSQL raw (the loader passes it through) and fails with
    // 22P02 invalid_text_representation.
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
        name: "migration-test",
        refKey: "migrationTest",
        baseCurrency: "CAD",
        accountingPeriods: async () => [],
        entities: async () => [],
        nativeChanges: async () => {
          throw new Error("not used by this test");
        },
        trialBalance: async () => [],
        monthlyActivity: async () => [],
      };
      const stats = await withOrg(org.orgId, () =>
        loadEntities(
          source,
          org.orgId,
          null,
          undefined,
          undefined,
          [
            {
              resource: "parties",
              records: [
                {
                  sourceRef: "bad-credit",
                  fields: {
                    displayName: "Bad Credit Co",
                    kind: "company",
                    customerRole: { creditLimit: "not-a-decimal" },
                  },
                },
              ],
            },
          ],
        ),
      );
      assert.equal(stats.parties?.failed ?? -1, 1);
      const message = stats.parties?.errors[0]?.message ?? "";
      assert.match(message, /Failed query: insert into customer_roles/);
      assert.match(message, /SQLSTATE 22P02/);
      assert.match(message, /invalid input syntax|invalid_text_representation/i);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "master-data mirror updates persist instead of failing on connector identity",
  { skip: !DB },
  async () => {
    // Every mirror re-upserts master data it already landed. The subsidiary,
    // payment-term, tax-code, and party update paths merge the connector
    // identity back into custom with jsonb_build_object — with both key and
    // value as untyped bound parameters, PostgreSQL cannot infer a type and
    // rejects the write, so every one of those updates lands in failed++
    // while the run reports success. (Tax-code coverage rides with the rate-
    // window tests below, which exercise the same update path.)
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
        name: "migration-test",
        refKey: "migrationTest",
        baseCurrency: "CAD",
        accountingPeriods: async () => [],
        entities: async () => [],
        nativeChanges: async () => {
          throw new Error("not used by this test");
        },
        trialBalance: async () => [],
        monthlyActivity: async () => [],
      };
      await withOrg(org.orgId, () => db.execute(sql`
        insert into subsidiaries (org_id, parent_id, name, base_currency, country, custom)
        values (${org.orgId}, ${org.subsidiaryId}, 'Old Sub', 'CAD', 'CA',
                '{"migrationTest": "SUB-1"}'::jsonb)
      `));
      await withOrg(org.orgId, () => db.execute(sql`
        insert into parties (org_id, kind, display_name, custom)
        values (${org.orgId}, 'company', 'Old Party', '{"migrationTest": "PTY-1"}'::jsonb)
      `));
      await withOrg(org.orgId, () => db.execute(sql`
        insert into payment_terms (org_id, name, net_days, custom)
        values (${org.orgId}, 'Old Term', 30, '{"migrationTest": "TRM-1"}'::jsonb)
      `));
      const stats = await withOrg(org.orgId, () =>
        loadEntities(source, org.orgId, null, undefined, undefined, [
          {
            resource: "subsidiaries",
            records: [
              { sourceRef: "SUB-1", fields: { name: "New Sub", baseCurrency: "CAD", country: "CA" } },
            ],
          },
          {
            resource: "parties",
            records: [
              { sourceRef: "PTY-1", fields: { displayName: "New Party", kind: "company" } },
            ],
          },
          {
            resource: "payment_terms",
            records: [
              { sourceRef: "TRM-1", fields: { name: "New Term", netDays: 45 } },
            ],
          },
        ]),
      );
      assert.deepEqual(
        [stats.subsidiaries?.updated, stats.parties?.updated, stats.payment_terms?.updated],
        [1, 1, 1],
      );
      assert.deepEqual(
        [stats.subsidiaries?.failed, stats.parties?.failed, stats.payment_terms?.failed],
        [0, 0, 0],
      );
      const names = await withOrg(org.orgId, () => db.execute<{ name: string }>(sql`
        select name from subsidiaries where org_id = ${org.orgId} and custom->>'migrationTest' = 'SUB-1'
        union all
        select display_name as name from parties where org_id = ${org.orgId} and custom->>'migrationTest' = 'PTY-1'
        union all
        select name from payment_terms where org_id = ${org.orgId} and custom->>'migrationTest' = 'TRM-1'
      `));
      assert.deepEqual(names.rows.map((row) => row.name).sort(), ["New Party", "New Sub", "New Term"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "tax-code mirrors never rewrite closed or future rate windows",
  { skip: !DB },
  async () => {
    // Rate windows are dated statutory history: the calculation engine
    // resolves the rate for a document's own date, so rewriting every window
    // to the source's current rate reinterprets history (and destroys a
    // tenant-planned future window). Only the currently open window states
    // the source's current rate.
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
        name: "migration-test",
        refKey: "migrationTest",
        baseCurrency: "CAD",
        accountingPeriods: async () => [],
        entities: async () => [],
        nativeChanges: async () => {
          throw new Error("not used by this test");
        },
        trialBalance: async () => [],
        monthlyActivity: async () => [],
      };
      const [code] = await withOrg(org.orgId, () =>
        db.execute<{ id: string }>(sql`
          insert into tax_codes (org_id, code, name, applies_to, custom)
          values (${org.orgId}, 'TAX-HIST', 'History Tax', 'both',
                  '{"migrationTest": "TAX-HIST"}'::jsonb)
          returning id
        `),
      ).then((r) => r.rows);
      await withOrg(org.orgId, () => db.execute(sql`
        insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, effective_to)
        values (${org.orgId}, ${code!.id}, '5.0000', '2020-01-01', '2022-12-31'),
               (${org.orgId}, ${code!.id}, '13.0000', '2023-01-01', '2026-12-31'),
               (${org.orgId}, ${code!.id}, '15.0000', '2027-01-01', null)
      `));
      const stats = await withOrg(org.orgId, () =>
        loadEntities(source, org.orgId, null, undefined, undefined, [
          {
            resource: "tax_codes",
            records: [
              {
                sourceRef: "TAX-HIST",
                fields: { code: "TAX-HIST", name: "History Tax", ratePercent: "13" },
              },
            ],
          },
        ]),
      );
      assert.equal(stats.tax_codes?.updated, 1);
      const windows = await withOrg(org.orgId, () =>
        db.execute<{ rate: string; from: string; to: string | null }>(sql`
          select rate_percent::text as rate, effective_from::text as "from",
                 effective_to::text as "to"
            from tax_rates
           where org_id = ${org.orgId} and tax_code_id = ${code!.id}
           order by effective_from
        `),
      );
      assert.deepEqual(
        windows.rows.map((row) => [row.rate, row.from, row.to]),
        [
          ["5.0000", "2020-01-01", "2022-12-31"],
          ["13.0000", "2023-01-01", "2026-12-31"],
          ["15.0000", "2027-01-01", null],
        ],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "tax-code mirrors still land the source rate on the open current window",
  { skip: !DB },
  async () => {
    // Guard against overcorrection: the loader-created single open-ended
    // window states the source's current rate and must keep tracking it.
    const org = await createScratchOrg();
    try {
      const source: MigrationSource = {
        name: "migration-test",
        refKey: "migrationTest",
        baseCurrency: "CAD",
        accountingPeriods: async () => [],
        entities: async () => [],
        nativeChanges: async () => {
          throw new Error("not used by this test");
        },
        trialBalance: async () => [],
        monthlyActivity: async () => [],
      };
      const stats = await withOrg(org.orgId, () =>
        loadEntities(source, org.orgId, null, undefined, undefined, [
          {
            resource: "tax_codes",
            records: [
              {
                sourceRef: "TAX-OPEN",
                fields: { code: "TAX-OPEN", name: "Open Tax", ratePercent: "5" },
              },
            ],
          },
        ]),
      );
      assert.equal(stats.tax_codes?.created, 1);
      const again = await withOrg(org.orgId, () =>
        loadEntities(source, org.orgId, null, undefined, undefined, [
          {
            resource: "tax_codes",
            records: [
              {
                sourceRef: "TAX-OPEN",
                fields: { code: "TAX-OPEN", name: "Open Tax", ratePercent: "13" },
              },
            ],
          },
        ]),
      );
      assert.equal(again.tax_codes?.updated, 1);
      const windows = await withOrg(org.orgId, () =>
        db.execute<{ rate: string }>(sql`
          select rate_percent::text as rate
            from tax_rates tr
            join tax_codes tc on tc.id = tr.tax_code_id and tc.org_id = tr.org_id
           where tr.org_id = ${org.orgId} and tc.code = 'TAX-OPEN'
        `),
      );
      assert.deepEqual(windows.rows, [{ rate: "13.0000" }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

