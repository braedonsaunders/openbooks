/**
 * Native tax engine.
 *
 * The engine COMPUTES the expected tax for a line from its tax code's rate.
 * Posting always uses the line's stored `tax_amount`, which may be a manual
 * OVERRIDE (`tax_overridden = true`) — for rounding, partial exemptions, or
 * any "strange situation" the flat rate doesn't capture (and for migrated
 * transactions whose source tax was hand-adjusted). The computed value is kept
 * available so an override is transparent and auditable, and so a parallel run
 * can validate the engine against a source system.
 */

/** Expected tax = round(amount × ratePercent%, 2). `ratePercent` is a percent (13 = 13%). */
export function computeLineTax(amount: string | number, ratePercent: number): string {
  return (Math.round(Number(amount) * ratePercent) / 100).toFixed(2);
}

export interface TaxResolution {
  /** The tax to post (override value when overridden, else the computed value). */
  taxAmount: string;
  /** What the engine would compute from the rate — always populated. */
  computed: string;
  overridden: boolean;
}

/**
 * Resolve a line's effective tax. When `overridden`, honor the supplied
 * `taxAmount`; otherwise compute it from the rate. Also reports the computed
 * value either way so callers can surface a variance.
 */
export function resolveLineTax(
  amount: string | number,
  ratePercent: number,
  opts?: { overridden?: boolean; taxAmount?: string | number | null },
): TaxResolution {
  const computed = computeLineTax(amount, ratePercent);
  if (opts?.overridden && opts.taxAmount != null && opts.taxAmount !== "") {
    return { taxAmount: Number(opts.taxAmount).toFixed(2), computed, overridden: true };
  }
  return { taxAmount: computed, computed, overridden: false };
}

/** True when an override diverges from the computed tax by more than a cent. */
export function taxVaries(res: TaxResolution): boolean {
  return res.overridden && Math.abs(Number(res.taxAmount) - Number(res.computed)) > 0.005;
}
