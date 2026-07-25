import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { installTaxReturnPacks, taxReturnPack, TAX_RETURN_PACKS } from "./seed-tax-forms.ts";

/**
 * One-click country provisioning for INDIRECT tax (sales tax / GST / VAT).
 *
 * Picking a country (and, where supported, its states/provinces) installs the
 * whole indirect-tax stack for that jurisdiction: the jurisdiction record, a
 * standard tax code with its rate, the government return form and boxes (mapped
 * to that code), and a nexus registration. This turns "set up tax for the places
 * I do business" into a single action instead of hand-building every entity.
 *
 * Everything is idempotent, so re-running for an already-provisioned country
 * adds nothing and never duplicates.
 */

export interface DefaultTaxCode {
  code: string;
  name: string;
  ratePercent: number;
}

/**
 * The standard tax code seeded per pack. One code per jurisdiction at its
 * headline rate — a working starting point the user refines (extra rate bands,
 * local/district rates, exemptions). US state rates are the STATE base rate only;
 * local/district rates are layered on per the workpaper.
 */
export const PACK_DEFAULT_CODES: Record<string, DefaultTaxCode> = {
  CA_GST34: { code: "CA-GST", name: "GST", ratePercent: 5 },
  CA_BC_PST: { code: "CA-BC-PST", name: "British Columbia PST", ratePercent: 7 },
  CA_SK_PST: { code: "CA-SK-PST", name: "Saskatchewan PST", ratePercent: 6 },
  CA_MB_RST: { code: "CA-MB-RST", name: "Manitoba RST", ratePercent: 7 },
  CA_QC_QST: { code: "CA-QC-QST", name: "Québec QST", ratePercent: 9.975 },
  GB_VAT100: { code: "GB-VAT", name: "VAT (standard 20%)", ratePercent: 20 },
  AU_BAS_GST: { code: "AU-GST", name: "GST", ratePercent: 10 },
  NZ_GST101A: { code: "NZ-GST", name: "GST", ratePercent: 15 },
  US_SALES_TAX_WORKPAPER: { code: "US-SALES", name: "US sales tax (set per jurisdiction)", ratePercent: 0 },
  DE_USTVA: { code: "DE-VAT", name: "Umsatzsteuer (standard 19%)", ratePercent: 19 },
  FR_CA3: { code: "FR-TVA", name: "TVA (standard 20%)", ratePercent: 20 },
  ES_MODELO303: { code: "ES-IVA", name: "IVA (standard 21%)", ratePercent: 21 },
  IT_LIPE: { code: "IT-IVA", name: "IVA (standard 22%)", ratePercent: 22 },
  NL_OB: { code: "NL-BTW", name: "BTW (high 21%)", ratePercent: 21 },
  IE_VAT3: { code: "IE-VAT", name: "VAT (standard 23%)", ratePercent: 23 },
  IN_GSTR3B: { code: "IN-GST", name: "GST (standard 18%)", ratePercent: 18 },
  SG_GSTF5: { code: "SG-GST", name: "GST", ratePercent: 9 },
  ZA_VAT201: { code: "ZA-VAT", name: "VAT", ratePercent: 15 },
  AE_VAT201: { code: "AE-VAT", name: "VAT", ratePercent: 5 },
  JP_CONSUMPTION: { code: "JP-JCT", name: "Consumption tax (standard 10%)", ratePercent: 10 },
  US_CA_CDTFA401: { code: "US-CA-ST", name: "California state sales tax", ratePercent: 7.25 },
  US_TX_01114: { code: "US-TX-ST", name: "Texas state sales tax", ratePercent: 6.25 },
  US_NY_ST100: { code: "US-NY-ST", name: "New York state sales tax", ratePercent: 4 },
  US_FL_DR15: { code: "US-FL-ST", name: "Florida state sales tax", ratePercent: 6 },
};

export interface SupportedSubJurisdiction {
  packCode: string;
  region: string;
  name: string;
}

export interface SupportedCountry {
  country: string;
  name: string;
  /** The country-level pack, if any (e.g. US sales-tax workpaper, CA GST34). */
  countryPack: string | null;
  /** State/province packs available under this country. */
  subs: SupportedSubJurisdiction[];
}

/**
 * The catalog of countries the setup wizard can provision, derived from the
 * installed packs. Country-level packs (level country/federal) become the country
 * entry; state-level packs become selectable sub-jurisdictions.
 */
export function supportedTaxCountries(): SupportedCountry[] {
  const byCountry = new Map<string, SupportedCountry>();
  for (const pack of TAX_RETURN_PACKS) {
    const j = pack.jurisdiction;
    let entry = byCountry.get(j.country);
    if (!entry) {
      entry = { country: j.country, name: j.country, countryPack: null, subs: [] };
      byCountry.set(j.country, entry);
    }
    if (j.level === "state" || j.level === "county" || j.level === "city") {
      entry.subs.push({ packCode: pack.code, region: j.region ?? j.code, name: j.name });
    } else {
      entry.countryPack = pack.code;
      // Prefer the country jurisdiction's own name for the country label.
      entry.name = j.name;
    }
  }
  return [...byCountry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface ProvisionResult {
  packs: string[];
  jurisdictionsCreated: number;
  taxCodesCreated: number;
  taxGroupsCreated: number;
  registrationsCreated: number;
}

/**
 * Provision the full indirect-tax stack for a set of packs: jurisdiction, tax
 * code + rate, return form + boxes, and a nexus registration. Idempotent.
 */
export async function provisionTaxPacks(
  orgId: string,
  packCodes: readonly string[],
  actorId: string | null = null,
): Promise<ProvisionResult> {
  const codes = [...new Set(packCodes)];
  const packs = codes.map((c) => {
    const p = taxReturnPack(c);
    if (!p) throw new Error(`unknown tax return pack "${c}"`);
    return p;
  });

  let jurisdictionsCreated = 0;
  let taxCodesCreated = 0;
  let taxGroupsCreated = 0;

  // 1) Jurisdictions + tax codes + rates + a per-jurisdiction tax group BEFORE
  //    installing packs, so each pack's boxes map to the jurisdiction's own code.
  await db.transaction(async (tx) => {
    for (const pack of packs) {
      const j = pack.jurisdiction;
      const jur = (await tx.execute(sql`
        insert into tax_jurisdictions
          (org_id, code, name, country, region, level, tax_type, is_active, created_by, updated_by)
        values (${orgId}, ${j.code}, ${j.name}, ${j.country}, ${j.region ?? null}, ${j.level}, ${j.taxType}, true, ${actorId}, ${actorId})
        on conflict (org_id, code) do update set name = excluded.name, updated_at = now(), updated_by = ${actorId}
        returning id, (xmax = 0) as inserted`)) as unknown as { rows: { id: string; inserted: boolean }[] };
      const jurisdictionId = jur.rows[0]?.id ?? null;
      if (jur.rows[0]?.inserted) jurisdictionsCreated++;

      const def = PACK_DEFAULT_CODES[pack.code];
      if (!def) continue;

      // Tax code (idempotent) + its rate.
      const inserted = (await tx.execute(sql`
        insert into tax_codes (org_id, code, name, jurisdiction_id, country, region, applies_to, is_active, created_by, updated_by)
        select ${orgId}, ${def.code}, ${def.name}, ${jurisdictionId}, ${j.country}, ${j.region ?? null}, 'both', true, ${actorId}, ${actorId}
         where not exists (select 1 from tax_codes where org_id = ${orgId} and code = ${def.code})
        returning id`)) as unknown as { rows: { id: string }[] };
      let codeId = inserted.rows[0]?.id ?? null;
      if (codeId) {
        taxCodesCreated++;
        await tx.execute(sql`
          insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
          values (${orgId}, ${codeId}, ${def.ratePercent}, '2000-01-01', ${actorId}, ${actorId})`);
      } else {
        const existing = (await tx.execute(sql`
          select id from tax_codes where org_id = ${orgId} and code = ${def.code} limit 1`)) as unknown as { rows: { id: string }[] };
        codeId = existing.rows[0]?.id ?? null;
      }

      // Tax group bundling the jurisdiction's code — ready for compound cases
      // (extra rate bands / local taxes applied together on a line).
      const groupCode = `${j.code}-TAX`;
      const grp = (await tx.execute(sql`
        insert into tax_groups (org_id, code, name, is_active)
        select ${orgId}, ${groupCode}, ${`${j.name} tax`}, true
         where not exists (select 1 from tax_groups where org_id = ${orgId} and code = ${groupCode})
        returning id`)) as unknown as { rows: { id: string }[] };
      if (grp.rows[0]) taxGroupsCreated++;
      const groupId =
        grp.rows[0]?.id ??
        ((await tx.execute(sql`select id from tax_groups where org_id = ${orgId} and code = ${groupCode} limit 1`)) as unknown as { rows: { id: string }[] }).rows[0]?.id ??
        null;
      if (groupId && codeId) {
        await tx.execute(sql`
          insert into tax_group_members (tax_group_id, tax_code_id, sequence)
          select ${groupId}, ${codeId}, 1
           where not exists (select 1 from tax_group_members where tax_group_id = ${groupId} and tax_code_id = ${codeId})`);
      }
    }
  });

  // 2) Install the return forms + boxes (maps to the codes just created).
  await installTaxReturnPacks(orgId, codes, actorId);

  // 3) Nexus registrations — one per jurisdiction/return, if not already present.
  let registrationsCreated = 0;
  await db.transaction(async (tx) => {
    for (const pack of packs) {
      const res = (await tx.execute(sql`
        insert into tax_registrations
          (org_id, jurisdiction_id, filing_frequency, return_form_code, is_active, created_by, updated_by)
        select ${orgId}, j.id, ${pack.defaultFrequency}, ${pack.code}, true, ${actorId}, ${actorId}
          from tax_jurisdictions j
         where j.org_id = ${orgId} and j.code = ${pack.jurisdiction.code}
           and not exists (
             select 1 from tax_registrations r
              where r.org_id = ${orgId} and r.jurisdiction_id = j.id and r.return_form_code = ${pack.code})
        returning id`)) as unknown as { rows: { id: string }[] };
      if (res.rows[0]) registrationsCreated++;
    }
  });

  return { packs: codes, jurisdictionsCreated, taxCodesCreated, taxGroupsCreated, registrationsCreated };
}
