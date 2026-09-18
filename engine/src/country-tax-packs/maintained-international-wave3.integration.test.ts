import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../db.ts";
import { provisionTaxPacks } from "../tax-pack-provisioning.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const selections = ["IN_GSTR3B", "ZA_VAT201", "AE_VAT201", "JP_CONSUMPTION"] as const;

test(
  "third-wave maintained packs install atomically, preserve evidence, and rerun idempotently",
  { skip: !DB },
  async () => {
    const target = await withBypass(() => createScratchOrg());
    try {
      const first = await provisionTaxPacks(target.orgId, selections);
      assert.deepEqual(first.packs, selections);
      assert.equal(first.jurisdictionsCreated, 4);
      // Four packs declare five codes: IN/ZA/AE one each plus JP's
      // STD/RED pair. One-code-per-pack predates the JP reduced code.
      assert.equal(first.taxCodesCreated, 5);
      assert.equal(first.taxGroupsCreated, 4);
      assert.equal(first.registrationsCreated, 4);

      const state = await withOrgContext(target.orgId, async () => {
        const forms = (await db.execute(sql`
          select code from tax_return_forms
           where org_id = ${target.orgId} and code in ('IN_GSTR3B', 'ZA_VAT201', 'AE_VAT201', 'JP_CONSUMPTION')
           order by code
        `)).rows as Array<{ code: string }>;
        // The installer must create exactly the declared set: no fewer
        // (a dropped reduced-rate code) and no more (a duplicated insert).
        const declared = (await db.execute(sql`
          select code from tax_codes
           where org_id = ${target.orgId}
           order by code
        `)).rows as Array<{ code: string }>;
        const codes = (await db.execute(sql`
          select code.code, count(rate.id)::int as "rateCount"
            from tax_codes code
            join tax_rates rate on rate.org_id = code.org_id and rate.tax_code_id = code.id
           where code.org_id = ${target.orgId}
             and code.code in ('IN-GST-18', 'ZA-VAT-STD', 'AE-VAT-STD', 'JP-CT-STD')
           group by code.id, code.code
           order by code.code
        `)).rows as Array<{ code: string; rateCount: number }>;
        const manifests = (await db.execute(sql`
          select pack_code as "packCode", version, status,
                 manifest->>'country' as country,
                 manifest->'completeness'->>'standardRates' as "standardRates"
            from tax_country_pack_installations
           where org_id = ${target.orgId}
             and pack_code in ('IN_INDIRECT_TAX', 'ZA_INDIRECT_TAX', 'AE_INDIRECT_TAX', 'JP_INDIRECT_TAX')
           order by pack_code
        `)).rows as Array<{ packCode: string; version: string; status: string; country: string; standardRates: string }>;
        const counts = (await db.execute(sql`
          select
            (select count(*)::int from tax_registrations where org_id = ${target.orgId} and is_active) as registrations,
            (select count(*)::int from tax_report_lines where org_id = ${target.orgId} and report_code in ('IN_GSTR3B', 'ZA_VAT201', 'AE_VAT201', 'JP_CONSUMPTION')) as lines
        `)).rows[0] as { registrations: number; lines: number };
        return { forms, codes, declared, manifests, counts };
      });

      assert.deepEqual(state.forms.map((row) => row.code), ["AE_VAT201", "IN_GSTR3B", "JP_CONSUMPTION", "ZA_VAT201"]);
      assert.deepEqual(state.declared.map((row) => row.code), [
        "AE-VAT-STD",
        "IN-GST-18",
        "JP-CT-RED",
        "JP-CT-STD",
        "ZA-VAT-STD",
      ]);
      assert.deepEqual(state.codes.map((row) => [row.code, row.rateCount]), [
        ["AE-VAT-STD", 1],
        ["IN-GST-18", 1],
        ["JP-CT-STD", 4],
        ["ZA-VAT-STD", 3],
      ]);
      assert.equal(state.manifests.length, 4);
      assert.ok(state.manifests.every((row) => row.version === "2026.08.01" && row.status === "active"));
      assert.equal(state.manifests.find((row) => row.country === "IN")?.standardRates, "partial");
      assert.equal(state.manifests.find((row) => row.country === "ZA")?.standardRates, "complete");
      assert.equal(state.manifests.find((row) => row.country === "AE")?.standardRates, "complete");
      assert.equal(state.manifests.find((row) => row.country === "JP")?.standardRates, "complete");
      assert.equal(state.counts.registrations, 4);
      // 71 statutory boxes plus 2 workpaper rows fanned out over JP-CT-RED;
      // every (report, line, code) triple is distinct.
      assert.equal(state.counts.lines, 73);

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
