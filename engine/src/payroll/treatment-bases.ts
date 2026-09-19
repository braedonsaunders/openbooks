import { add, neg, sum } from "../money.ts";
import type { PayrollDeductionTreatment, PayrollTaxBaseKey } from "./packs.ts";

/**
 * Pack-declared pre-tax treatments, computed generically.
 *
 * A deduction reduces SOME bases and not others, and which ones is
 * jurisdiction law — so each pack declares its treatments with the legs
 * each one reduces (`PayrollDeductionTreatment`), and this module computes
 * the reduced bases from the line set. The pack's engine prices off the
 * reduced legs and leaves the others alone: salary sacrifice moves PAYG
 * but not superannuation guarantee, a 401(k) moves FIT but not FICA, an
 * RPP contribution moves factor F but neither CPP nor EI.
 *
 * A treatment key the pack does not declare is INERT on its runs — the
 * computation below only subtracts lines whose treatment names a declared
 * key, so a foreign factor stamped on a shared component can never leak
 * across packs. `"none"` (after-tax) reduces nothing by construction.
 */

export const TAX_BASE_KEYS: readonly PayrollTaxBaseKey[] = [
  "income",
  "nonPeriodic",
  "pensionable",
  "insurable",
];

/** The stub-line shape this computation reads. Structural, so callers pass lines directly. */
export interface TreatmentLine {
  kind: string;
  amount: string;
  taxTreatment?: string | null;
}

/**
 * Each generic base less every deduction line whose treatment the pack
 * declares as reducing that base. Undeclared keys and `"none"` subtract
 * nothing. Money stays canonical numeric(19,4): `sum` of an empty set is
 * `"0.0000"`, so an empty or unreduced base prices whole.
 */
export function reduceTaxBases(
  lines: readonly TreatmentLine[],
  bases: Record<PayrollTaxBaseKey, string>,
  treatments: readonly PayrollDeductionTreatment[],
): Record<PayrollTaxBaseKey, string> {
  const reducing = (base: PayrollTaxBaseKey): Set<string> =>
    new Set(
      treatments
        .filter((treatment) => treatment.reduces.includes(base))
        .map((treatment) => treatment.key),
    );
  const out = { ...bases };
  for (const base of TAX_BASE_KEYS) {
    const keys = reducing(base);
    if (keys.size === 0) continue;
    const preTax = sum(
      lines
        .filter((line) => line.kind === "deduction" && line.taxTreatment != null && keys.has(line.taxTreatment))
        .map((line) => line.amount),
    );
    out[base] = add(bases[base], neg(preTax));
  }
  return out;
}

/**
 * Whether a protected line with this treatment forces the alternating
 * fixpoint rather than the after-tax fast path. A treatment that reduces a
 * base moves the statutory pass when protection caps it, so the two must
 * iterate to settlement. Unknown non-`"none"` keys fail closed to iteration:
 * a tag the pack does not declare may still move money elsewhere, and the
 * fast path would price it once and never re-derive it.
 */
export function protectionTreatmentIterates(
  treatments: readonly PayrollDeductionTreatment[],
  treatment: string | null | undefined,
): boolean {
  if (treatment == null || treatment === "none") return false;
  const declared = treatments.find((candidate) => candidate.key === treatment);
  if (!declared) return true;
  return declared.reduces.length > 0;
}
