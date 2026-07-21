import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Importable government return definitions. A pack supplies the official box
 * structure and filing channel; tenant tax codes remain tenant data and are
 * mapped at import time. Packs deliberately do not contain credentials or file
 * tax returns. Re-importing a pack resets that form's boxes to library defaults.
 */

export type TaxBoxBasis = "tax_collected" | "tax_paid" | "taxable_base";
export type TaxBoxMap = "sales" | "purchases";

export interface TaxReturnPackBox {
  lineCode: string;
  label: string;
  sign: number;
  sequence: number;
  basis?: TaxBoxBasis;
  formula?: string;
  /** Without a GL map or formula, the box is intentionally filer-entered. */
  glMap?: TaxBoxMap;
}

export interface TaxReturnPack {
  code: string;
  name: string;
  country: string;
  submissionChannel: "print_pdf" | "file_upload" | "efile_api" | "portal_manual";
  governmentFormat: "portal_entry" | "certified_file" | "api" | "paper";
  submissionUrl: string;
  watermark: string;
  boxes: readonly TaxReturnPackBox[];
}

export const TAX_RETURN_PACKS: readonly TaxReturnPack[] = [
  {
    code: "CA_GST34",
    name: "GST/HST Return (GST34)",
    country: "CA",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/file-gst-hst-return/how-file.html",
    watermark: "Working copy — submit electronically through the government filing service",
    boxes: [
      { lineCode: "101", label: "Sales and other revenue", sign: 1, sequence: 10, basis: "taxable_base", glMap: "sales" },
      { lineCode: "103", label: "GST/HST collected or collectible", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
      { lineCode: "104", label: "Adjustments to be added to net tax", sign: 1, sequence: 30 },
      { lineCode: "105", label: "Total GST/HST and adjustments", sign: 1, sequence: 40, formula: "103 + 104" },
      { lineCode: "106", label: "Input tax credits (ITCs)", sign: 1, sequence: 50, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "107", label: "Adjustments to be deducted from net tax", sign: 1, sequence: 60 },
      { lineCode: "108", label: "Total ITCs and adjustments", sign: 1, sequence: 70, formula: "106 + 107" },
      { lineCode: "109", label: "Net tax", sign: 1, sequence: 80, formula: "105 - 108" },
      { lineCode: "113", label: "Balance (net tax owing / refund)", sign: 1, sequence: 90, formula: "109" },
    ],
  },
  {
    code: "GB_VAT100",
    name: "VAT Return (VAT100)",
    country: "GB",
    submissionChannel: "efile_api",
    governmentFormat: "api",
    submissionUrl: "https://www.gov.uk/submit-vat-return",
    watermark: "Working copy — submit with compatible digital VAT filing software",
    boxes: [
      { lineCode: "1", label: "VAT due on sales and other outputs", sign: -1, sequence: 10, basis: "tax_collected", glMap: "sales" },
      { lineCode: "2", label: "VAT due on acquisitions from other EC Member States", sign: 1, sequence: 20 },
      { lineCode: "3", label: "Total VAT due", sign: 1, sequence: 30, formula: "1 + 2" },
      { lineCode: "4", label: "VAT reclaimed on purchases and other inputs", sign: 1, sequence: 40, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "5", label: "Net VAT to pay or reclaim", sign: 1, sequence: 50, formula: "abs(3 - 4)" },
      { lineCode: "6", label: "Total value of sales and other outputs excluding VAT", sign: 1, sequence: 60, basis: "taxable_base", glMap: "sales" },
      { lineCode: "7", label: "Total value of purchases and other inputs excluding VAT", sign: 1, sequence: 70, basis: "taxable_base", glMap: "purchases" },
      { lineCode: "8", label: "Goods supplied to EC Member States", sign: 1, sequence: 80 },
      { lineCode: "9", label: "Goods acquired from EC Member States", sign: 1, sequence: 90 },
    ],
  },
  {
    code: "AU_BAS_GST",
    name: "Business Activity Statement — GST",
    country: "AU",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/how-to-lodge-your-bas",
    watermark: "Working copy — lodge through the government business portal or enabled software",
    boxes: [
      { lineCode: "G1", label: "Total sales", sign: 1, sequence: 10 },
      { lineCode: "G2", label: "Export sales", sign: 1, sequence: 20 },
      { lineCode: "G3", label: "Other GST-free sales", sign: 1, sequence: 30 },
      { lineCode: "G10", label: "Capital purchases", sign: 1, sequence: 40 },
      { lineCode: "G11", label: "Non-capital purchases", sign: 1, sequence: 50 },
      { lineCode: "1A", label: "GST on sales", sign: -1, sequence: 60, basis: "tax_collected", glMap: "sales" },
      { lineCode: "1B", label: "GST on purchases", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
    ],
  },
  {
    code: "NZ_GST101A",
    name: "Goods and Services Tax Return (GST101A)",
    country: "NZ",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.ird.govt.nz/gst/filing-and-paying-gst-and-refunds/filing-gst/file-your-gst-return",
    watermark: "Working copy — file through the government online account",
    boxes: [
      { lineCode: "5", label: "Total sales and income including GST", sign: 1, sequence: 10 },
      { lineCode: "6", label: "Zero-rated supplies included in box 5", sign: 1, sequence: 20 },
      { lineCode: "8", label: "GST on sales and income", sign: -1, sequence: 30, basis: "tax_collected", glMap: "sales" },
      { lineCode: "9", label: "Adjustments from calculation sheet", sign: 1, sequence: 40 },
      { lineCode: "10", label: "Total GST collected", sign: 1, sequence: 50, formula: "8 + 9" },
      { lineCode: "11", label: "Total purchases and expenses including GST", sign: 1, sequence: 60 },
      { lineCode: "12", label: "GST on purchases and expenses", sign: 1, sequence: 70, basis: "tax_paid", glMap: "purchases" },
      { lineCode: "13", label: "Credit adjustments from calculation sheet", sign: 1, sequence: 80 },
      { lineCode: "14", label: "Total GST credit", sign: 1, sequence: 90, formula: "12 + 13" },
      { lineCode: "15", label: "GST refund or GST to pay", sign: 1, sequence: 100, formula: "abs(10 - 14)" },
    ],
  },
  {
    code: "US_SALES_TAX_WORKPAPER",
    name: "United States Sales Tax Workpaper",
    country: "US",
    submissionChannel: "portal_manual",
    governmentFormat: "portal_entry",
    submissionUrl: "https://www.usa.gov/state-taxes",
    watermark: "Not a government return — customize for each state and local jurisdiction before filing",
    boxes: [
      { lineCode: "GROSS_SALES", label: "Gross sales", sign: 1, sequence: 10 },
      { lineCode: "EXEMPT_SALES", label: "Exempt and non-taxable sales", sign: 1, sequence: 20 },
      { lineCode: "TAXABLE_SALES", label: "Taxable sales", sign: 1, sequence: 30, basis: "taxable_base", glMap: "sales" },
      { lineCode: "TAX_COLLECTED", label: "Sales and use tax collected", sign: -1, sequence: 40, basis: "tax_collected", glMap: "sales" },
      { lineCode: "ADJUSTMENTS", label: "Jurisdiction adjustments", sign: 1, sequence: 50 },
      { lineCode: "TAX_DUE", label: "Tax due before jurisdiction-specific credits and fees", sign: 1, sequence: 60, formula: "TAX_COLLECTED + ADJUSTMENTS" },
    ],
  },
] as const;

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

/** Idempotently install or reset one library pack for a tenant. */
export async function installTaxReturnPack(
  orgId: string,
  packCode: string,
  actorId: string | null = null,
): Promise<SeedTaxFormsResult> {
  const pack = taxReturnPack(packCode);
  if (!pack) throw new Error(`unknown tax return pack "${packCode}"`);

  return db.transaction((tx) => installTaxReturnPackWith(tx, orgId, pack, actorId));
}

/** Install several packs atomically so a failed pack never leaves a partial library import. */
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

  return db.transaction(async (tx) => {
    const results: InstalledTaxReturnPack[] = [];
    for (const pack of packs) {
      results.push({ code: pack.code, ...(await installTaxReturnPackWith(tx, orgId, pack, actorId)) });
    }
    return results;
  });
}

async function installTaxReturnPackWith(
  tx: TaxPackExecutor,
  orgId: string,
  pack: TaxReturnPack,
  actorId: string | null,
): Promise<SeedTaxFormsResult> {
  const formRes = (await tx.execute(sql`
    insert into tax_return_forms
      (org_id, code, name, country, submission_channel, government_format,
       submission_url, watermark, is_active, created_by, updated_by)
    values (${orgId}, ${pack.code}, ${pack.name}, ${pack.country},
            ${pack.submissionChannel}, ${pack.governmentFormat}, ${pack.submissionUrl},
            ${pack.watermark}, true, ${actorId}, ${actorId})
    on conflict (org_id, code) do update
      set name = excluded.name, country = excluded.country,
          submission_channel = excluded.submission_channel,
          government_format = excluded.government_format,
          submission_url = excluded.submission_url,
          watermark = excluded.watermark, is_active = true,
          updated_at = now(), updated_by = ${actorId}
    returning id, (xmax = 0) as inserted`)) as unknown as { rows: { id: string; inserted: boolean }[] };

  await tx.execute(sql`delete from tax_report_lines where org_id = ${orgId} and report_code = ${pack.code}`);

  const candidates = (await tx.execute(sql`
    select id, country, applies_to from tax_codes
     where org_id = ${orgId} and is_active
       and applies_to in ('sales', 'purchases', 'both')`)) as unknown as {
    rows: { id: string; country: string | null; applies_to: "sales" | "purchases" | "both" }[];
  };
  const hasCountryCodes = candidates.rows.some((row) => row.country === pack.country);
  const eligible = candidates.rows.filter((row) =>
    hasCountryCodes ? row.country === pack.country : row.country === null,
  );
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

/** Backwards-compatible engine entry point used by existing seed scripts. */
export function seedCanadaGst34(orgId: string, actorId: string | null = null): Promise<SeedTaxFormsResult> {
  return installTaxReturnPack(orgId, "CA_GST34", actorId);
}
