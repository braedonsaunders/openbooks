import { canonicalDecimal } from "../money/exact-decimal.ts";
import { cmp } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";
import { CA_ISSUED_EMPLOYER_LEVY_PROGRAMS } from "./canada/levy-programs.ts";

/**
 * Employer-only statutory levy programmes an operator may record an issued
 * amount against on a pay run. The keys are the statutory-rate programme
 * identities; each maps to the employer-contribution pay component the
 * Canadian pack assesses.
 */
export const EMPLOYER_LEVY_PROGRAMS = CA_ISSUED_EMPLOYER_LEVY_PROGRAMS;

export type EmployerLevyProgramKey = keyof typeof EMPLOYER_LEVY_PROGRAMS;

export function isEmployerLevyProgramKey(value: unknown): value is EmployerLevyProgramKey {
  return value === "ca_eht" || value === "ca_wcb";
}

/**
 * An issued employer levy amount recorded as issued: the operator states the
 * premium an external source issued, and calculation books exactly that
 * amount. It is not a statutory assessment — no assessable earnings are
 * recorded and no native levy is re-priced — so dated assessability policy,
 * annual maxima and exemptions are untouched.
 */
export type EmployerLevyAdjustmentEvidence = {
  kind: "employer_levy_adjustment";
  programKey: EmployerLevyProgramKey;
  /** The worker-compensation group the issued premium belongs to; ca_wcb only. */
  workerCompGroupId: string | null;
  /**
   * Stable identity of the issued source record (for example the source
   * system's card or document id, qualified by its category where one
   * record carries several). The same source record can be recorded once,
   * whatever request key a retry arrives under.
   */
  sourceKey: string;
  reason: string;
  sourceReference: string;
  requestId: string;
};

export function canonicalLevySourceKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (key.length === 0 || key.length > 200 || /\s/.test(key)) return null;
  return key;
}

export function parseEmployerLevyAdjustmentEvidence(
  value: string | null,
): EmployerLevyAdjustmentEvidence | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<EmployerLevyAdjustmentEvidence>;
    if (
      parsed.kind !== "employer_levy_adjustment" ||
      !isEmployerLevyProgramKey(parsed.programKey) ||
      canonicalLevySourceKey(parsed.sourceKey) !== parsed.sourceKey ||
      typeof parsed.reason !== "string" ||
      !parsed.reason.trim() ||
      parsed.reason.length > 500 ||
      typeof parsed.sourceReference !== "string" ||
      !parsed.sourceReference.trim() ||
      parsed.sourceReference.length > 300 ||
      typeof parsed.requestId !== "string" ||
      !isUuid(parsed.requestId)
    )
      return null;
    if (parsed.programKey === "ca_wcb") {
      if (typeof parsed.workerCompGroupId !== "string" || !isUuid(parsed.workerCompGroupId))
        return null;
    } else if (parsed.workerCompGroupId !== null) return null;
    return parsed as EmployerLevyAdjustmentEvidence;
  } catch {
    return null;
  }
}

export function employerLevyAdjustmentEvidence(input: {
  programKey: EmployerLevyProgramKey;
  workerCompGroupId: string | null;
  sourceKey: string;
  reason: string;
  sourceReference: string;
  requestId: string;
}): string {
  return JSON.stringify({
    kind: "employer_levy_adjustment",
    ...input,
  } satisfies EmployerLevyAdjustmentEvidence);
}

export function isEmployerLevyAdjustmentEvidenceCandidate(value: string | null): boolean {
  if (value == null) return false;
  if (/"kind"\s*:\s*"employer_levy_adjustment"/.test(value)) return true;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown };
    return (
      parsed !== null && typeof parsed === "object" && parsed.kind === "employer_levy_adjustment"
    );
  } catch {
    return false;
  }
}

/**
 * The issued premium is a cents-exact, positive operator-entered amount.
 * Negative corrections are outside this command's scope: reversing an
 * issued entry or correcting assessed history uses the governed reversal
 * and void paths, never a negative issued entry.
 */
export function canonicalEmployerLevyAdjustmentAmount(amount: string): string {
  const exact = canonicalDecimal(amount, 2);
  if (exact === null) {
    throw new PayrollError(
      "employer levy adjustment amount must be an exact currency amount of at most 2 decimal places",
    );
  }
  if (cmp(exact, "0") <= 0) {
    throw new PayrollError(
      "employer levy adjustment amount must be the exact positive issued premium — corrections to issued entries use the governed reversal path, not a negative entry",
    );
  }
  return exact;
}
