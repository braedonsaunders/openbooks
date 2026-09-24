import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { COUNTRY_TAX_PACKS, countryTaxPackForReturn } from "../country-tax-packs/index.ts";
import type { TaxReturnPack, TaxReturnPackBox, TaxReturnPackJurisdiction } from "../country-tax-packs/types.ts";

export type { TaxBoxBasis, TaxBoxMap, TaxReturnPack, TaxReturnPackBox, TaxReturnPackJurisdiction } from "../country-tax-packs/types.ts";

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
  /**
   * Every active sales/purchases code the install did NOT map into a box,
   * each with the reason and the remedy. A hand-made code with no
   * jurisdiction used to vanish from a state return silently (counts only);
   * the operator now sees exactly which codes are out and how to bring
   * them in (usually: assign the jurisdiction).
   */
  excludedCodes: ExcludedTaxCode[];
}

/** An active tax code left out of an installed return, with cause and fix. */
export interface ExcludedTaxCode {
  code: string;
  reason: string;
  remedy: string;
}

export interface InstalledTaxReturnPack extends SeedTaxFormsResult {
  code: string;
}

type TaxPackExecutor = Pick<typeof db, "execute">;

export function taxReturnPack(code: string): TaxReturnPack | undefined {
  return TAX_RETURN_PACKS.find((pack) => pack.code === code);
}

/**
 * A registration filing a form that belongs to another jurisdiction. The
 * return-pack catalog owns the form→jurisdiction mapping: a registration
 * pairing (say) a Canadian jurisdiction with US_NY_ST100 saves, and the
 * unpinned resolve then prints the New York return with the Canadian
 * registration number. Unknown (tenant-defined) forms carry no catalog rule
 * and pass — only a catalog-known form in the wrong jurisdiction refuses,
 * naming the registration, both jurisdictions, and the remedy.
 */
export function taxRegistrationFormProblem(args: {
  registrationLabel: string;
  registrationJurisdictionCode: string;
  formCode: string;
}): string | null {
  const pack = taxReturnPack(args.formCode);
  if (!pack) return null;
  if (pack.jurisdiction.code === args.registrationJurisdictionCode) return null;
  return (
    `tax registration "${args.registrationLabel}" is in jurisdiction ` +
    `"${args.registrationJurisdictionCode}" but files form "${args.formCode}", which belongs ` +
    `to jurisdiction "${pack.jurisdiction.code}" (${pack.jurisdiction.name}) — ` +
    `choose a form for "${args.registrationJurisdictionCode}" or move the registration ` +
    `to "${pack.jurisdiction.code}"`
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
       submission_url, watermark, notice_key, is_active, created_by, updated_by)
    values (${orgId}, ${pack.code}, ${pack.name}, ${pack.country}, ${jurisdictionId},
            ${pack.submissionChannel}, ${pack.governmentFormat}, ${pack.submissionUrl},
            ${pack.watermark}, ${pack.noticeKey ?? null}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country,
          jurisdiction_id = excluded.jurisdiction_id,
          submission_channel = excluded.submission_channel,
          government_format = excluded.government_format,
          submission_url = excluded.submission_url,
          watermark = excluded.watermark, notice_key = excluded.notice_key,
          is_active = true,
          updated_at = now(), updated_by = ${actorId}
    where tax_return_forms.org_id = ${orgId}
    returning id, (xmax = 0) as inserted`));

  await tx.execute(sql`delete from tax_report_lines where org_id = ${orgId} and report_code = ${pack.code}`);

  const candidates = (await tx.execute<{ id: string; code: string; country: string | null; jurisdiction_id: string | null; jurisdiction_code: string | null; jurisdiction_tax_type: TaxReturnPackJurisdiction["taxType"] | null; applies_to: "sales" | "purchases" | "both" }>(sql`
    select c.id, c.code, c.country, c.jurisdiction_id, c.applies_to,
           j.code as jurisdiction_code, j.tax_type as jurisdiction_tax_type
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

  // Every candidate left out of the return, named with the reason and the
  // remedy — counts alone let a hand-made code with no jurisdiction vanish
  // from a state return while the filed figures silently understate.
  const subdivisionReturn = j.level === "state" || j.level === "county" || j.level === "city";
  const eligibleIds = new Set(eligible.map((row) => row.id));
  const excludedCodes: ExcludedTaxCode[] = candidates.rows
    .filter((row) => !eligibleIds.has(row.id))
    .map((row) => describeExcludedCode(row, {
      packCountry: pack.country,
      packJurisdiction: j.code,
      subdivisionReturn,
      taxTypeFiltered: Boolean(includedTaxTypes?.length),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

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
    excludedCodes,
  };
  if (actorId && formRes.rows[0]) {
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'tax_return_forms', ${formRes.rows[0].id},
              ${result.formCreated ? "insert" : "update"},
              ${JSON.stringify({ pack: pack.code, resetToLibraryDefaults: !result.formCreated, boxRows, mappedSalesCodes: sales.length, mappedPurchaseCodes: purchases.length, excludedCodes })}::jsonb,
              ${actorId})`);
  }
  return result;
}

interface ExcludedCandidate {
  code: string;
  country: string | null;
  jurisdiction_id: string | null;
  jurisdiction_code: string | null;
  jurisdiction_tax_type: TaxReturnPackJurisdiction["taxType"] | null;
}

/**
 * Why one active code maps into no box of this return, and how to bring it
 * in. A subdivision return only sums its own jurisdiction's codes, so a
 * same-country code with no jurisdiction is the defect's case (assign the
 * jurisdiction); a code scoped elsewhere belongs to that jurisdiction's
 * return. A country return aggregates its country's codes (within the
 * return's tax types when declared); foreign codes belong elsewhere.
 */
function describeExcludedCode(
  row: ExcludedCandidate,
  opts: { packCountry: string; packJurisdiction: string; subdivisionReturn: boolean; taxTypeFiltered: boolean },
): ExcludedTaxCode {
  const { packCountry, packJurisdiction, subdivisionReturn, taxTypeFiltered } = opts;
  if (subdivisionReturn) {
    if (row.jurisdiction_code) {
      return {
        code: row.code,
        reason: `scoped to jurisdiction "${row.jurisdiction_code}"`,
        remedy: `file under that jurisdiction's return — no action for this return`,
      };
    }
    if (row.country === packCountry) {
      return {
        code: row.code,
        reason: `no jurisdiction assigned`,
        remedy: `assign jurisdiction "${packJurisdiction}" to include it in this return`,
      };
    }
    return {
      code: row.code,
      reason: row.country ? `belongs to country "${row.country}" with no jurisdiction` : `no country or jurisdiction assigned`,
      remedy: row.country
        ? `assign its jurisdiction to file under the owning return`
        : `assign country "${packCountry}" and jurisdiction "${packJurisdiction}" to include it in this return`,
    };
  }
  if (row.country !== null && row.country !== packCountry) {
    return {
      code: row.code,
      reason: `belongs to country "${row.country}"`,
      remedy: `file under that country's return — no action for this return`,
    };
  }
  if (taxTypeFiltered && row.jurisdiction_tax_type !== null) {
    return {
      code: row.code,
      reason: `tax type "${row.jurisdiction_tax_type}" is not aggregated by this return`,
      remedy: `map the code to a box manually if it is reportable on this return`,
    };
  }
  return {
    code: row.code,
    reason: `no country assigned`,
    remedy: `assign country "${packCountry}" to include it in this return`,
  };
}
