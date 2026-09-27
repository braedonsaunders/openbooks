import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { provisionTaxPacks } from "../tax/pack-provisioning.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { countryTaxPackForReturn, packTaxCodesForReturn } from "./index.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Country-level returns installed together, and the report lines they must
 * produce: one row per box, fanned out once per tax code on the workpaper
 * boxes, which sum every configured rate. Each count is verified against the
 * pack sources.
 */
const GROUPS = [
  // AU 5 + 2x1, NZ 9 + 2x1, GB 5 + 4x3, DE 9 + 2x2, FR 12 + 2x3: 52 boxes.
  { selections: ["AU_BAS_GST", "NZ_GST101A", "GB_VAT100", "DE_USTVA", "FR_CA3"], reportLines: 66 },
  // 66 boxes plus 18 rows fanned out over the reduced-rate codes.
  { selections: ["ES_MODELO303", "IT_LIPE", "NL_OB", "IE_VAT3", "SG_GSTF5"], reportLines: 84 },
  // 71 statutory boxes plus the two workpaper rows fanned out over JP-CT-RED.
  { selections: ["IN_GSTR3B", "ZA_VAT201", "AE_VAT201", "JP_CONSUMPTION"], reportLines: 73 },
];

const byFirst = (a: readonly unknown[], b: readonly unknown[]) => String(a[0]).localeCompare(String(b[0]));

for (const { selections, reportLines } of GROUPS) {
  test(`${selections.join(", ")} install atomically, preserve evidence, and rerun idempotently`, { skip: !DB }, async () => {
    const packs = selections.map((selection) => {
      const pack = countryTaxPackForReturn(selection);
      assert.ok(pack, `${selection} belongs to no country pack`);
      return pack;
    });
    // The installer must create exactly the declared set: no fewer (a
    // dropped reduced-rate code or rate era) and no more (a duplicated insert).
    const declaredCodes = selections
      .flatMap((selection, index) => packTaxCodesForReturn(packs[index]!, selection))
      .map((code) => [code.code, code.rates?.length ?? 0])
      .sort(byFirst);
    const declaredManifests = packs
      .map((pack) => [pack.code, pack.version, "active", pack.completeness.standardRates])
      .sort(byFirst);
    const inList = (values: readonly string[]) => sql.join(values.map((value) => sql`${value}`), sql`, `);

    const target = await withBypass(() => createScratchOrg());
    try {
      const first = await provisionTaxPacks(target.orgId, selections);
      assert.deepEqual(first.packs, selections);
      assert.equal(first.jurisdictionsCreated, selections.length);
      assert.equal(first.taxCodesCreated, declaredCodes.length);
      assert.equal(first.taxGroupsCreated, selections.length);
      assert.equal(first.registrationsCreated, selections.length);

      const readState = () => withOrgContext(target.orgId, async () => {
        const forms = (await db.execute(sql`
          select code from tax_return_forms where org_id = ${target.orgId} and code in (${inList(selections)})
        `)).rows as Array<{ code: string }>;
        const codes = (await db.execute(sql`
          select code.code, count(rate.id)::int as "rateCount"
            from tax_codes code
            left join tax_rates rate on rate.org_id = code.org_id and rate.tax_code_id = code.id
           where code.org_id = ${target.orgId}
           group by code.id, code.code
        `)).rows as Array<{ code: string; rateCount: number }>;
        const manifests = (await db.execute(sql`
          select pack_code as "packCode", version, status,
                 manifest->'completeness'->>'standardRates' as "standardRates"
            from tax_country_pack_installations
           where org_id = ${target.orgId} and pack_code in (${inList(packs.map((pack) => pack.code))})
        `)).rows as Array<{ packCode: string; version: string; status: string; standardRates: string }>;
        const counts = (await db.execute(sql`
          select
            (select count(*)::int from tax_registrations where org_id = ${target.orgId} and is_active) as registrations,
            (select count(*)::int from tax_report_lines where org_id = ${target.orgId} and report_code in (${inList(selections)})) as lines
        `)).rows[0] as { registrations: number; lines: number };
        return {
          forms: forms.map((row) => row.code).sort(),
          codes: codes.map((row) => [row.code, row.rateCount]).sort(byFirst),
          manifests: manifests.map((row) => [row.packCode, row.version, row.status, row.standardRates]).sort(byFirst),
          counts,
        };
      });
      const state = await readState();
      assert.deepEqual(state.forms, [...selections].sort());
      assert.deepEqual(state.codes, declaredCodes);
      assert.deepEqual(state.manifests, declaredManifests);
      assert.deepEqual(state.counts, { registrations: selections.length, lines: reportLines });

      const second = await provisionTaxPacks(target.orgId, selections);
      assert.equal(second.jurisdictionsCreated, 0);
      assert.equal(second.taxCodesCreated, 0);
      assert.equal(second.taxGroupsCreated, 0);
      assert.equal(second.registrationsCreated, 0);
      // The rerun deletes and reinserts each form's lines: the evidence must
      // be exactly restored, not doubled or dropped.
      assert.deepEqual(await readState(), state);
    } finally {
      await withBypass(() => dropScratchOrg(target.orgId));
    }
  });
}
