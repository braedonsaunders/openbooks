import { add, neg, sum } from "../money.ts";
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./packs.ts";
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

/** One treatment as the refusal names it: `"key" (Label). */
function namedTreatment(treatment: PayrollDeductionTreatment): string {
  return `"${treatment.key}" (${treatment.label})`;
}

/** Every treatment key any pack declares, in registry order. */
function declaredTreatmentKeys(): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const pack of Object.values(PAYROLL_COUNTRY_PACKS)) {
    for (const treatment of pack.deductionTreatments) {
      if (!seen.has(treatment.key)) {
        seen.add(treatment.key);
        keys.push(treatment.key);
      }
    }
  }
  return keys;
}

/**
 * The pack-declaration authority behind `pay_components.tax_treatment`.
 *
 * The storage layer constrains only SHAPE (migration 0187: a non-empty
 * lower-snake identifier), so this — asked at the API boundary for creates
 * and edits alike — is what refuses an unknown treatment, BY NAME, against
 * the pack it was written for. After-tax (`none`) is always legal; a
 * country-scoped component must carry a treatment its pack declares; a
 * shared (country-less) component must carry one some pack declares, since
 * the compute layer keys off the employee's pack and an undeclared key is
 * inert there. The refusal names every treatment the scope declares, so the
 * operator never has to guess the vocabulary.
 */
export function payComponentTreatmentProblem(input: {
  country: string | null | undefined;
  taxTreatment: string | null | undefined;
}): string | null {
  const treatment = input.taxTreatment ?? "none";
  if (treatment === "none") return null;
  const country = input.country ?? "";
  if (country === "") {
    const keys = declaredTreatmentKeys();
    if (keys.includes(treatment)) return null;
    return `tax treatment "${treatment}" is not declared by any payroll pack — `
      + `declared treatments: "none" (After-tax)${keys.length > 0 ? `, ${keys.map((key) => `"${key}"`).join(", ")}` : ""}. `
      + "Scope the component to a country to see that pack's treatments.";
  }
  let pack;
  try {
    pack = payrollPack(country);
  } catch {
    pack = null;
  }
  if (pack === null) {
    return `no payroll pack exists for country "${country || "(unset)"}" — `
      + `components exist for ${Object.keys(PAYROLL_COUNTRY_PACKS).join(", ")}`;
  }
  if (pack.deductionTreatments.some((declared) => declared.key === treatment)) return null;
  const declared = pack.deductionTreatments.map(namedTreatment).join(", ");
  return `tax treatment "${treatment}" is not declared by the ${pack.name} payroll pack — `
    + `it declares "none" (After-tax)${declared !== "" ? `, ${declared}` : ": this pack transcribes no pre-tax treatment"}. `
    + "A treatment the pack does not declare is inert on its runs, so it is refused here rather than stored.";
}
