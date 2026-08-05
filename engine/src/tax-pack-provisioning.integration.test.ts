import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { db, withBypass, withOrgContext, withOrgTransaction } from "./db.ts";
import { provisionTaxPacks } from "./tax-pack-provisioning.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

test(
  "country tax packs install atomically, idempotently, and remain tenant isolated",
  { skip: !DB || !RUNTIME_DB },
  async () => {
    const target = await withBypass(() => createScratchOrg());
    const other = await withBypass(() => createScratchOrg());
    try {
      const first = await provisionTaxPacks(target.orgId, [
        "JURISDICTION:CA-ON",
        "JURISDICTION:US-NM",
      ]);
      assert.ok(first.jurisdictionsCreated >= 4);
      assert.ok(first.taxCodesCreated >= 3);
      assert.ok(first.registrationsCreated >= 2);

      const installed = await withOrgContext(target.orgId, async () => {
        const jurisdictions = (await db.execute(sql`
          select code from tax_jurisdictions
           where org_id = ${target.orgId}
             and code in ('CA', 'CA-ON', 'US', 'US-NM')
           order by code
        `)).rows as Array<{ code: string }>;
        const codes = (await db.execute(sql`
          select code.code,
                 coalesce(
                   jsonb_agg(
                     jsonb_build_object(
                       'rate', rate.rate_percent::text,
                       'from', rate.effective_from::text,
                       'to', rate.effective_to::text
                     ) order by rate.effective_from
                   ) filter (where rate.id is not null),
                   '[]'::jsonb
                 ) as rates
            from tax_codes code
            left join tax_rates rate
              on rate.org_id = code.org_id and rate.tax_code_id = code.id
           where code.org_id = ${target.orgId}
             and code.code in ('CA-GST', 'CA-ON-HST', 'US-NM-GRT')
           group by code.id, code.code
           order by code.code
        `)).rows as Array<{
          code: string;
          rates: Array<{ rate: string; from: string; to: string | null }>;
        }>;
        const forms = (await db.execute(sql`
          select code from tax_return_forms
           where org_id = ${target.orgId}
             and code in ('CA_GST34', 'US_SALES_TAX_WORKPAPER')
           order by code
        `)).rows as Array<{ code: string }>;
        const manifests = (await db.execute(sql`
          select pack_code as "packCode", version, status
            from tax_country_pack_installations
           where org_id = ${target.orgId}
           order by pack_code
        `)).rows as Array<{ packCode: string; version: string; status: string }>;
        const registrations = (await db.execute(sql`
          select jurisdiction.code, registration.is_active as "isActive",
                 registration.return_form_code as "returnFormCode"
            from tax_registrations registration
            join tax_jurisdictions jurisdiction
              on jurisdiction.id = registration.jurisdiction_id
             and jurisdiction.org_id = registration.org_id
           where registration.org_id = ${target.orgId}
             and jurisdiction.code in ('CA', 'US-NM')
           order by jurisdiction.code
        `)).rows as Array<{ code: string; isActive: boolean; returnFormCode: string | null }>;
        return { jurisdictions, codes, forms, manifests, registrations };
      });

      assert.deepEqual(installed.jurisdictions.map((row) => row.code), ["CA", "CA-ON", "US", "US-NM"]);
      assert.deepEqual(installed.forms.map((row) => row.code), ["CA_GST34", "US_SALES_TAX_WORKPAPER"]);
      assert.deepEqual(installed.manifests, [
        { packCode: "CA_INDIRECT_TAX", version: "2026.07.31", status: "active" },
        { packCode: "US_INDIRECT_TAX", version: "2026.08.01", status: "active" },
      ]);
      assert.deepEqual(installed.registrations, [
        { code: "CA", isActive: true, returnFormCode: "CA_GST34" },
        { code: "US-NM", isActive: false, returnFormCode: null },
      ]);
      assert.deepEqual(
        installed.codes.find((row) => row.code === "US-NM-GRT")?.rates,
        [
          { rate: "5.0000", from: "2022-07-01", to: "2023-06-30" },
          { rate: "4.8750", from: "2023-07-01", to: null },
        ],
      );

      const second = await provisionTaxPacks(target.orgId, [
        "JURISDICTION:CA-ON",
        "JURISDICTION:US-NM",
      ]);
      assert.equal(second.jurisdictionsCreated, 0);
      assert.equal(second.taxCodesCreated, 0);
      assert.equal(second.taxGroupsCreated, 0);
      assert.equal(second.registrationsCreated, 0);

      const runtimeClient = new pg.Client({ connectionString: RUNTIME_DB });
      await runtimeClient.connect();
      let hidden: number;
      try {
        await runtimeClient.query(
          "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
          [other.orgId],
        );
        const result = await runtimeClient.query<{ count: number }>(
          "select count(*)::int as count from tax_codes where org_id = $1",
          [target.orgId],
        );
        hidden = Number(result.rows[0]?.count ?? 0);
      } finally {
        await runtimeClient.end();
      }
      assert.equal(hidden, 0);
    } finally {
      await withBypass(() => dropScratchOrg(other.orgId));
      await withBypass(() => dropScratchOrg(target.orgId));
    }
  },
);

test(
  "a conflicting tenant tax code rolls the complete pack installation back",
  { skip: !DB },
  async () => {
    const target = await withBypass(() => createScratchOrg());
    try {
      await withOrgTransaction(target.orgId, async () => {
        await db.execute(sql`
          insert into tax_codes
            (org_id, code, name, country, region, applies_to, is_active)
          values (
            ${target.orgId}, 'US-NM-GRT', 'Conflicting tenant code',
            'US', 'NM', 'both', true
          )
        `);
      });

      await assert.rejects(
        provisionTaxPacks(target.orgId, ["JURISDICTION:US-NM"]),
        /tax code US-NM-GRT conflicts with the versioned country pack/,
      );

      const state = await withOrgContext(target.orgId, async () => {
        const result = await db.execute(sql`
          select
            (select count(*)::int from tax_codes where org_id = ${target.orgId} and code = 'US-NM-GRT') as codes,
            (select count(*)::int from tax_jurisdictions where org_id = ${target.orgId} and code in ('US', 'US-NM')) as jurisdictions,
            (select count(*)::int from tax_return_forms where org_id = ${target.orgId} and code = 'US_SALES_TAX_WORKPAPER') as forms,
            (select count(*)::int from tax_registrations where org_id = ${target.orgId}) as registrations,
            (select count(*)::int from tax_country_pack_installations where org_id = ${target.orgId}) as manifests
        `);
        return result.rows[0] as {
          codes: number;
          jurisdictions: number;
          forms: number;
          registrations: number;
          manifests: number;
        };
      });
      assert.deepEqual(state, {
        codes: 1,
        jurisdictions: 0,
        forms: 0,
        registrations: 0,
        manifests: 0,
      });
    } finally {
      await withBypass(() => dropScratchOrg(target.orgId));
    }
  },
);
