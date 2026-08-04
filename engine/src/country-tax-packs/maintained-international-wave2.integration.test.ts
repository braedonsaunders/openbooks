import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../db.ts";
import { provisionTaxPacks } from "../tax-pack-provisioning.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const selections = ["ES_MODELO303", "IT_LIPE", "NL_OB", "IE_VAT3", "SG_GSTF5"] as const;

test(
  "second-wave maintained packs install atomically, preserve evidence, and rerun idempotently",
  { skip: !DB },
  async () => {
    const target = await withBypass(() => createScratchOrg());
    try {
      const first = await provisionTaxPacks(target.orgId, selections);
      assert.deepEqual(first.packs, selections);
      assert.equal(first.jurisdictionsCreated, 5);
      assert.equal(first.taxCodesCreated, 5);
      assert.equal(first.taxGroupsCreated, 5);
      assert.equal(first.registrationsCreated, 5);

      const state = await withOrgContext(target.orgId, async () => {
        const forms = (await db.execute(sql`
          select code from tax_return_forms
           where org_id = ${target.orgId} and code in ('ES_MODELO303', 'IT_LIPE', 'NL_OB', 'IE_VAT3', 'SG_GSTF5')
           order by code
        `)).rows as Array<{ code: string }>;
        const codes = (await db.execute(sql`
          select code.code, count(rate.id)::int as "rateCount",
                 max(rate.rate_percent)::text as "maximumRate"
            from tax_codes code
            join tax_rates rate on rate.org_id = code.org_id and rate.tax_code_id = code.id
           where code.org_id = ${target.orgId}
             and code.code in ('ES-VAT-STD', 'IT-VAT-STD', 'NL-VAT-STD', 'IE-VAT-STD', 'SG-GST')
           group by code.id, code.code
           order by code.code
        `)).rows as Array<{ code: string; rateCount: number; maximumRate: string }>;
        const manifests = (await db.execute(sql`
          select pack_code as "packCode", version, status,
                 manifest->>'country' as country,
                 manifest->'completeness'->>'standardRates' as "standardRates"
            from tax_country_pack_installations
           where org_id = ${target.orgId}
             and pack_code in ('ES_INDIRECT_TAX', 'IT_INDIRECT_TAX', 'NL_INDIRECT_TAX', 'IE_INDIRECT_TAX', 'SG_INDIRECT_TAX')
           order by pack_code
        `)).rows as Array<{ packCode: string; version: string; status: string; country: string; standardRates: string }>;
        const counts = (await db.execute(sql`
          select
            (select count(*)::int from tax_registrations where org_id = ${target.orgId} and is_active) as registrations,
            (select count(*)::int from tax_report_lines where org_id = ${target.orgId} and report_code in ('ES_MODELO303', 'IT_LIPE', 'NL_OB', 'IE_VAT3', 'SG_GSTF5')) as lines
        `)).rows[0] as { registrations: number; lines: number };
        return { forms, codes, manifests, counts };
      });

      assert.deepEqual(state.forms.map((row) => row.code), ["ES_MODELO303", "IE_VAT3", "IT_LIPE", "NL_OB", "SG_GSTF5"]);
      assert.deepEqual(state.codes.map((row) => [row.code, row.rateCount]), [
        ["ES-VAT-STD", 1],
        ["IE-VAT-STD", 17],
        ["IT-VAT-STD", 1],
        ["NL-VAT-STD", 3],
        ["SG-GST", 6],
      ]);
      assert.equal(state.manifests.length, 5);
      assert.ok(state.manifests.every((row) => row.version === "2026.08.01" && row.status === "active"));
      assert.equal(state.manifests.find((row) => row.country === "ES")?.standardRates, "partial");
      assert.equal(state.manifests.find((row) => row.country === "IE")?.standardRates, "complete");
      assert.equal(state.manifests.find((row) => row.country === "SG")?.standardRates, "complete");
      assert.equal(state.counts.registrations, 5);
      assert.equal(state.counts.lines, 60);

      const second = await provisionTaxPacks(target.orgId, selections);
      assert.equal(second.jurisdictionsCreated, 0);
      assert.equal(second.taxCodesCreated, 0);
      assert.equal(second.taxGroupsCreated, 0);
      assert.equal(second.registrationsCreated, 0);
    } finally {
      await withBypass(() => dropScratchOrg(target.orgId));
    }
  },
);
