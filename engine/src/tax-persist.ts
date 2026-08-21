import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";
import {
  computeLineTaxes,
  TaxCalculationError,
  type ComputedTaxComponent,
  type TaxComponentConfig,
} from "./tax.ts";
import { cmp } from "./money.ts";

/**
 * Engine-side tax helpers so background generators (subscription billing, etc.)
 * can compute AND persist tax the same way the interactive document path does.
 * The kernel rejects a taxed line with no document_line_tax_components
 * ("calculation evidence"), so any generated invoice that carries tax must write
 * these rows — this module is the shared way to do it without importing web/lib.
 */

type Runner = SqlExecutor;

/**
 * Fail closed when a tax code has NO rate row effective on the document date.
 * A matched row carrying rate_percent=0 stays legal (statutory zero rates
 * exist); the silent coalesce-to-zero this replaces posted lapsed or misdated
 * schedules as genuine 0% tax with full calculation evidence. Shared by the
 * engine and web lateral joins so both refuse identically.
 */
export function requireEffectiveRateRow(
  code: string,
  dateIso: string,
  effectiveRatePercent: string | null | undefined,
): string {
  if (effectiveRatePercent == null || effectiveRatePercent === "") {
    throw new TaxCalculationError(
      `tax code ${code} has no rate effective on ${dateIso}; refusing to compute tax at 0%`,
    );
  }
  return String(effectiveRatePercent);
}

/** Effective tax-code config (single code) for a date — mirrors web taxProfileMap. */
export async function loadTaxComponentConfig(
  orgId: string,
  taxCodeId: string,
  dateIso: string,
  runner: Runner = db,
): Promise<TaxComponentConfig[]> {
  const r = (await runner.execute<Record<string, any>>(sql`
    select tc.id, tc.code, tr.rate_percent::text as effective_rate,
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
  `));
  const row = r.rows[0];
  if (!row) return [];
  return [
    {
      taxCodeId: String(row.id),
      code: String(row.code),
      sequence: 1,
      // A NULL join result is "no rate row matched the document date", which is
      // distinct from a matched statutory zero rate; refuse the former loudly.
      ratePercent: requireEffectiveRateRow(String(row.code), dateIso, row.effective_rate),
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

/**
 * Reconstruct immutable tax evidence for an imported source line. Source
 * adapters already provide the exact line tax total. We first perform the
 * statutory calculation; when the source total uses a different allocation or
 * rounding convention, the normal aggregate-override path records that fact on
 * the final component instead of inventing a silent difference.
 */
export function computeImportedLineTaxEvidence(
  amount: string,
  sourceTaxAmount: string,
  configs: TaxComponentConfig[],
): ComputedTaxComponent[] {
  const calculated = computeLineTaxes(amount, configs);
  if (cmp(calculated.taxTotal, sourceTaxAmount) === 0)
    return calculated.components;
  return computeLineTaxes(amount, configs, {
    overridden: true,
    taxAmount: sourceTaxAmount,
  }).components;
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
