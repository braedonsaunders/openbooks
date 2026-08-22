import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "./db.ts";
import { COUNTRY_TAX_PACKS, countryTaxPackForReturn } from "./country-tax-packs/index.ts";
import type { TaxBoxBasis, TaxBoxMap, TaxReturnPack, TaxReturnPackBox, TaxReturnPackJurisdiction } from "./country-tax-packs/types.ts";

export type { TaxBoxBasis, TaxBoxMap, TaxReturnPack, TaxReturnPackBox, TaxReturnPackJurisdiction } from "./country-tax-packs/types.ts";

/**
 * Importable government return definitions. A pack supplies the official box
 * structure and filing channel; tenant tax codes remain tenant data and are
 * mapped at import time. Packs deliberately do not contain credentials or file
 * tax returns. Re-importing a pack resets that form's boxes to library defaults.
 */

export const TAX_RETURN_PACKS: readonly TaxReturnPack[] = COUNTRY_TAX_PACKS.flatMap(
  (pack) => pack.returnPacks,
);
export interface SeedTaxFormsResult {
  formCreated: boolean;
  boxRows: number;
  mappedSalesCodes: number;
  mappedPurchaseCodes: number;
}

export interface InstalledTaxReturnPack extends SeedTaxFormsResult {
  code: string;
}

type TaxPackExecutor = Pick<typeof db, "execute">;

export function taxReturnPack(code: string): TaxReturnPack | undefined {
  return TAX_RETURN_PACKS.find((pack) => pack.code === code);
}

/** Idempotently install or reset one versioned country-pack return for a tenant. */
export async function installTaxReturnPack(
  orgId: string,
  packCode: string,
  actorId: string | null = null,
): Promise<SeedTaxFormsResult> {
  const pack = taxReturnPack(packCode);
  if (!pack) throw new Error(`unknown tax return pack "${packCode}"`);

  return withOrgTransaction(orgId, () =>
    db.transaction((tx) => installTaxReturnPackWith(tx, orgId, pack, actorId))
  );
}

/** Install several country-pack returns atomically so a failure never leaves a partial installation. */
export async function installTaxReturnPacks(
  orgId: string,
  packCodes: readonly string[],
  actorId: string | null = null,
): Promise<InstalledTaxReturnPack[]> {
  const uniqueCodes = [...new Set(packCodes)];
  const packs = uniqueCodes.map((code) => {
    const pack = taxReturnPack(code);
    if (!pack) throw new Error(`unknown tax return pack "${code}"`);
    return pack;
  });

  return withOrgTransaction(orgId, () => db.transaction(async (tx) => {
    const results: InstalledTaxReturnPack[] = [];
    for (const pack of packs) {
      results.push({ code: pack.code, ...(await installTaxReturnPackWith(tx, orgId, pack, actorId)) });
    }
    return results;
  }));
}

async function installTaxReturnPackWith(
  tx: TaxPackExecutor,
  orgId: string,
  pack: TaxReturnPack,
  actorId: string | null,
): Promise<SeedTaxFormsResult> {
  // Reference-data jurisdiction the return files into. Idempotent by (org, code)
  // so re-importing a pack keeps the same jurisdiction row and its registrations.
  const j = pack.jurisdiction;
  const jurRes = (await tx.execute<{ id: string }>(sql`
    insert into tax_jurisdictions
      (org_id, code, name, country, region, level, tax_type, is_active, created_by, updated_by)
    values (${orgId}, ${j.code}, ${j.name}, ${j.country}, ${j.region ?? null},
            ${j.level}, ${j.taxType}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country, region = excluded.region,
          level = excluded.level, tax_type = excluded.tax_type, is_active = true,
          updated_at = now(), updated_by = ${actorId}
    where tax_jurisdictions.org_id = ${orgId}
    returning id`));
  const jurisdictionId = jurRes.rows[0]?.id ?? null;

  const formRes = (await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into tax_return_forms
      (org_id, code, name, country, jurisdiction_id, submission_channel, government_format,
       submission_url, watermark, is_active, created_by, updated_by)
    values (${orgId}, ${pack.code}, ${pack.name}, ${pack.country}, ${jurisdictionId},
            ${pack.submissionChannel}, ${pack.governmentFormat}, ${pack.submissionUrl},
            ${pack.watermark}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country,
          jurisdiction_id = excluded.jurisdiction_id,
          submission_channel = excluded.submission_channel,
          government_format = excluded.government_format,
          submission_url = excluded.submission_url,
          watermark = excluded.watermark, is_active = true,
          updated_at = now(), updated_by = ${actorId}
    where tax_return_forms.org_id = ${orgId}
    returning id, (xmax = 0) as inserted`));

  await tx.execute(sql`delete from tax_report_lines where org_id = ${orgId} and report_code = ${pack.code}`);

  const candidates = (await tx.execute<{ id: string; country: string | null; jurisdiction_id: string | null; jurisdiction_tax_type: TaxReturnPackJurisdiction["taxType"] | null; applies_to: "sales" | "purchases" | "both" }>(sql`
    select c.id, c.country, c.jurisdiction_id, c.applies_to,
           j.tax_type as jurisdiction_tax_type
      from tax_codes c
      left join tax_jurisdictions j on j.id = c.jurisdiction_id and j.org_id = c.org_id
     where c.org_id = ${orgId} and c.is_active
       and c.applies_to in ('sales', 'purchases', 'both')`));
  // Prefer tax codes scoped to THIS jurisdiction (so a state return sums only its
  // own state's codes, not every US code); fall back to country, then to codes
  // with no country at all.
  const jurisdictionCodes = jurisdictionId
    ? candidates.rows.filter((row) => row.jurisdiction_id === jurisdictionId)
    : [];
  const countryCodes = candidates.rows.filter((row) => row.country === pack.country);
  const includedTaxTypes = countryTaxPackForReturn(pack.code)?.parentReturnIncludedTaxTypes;
  const eligible = j.level === "state" || j.level === "county" || j.level === "city"
    ? jurisdictionCodes
    : includedTaxTypes?.length
      ? countryCodes.filter((row) => row.jurisdiction_tax_type === null || includedTaxTypes.includes(row.jurisdiction_tax_type))
      : countryCodes.length > 0
        ? countryCodes
        : candidates.rows.filter((row) => row.country === null);
  const sales = eligible.filter((row) => row.applies_to === "sales" || row.applies_to === "both");
  const purchases = eligible.filter((row) => row.applies_to === "purchases" || row.applies_to === "both");

  let boxRows = 0;
  const insertRow = async (box: TaxReturnPackBox, taxCodeId: string | null) => {
    await tx.execute(sql`
      insert into tax_report_lines
        (org_id, report_code, line_code, label, tax_code_id, basis, sign,
         sequence, formula, created_by, updated_by)
      values (${orgId}, ${pack.code}, ${box.lineCode}, ${box.label}, ${taxCodeId},
              ${box.basis ?? null}, ${box.sign}, ${box.sequence}, ${box.formula ?? null},
              ${actorId}, ${actorId})`);
    boxRows++;
  };

  for (const box of pack.boxes) {
    const codes = box.glMap === "sales" ? sales : box.glMap === "purchases" ? purchases : [];
    if (box.glMap && codes.length > 0) {
      for (const code of codes) await insertRow(box, code.id);
    } else {
      await insertRow(box, null);
    }
  }

  const result = {
    formCreated: formRes.rows[0]?.inserted ?? false,
    boxRows,
    mappedSalesCodes: sales.length,
    mappedPurchaseCodes: purchases.length,
  };
  if (actorId && formRes.rows[0]) {
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_return_forms', ${formRes.rows[0].id},
              ${result.formCreated ? "insert" : "update"},
              ${JSON.stringify({ pack: pack.code, resetToLibraryDefaults: !result.formCreated, boxRows, mappedSalesCodes: sales.length, mappedPurchaseCodes: purchases.length })}::jsonb,
              ${actorId})`);
  }
  return result;
}
