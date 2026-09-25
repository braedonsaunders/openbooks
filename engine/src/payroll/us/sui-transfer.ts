import { add, cmp } from "../../money/money.ts";

/**
 * State SUI transfer/credit rules (SUI-TRANSFER-CREDIT-IMPL).
 *
 * When an employee works in more than one state for the SAME employer in a
 * year, the gaining state decides how much of the wages already reported to
 * another state count toward its own taxable wage base. The majority rule —
 * the default below — credits same-employer out-of-state wages toward the
 * new state's base, so a mid-year mover's base is not restarted at zero:
 * Oregon states it outright (an employer "may use the aggregate of all
 * taxable wages paid" from before the move to determine what is still
 * reportable as taxable in Oregon — UI PUB 217). Verified deviations
 * override the default per gaining state; states with no entry use it.
 *
 * Each entry is source-cited reference data. A state whose rule genuinely
 * needs an input the system does not hold refuses by name in
 * `resolveUsSuiYtd` (compute-statutory.ts) with the input and the remedy —
 * never a silent exclusion, never a permanent refusal.
 */

export type SuiTransferRuleKind = "aggregate" | "same_year";

export interface SuiTransferRule {
  kind: SuiTransferRuleKind;
  /** Primary source for this state's rule. */
  citation: string;
}

const SUI_TRANSFER_DEFAULT: SuiTransferRule = {
  kind: "aggregate",
  // Oregon's publication states the majority shape explicitly, and no
  // verified deviation is on file for the remaining states: same-employer
  // wages reported to another state count toward the gaining state's base.
  citation: "OR UI PUB 217 (aggregate of all taxable wages paid before the move)",
};

/** Gaining states whose transfer rule is verified to differ from the default. */
const SUI_TRANSFER_OVERRIDES: Record<string, SuiTransferRule> = {
  // CUIC 930.1: wages reported to another state count toward the UI taxable
  // wage limit only in the SAME calendar year, and only when the individual
  // is subsequently transferred to California. Never toward SDI.
  CA: {
    kind: "same_year",
    citation: "CA EDD Employer's Guide (DE 44), Wages in Another State — CUIC 930.1",
  },
  OR: {
    kind: "aggregate",
    citation: "OR UI PUB 217 (aggregate of all taxable wages paid before the move)",
  },
};

export function suiTransferRuleFor(state: string): SuiTransferRule {
  return SUI_TRANSFER_OVERRIDES[state] ?? SUI_TRANSFER_DEFAULT;
}

export interface SuiPriorStateWages {
  state: string;
  /** Exact-money year-to-date paid in that state (stubs plus entered carry-in). */
  wages: string;
  /** Tax year those wages were paid in. */
  year: number;
}

/**
 * Apply the gaining state's transfer rule to prior-state wages, all exact
 * money (never Number). Returns the credited total plus the states whose
 * wages the rule does NOT credit, so the caller can refuse by name with
 * the remedy instead of silently dropping them.
 */
export function applySuiTransferCredits(
  gainingState: string,
  taxYear: number,
  priorWages: readonly SuiPriorStateWages[],
): { credited: string; uncreditedStates: string[] } {
  const rule = suiTransferRuleFor(gainingState);
  let credited = "0";
  const uncreditedStates: string[] = [];
  for (const prior of priorWages) {
    if (cmp(prior.wages, "0") <= 0) continue;
    if (rule.kind === "same_year" && prior.year !== taxYear) {
      uncreditedStates.push(prior.state);
      continue;
    }
    credited = add(credited, prior.wages);
  }
  return { credited, uncreditedStates };
}
