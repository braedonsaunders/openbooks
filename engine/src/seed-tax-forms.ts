import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Seed the Canada GST/HST return (GST34) as a configurable form + boxes. This is
 * the reference jurisdiction "pack": the government form's structure is universal
 * (line codes, labels, the arithmetic between boxes), while the tax-code mapping
 * is org-specific — so GL-mapped boxes are wired to whichever GST/HST codes the
 * org already has (one box row per code, summed by the return engine), and the
 * whole thing stays editable in Setup → Taxes.
 *
 * CRA files GST34 electronically (NETFILE / My Business Account) using the access
 * code on the mailed personalized form; openbooks produces the computed boxes and
 * a print-ready facsimile working copy — it does not file the PDF (there isn't a
 * fileable one). The form's submission_channel reflects that.
 */

const FORM_CODE = "CA_GST34";

interface Box {
  lineCode: string;
  label: string;
  sign: number;
  sequence: number;
  basis?: "tax_collected" | "tax_paid" | "taxable_base";
  formula?: string;
  /** 'sales' → map to every sales/both tax code; 'purchases' → purchases/both. */
  glMap?: "sales" | "purchases";
}

const GST34_BOXES: Box[] = [
  { lineCode: "101", label: "Sales and other revenue", sign: 1, sequence: 10 },
  { lineCode: "103", label: "GST/HST collected or collectible", sign: -1, sequence: 20, basis: "tax_collected", glMap: "sales" },
  { lineCode: "104", label: "Adjustments to be added to net tax", sign: 1, sequence: 30 },
  { lineCode: "105", label: "Total GST/HST and adjustments", sign: 1, sequence: 40, formula: "103 + 104" },
  { lineCode: "106", label: "Input tax credits (ITCs)", sign: 1, sequence: 50, basis: "tax_paid", glMap: "purchases" },
  { lineCode: "107", label: "Adjustments to be deducted from net tax", sign: 1, sequence: 60 },
  { lineCode: "108", label: "Total ITCs and adjustments", sign: 1, sequence: 70, formula: "106 + 107" },
  { lineCode: "109", label: "Net tax", sign: 1, sequence: 80, formula: "105 - 108" },
  { lineCode: "113", label: "Balance (net tax owing / refund)", sign: 1, sequence: 90, formula: "109" },
];

export interface SeedTaxFormsResult {
  formCreated: boolean;
  boxRows: number;
  mappedSalesCodes: number;
  mappedPurchaseCodes: number;
}

/** Idempotent: upserts the form and fully reseeds its boxes from GST34_BOXES. */
export async function seedCanadaGst34(orgId: string, actorId: string | null = null): Promise<SeedTaxFormsResult> {
  return db.transaction(async (tx) => {
    const formRes = (await tx.execute(sql`
      insert into tax_return_forms
        (org_id, code, name, country, submission_channel, watermark, is_active, created_by, updated_by)
      values (${orgId}, ${FORM_CODE}, 'GST/HST Return (GST34)', 'CA', 'portal_manual',
              'Working copy — file electronically via NETFILE / My Business Account', true, ${actorId}, ${actorId})
      on conflict (org_id, code) do update
        set name = excluded.name, country = excluded.country, updated_at = now(), updated_by = ${actorId}
      returning (xmax = 0) as inserted`)) as unknown as { rows: { inserted: boolean }[] };

    // Reseed boxes from scratch so the pack is the source of truth.
    await tx.execute(sql`delete from tax_report_lines where org_id = ${orgId} and report_code = ${FORM_CODE}`);

    const sales = (await tx.execute(sql`
      select id from tax_codes where org_id = ${orgId} and is_active and applies_to in ('sales', 'both')`)) as unknown as {
      rows: { id: string }[];
    };
    const purchases = (await tx.execute(sql`
      select id from tax_codes where org_id = ${orgId} and is_active and applies_to in ('purchases', 'both')`)) as unknown as {
      rows: { id: string }[];
    };

    let boxRows = 0;
    const insertRow = async (
      lineCode: string, label: string, sign: number, sequence: number,
      basis: string | null, formula: string | null, taxCodeId: string | null,
    ) => {
      await tx.execute(sql`
        insert into tax_report_lines
          (org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence, formula, created_by, updated_by)
        values (${orgId}, ${FORM_CODE}, ${lineCode}, ${label}, ${taxCodeId}, ${basis}, ${sign}, ${sequence}, ${formula}, ${actorId}, ${actorId})`);
      boxRows++;
    };

    for (const box of GST34_BOXES) {
      const codes = box.glMap === "sales" ? sales.rows : box.glMap === "purchases" ? purchases.rows : [];
      if (box.glMap && codes.length > 0) {
        // One row per contributing tax code — the engine sums them into the box.
        for (const c of codes) {
          await insertRow(box.lineCode, box.label, box.sign, box.sequence, box.basis ?? null, null, c.id);
        }
      } else {
        // Computed, manual, or a GL box with no codes yet (map it in Setup).
        await insertRow(box.lineCode, box.label, box.sign, box.sequence, box.basis ?? null, box.formula ?? null, null);
      }
    }

    return {
      formCreated: formRes.rows[0]?.inserted ?? false,
      boxRows,
      mappedSalesCodes: sales.rows.length,
      mappedPurchaseCodes: purchases.rows.length,
    };
  });
}
