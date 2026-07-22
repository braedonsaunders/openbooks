import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import type { ComputedTaxComponent, TaxComponentConfig } from "./tax.ts";

/**
 * Engine-side tax helpers so background generators (subscription billing, etc.)
 * can compute AND persist tax the same way the interactive document path does.
 * The kernel rejects a taxed line with no document_line_tax_components
 * ("calculation evidence"), so any generated invoice that carries tax must write
 * these rows — this module is the shared way to do it without importing web/lib.
 */

type Runner = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

/** Effective tax-code config (single code) for a date — mirrors web taxProfileMap. */
export async function loadTaxComponentConfig(
  orgId: string,
  taxCodeId: string,
  dateIso: string,
): Promise<TaxComponentConfig[]> {
  const r = (await db.execute(sql`
    select tc.id, tc.code, coalesce(tr.rate_percent, 0)::text as rate,
           tc.recoverable_percent::text as recoverable_percent, tc.calculation_type,
           tc.price_includes_tax, tc.compound_on_previous, tc.rounding_scale,
           tc.collected_account_id, tc.paid_account_id, tc.withholding_account_id
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${orgId} and tax_code_id = tc.id and effective_from <= ${dateIso}
           and (effective_to is null or effective_to >= ${dateIso})
         order by effective_from desc limit 1) tr on true
     where tc.id = ${taxCodeId} and tc.org_id = ${orgId} and tc.is_active
  `)) as unknown as { rows: Record<string, any>[] };
  const row = r.rows[0];
  if (!row) return [];
  return [
    {
      taxCodeId: String(row.id),
      code: String(row.code),
      sequence: 1,
      ratePercent: String(row.rate),
      recoverablePercent: String(row.recoverable_percent),
      calculationType: row.calculation_type,
      priceIncludesTax: Boolean(row.price_includes_tax),
      compoundOnPrevious: Boolean(row.compound_on_previous),
      roundingScale: Number(row.rounding_scale),
      collectedAccountId: row.collected_account_id,
      paidAccountId: row.paid_account_id,
      withholdingAccountId: row.withholding_account_id,
    },
  ];
}

/** Write the immutable per-line tax calculation snapshot. */
export async function persistLineTaxComponents(
  orgId: string,
  documentLineId: string,
  components: ComputedTaxComponent[],
  actorId: string | null,
  runner: Runner = db,
): Promise<void> {
  for (const c of components) {
    await runner.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent,
         taxable_amount, tax_amount, recoverable_amount, nonrecoverable_amount,
         calculation_type, price_includes_tax, compound_on_previous, rounding_scale,
         collected_account_id, paid_account_id, withholding_account_id, overridden,
         created_by, updated_by)
      values (${orgId}, ${documentLineId}, ${c.taxCodeId}, ${c.sequence}, ${c.ratePercent},
              ${c.taxableAmount}, ${c.taxAmount}, ${c.recoverableAmount}, ${c.nonrecoverableAmount},
              ${c.calculationType}, ${c.priceIncludesTax}, ${c.compoundOnPrevious}, ${c.roundingScale},
              ${c.collectedAccountId}, ${c.paidAccountId}, ${c.withholdingAccountId}, ${c.overridden},
              ${actorId}, ${actorId})`);
  }
}
