import { createHash } from "node:crypto";
import {
  type PayRunCalculationSourceSnapshot,
  canonicalJson,
} from "./run-calculation-source-shape.ts";

export function payRunCalculationSourceChanges(
  stored: PayRunCalculationSourceSnapshot,
  current: PayRunCalculationSourceSnapshot,
): {
  time: boolean;
  timeTypes: boolean;
  wages: boolean;
  items: boolean;
  components: boolean;
  compensationPackages: boolean;
  holidayObligations: boolean;
  roster: boolean;
  openingBalances: boolean;
  incomeTaxOverrides: boolean;
  bankCashInputs: boolean;
  declaredVacationAccruals: boolean;
  employerLevyAdjustments: boolean;
} {
  return {
    openingBalances:
      canonicalJson(stored.openingEmployerAuthorities) !==
        canonicalJson(current.openingEmployerAuthorities) ||
      canonicalJson(stored.openingLevySourceAuthorities) !==
        canonicalJson(current.openingLevySourceAuthorities) ||
      canonicalJson(stored.openingBalanceSources) !== canonicalJson(current.openingBalanceSources),
    incomeTaxOverrides:
      canonicalJson(stored.incomeTaxOverrides) !== canonicalJson(current.incomeTaxOverrides),
    bankCashInputs: canonicalJson(stored.bankCashInputs) !== canonicalJson(current.bankCashInputs),
    employerLevyAdjustments:
      canonicalJson(stored.employerLevyAdjustments) !==
      canonicalJson(current.employerLevyAdjustments),
    declaredVacationAccruals:
      canonicalJson(stored.declaredVacationAccruals) !==
      canonicalJson(current.declaredVacationAccruals),
    time:
      canonicalJson(stored.timeEntries) !== canonicalJson(current.timeEntries) ||
      canonicalJson(stored.claimEntryIds) !== canonicalJson(current.claimEntryIds),
    timeTypes: canonicalJson(stored.timeTypes) !== canonicalJson(current.timeTypes),
    wages:
      canonicalJson(stored.payRates) !== canonicalJson(current.payRates) ||
      canonicalJson(stored.bonusIncomeReferences) !== canonicalJson(current.bonusIncomeReferences),
    compensationPackages:
      canonicalJson(stored.compensationPackages) !== canonicalJson(current.compensationPackages),
    components:
      canonicalJson(stored.assignmentRunPolicies) !==
        canonicalJson(current.assignmentRunPolicies) ||
      canonicalJson(stored.payComponentStatutoryTreatments) !==
        canonicalJson(current.payComponentStatutoryTreatments) ||
      canonicalJson(stored.entitlementSettlementPlans) !==
        canonicalJson(current.entitlementSettlementPlans),
    holidayObligations:
      canonicalJson(stored.holidayFacts) !== canonicalJson(current.holidayFacts) ||
      canonicalJson(stored.holidayObligations) !== canonicalJson(current.holidayObligations) ||
      canonicalJson(stored.holidayEmployments) !== canonicalJson(current.holidayEmployments),
    roster:
      canonicalJson(stored.holidayFacts) !== canonicalJson(current.holidayFacts) ||
      canonicalJson(stored.holidayEmployments) !== canonicalJson(current.holidayEmployments) ||
      canonicalJson(stored.usFilingAccountLineages) !==
        canonicalJson(current.usFilingAccountLineages) ||
      canonicalJson(stored.employerAssignments) !== canonicalJson(current.employerAssignments) ||
      canonicalJson(stored.historicalEmploymentRoster) !==
        canonicalJson(current.historicalEmploymentRoster),
    items: canonicalJson(stored.itemAccounts) !== canonicalJson(current.itemAccounts),
  };
}

/**
 * One employee's refused or warned calculation outcome.
 *
 * This is the persisted refusal record (migration 0182): calculate writes the
 * whole array wholesale on every pass, commit gates on the `refusal` entries,
 * and the run page renders them back. `employee` is the display name at
 * calculate time — narrative, not identity; the gate and the acknowledgement
 * bind to `employeePartyId`. `message` is the pack's (or engine's) own
 * refusal/warning text, carried verbatim, never rewritten.
 *
 * `kind` is what keeps the gate honest: only an in-scope employee with no
 * stub (`refusal`) can block a commit. A `warning` rides a stub that exists
 * (an entitlement bank over its limit — correct output the operator decides
 * on), and `out-of-scope` is the run's own scope rule refusing someone it was
 * never meant to pay (a final-pay stranger); neither blocks.
 *
 * The index signature is deliberate room, not looseness: the holiday
 * attestation work extends these entries additively (holiday keys, needed
 * facts) without reshaping what commit already binds to.
 */
export interface PayRunCalculationError {
  employeePartyId: string;
  employee: string;
  message: string;
  kind: "refusal" | "warning" | "out-of-scope";
  [key: string]: unknown;
}

/**
 * A recorded decision to commit a run that leaves in-scope employees unpaid.
 *
 * `errorsDigest` binds the acknowledgement to the EXACT in-scope refusal set
 * it names (see `payRunRefusalDigest`): acknowledging one refusal set and
 * then recalculating into another leaves a stale acknowledgement the commit
 * gate refuses, so an operator can never wave through a situation they did
 * not see. `refusals` is the human-readable half — who was left out and why,
 * retrievable long after posting.
 */
export interface PayRunRefusalAcknowledgement {
  version: 1;
  acknowledgedBy: string;
  acknowledgedAt: string;
  errorsDigest: string;
  refusals: PayRunCalculationError[];
}

/** The in-scope refusals inside a stored error set — what the gate binds to. */
export function payRunCalculationRefusals(
  errors: PayRunCalculationError[],
): PayRunCalculationError[] {
  return errors.filter((entry) => entry.kind === "refusal");
}

/**
 * Digest of an in-scope refusal set, sorted by party so entry order can never
 * distinguish two identical sets. The acknowledgement records this digest and
 * commit recomputes it; any recalculation that changes who is refused (or
 * why, the messages are digested too) invalidates the old acknowledgement.
 */
export function payRunRefusalDigest(refusals: PayRunCalculationError[]): string {
  const ordered = [...refusals].sort((a, b) =>
    a.employeePartyId < b.employeePartyId ? -1 : a.employeePartyId > b.employeePartyId ? 1 : 0,
  );
  return createHash("sha256").update(canonicalJson(ordered)).digest("hex");
}

/**
 * Parse the persisted calculation errors. Null (legacy runs calculated before
 * refusal tracking, or never calculated) is NOT the same as empty: callers
 * must send the run through a recalculation rather than assume nobody was
 * refused. Corrupt entries fail the same closed way.
 */
export function parsePayRunCalculationErrors(value: unknown): PayRunCalculationError[] | null {
  if (value == null) return null;
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return null;
  const parsed: PayRunCalculationError[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.employeePartyId !== "string" ||
      typeof record.employee !== "string" ||
      typeof record.message !== "string" ||
      (record.kind !== "refusal" && record.kind !== "warning" && record.kind !== "out-of-scope")
    ) {
      return null;
    }
    parsed.push({ ...record } as PayRunCalculationError);
  }
  return parsed;
}

/** Parse a stored refusal acknowledgement; corrupt or absent reads as none. */
export function parsePayRunRefusalAcknowledgement(
  value: unknown,
): PayRunRefusalAcknowledgement | null {
  if (value == null) return null;
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.acknowledgedBy !== "string" ||
    typeof record.acknowledgedAt !== "string" ||
    typeof record.errorsDigest !== "string" ||
    parsePayRunCalculationErrors(record.refusals) == null
  ) {
    return null;
  }
  return {
    version: 1,
    acknowledgedBy: String(record.acknowledgedBy),
    acknowledgedAt: String(record.acknowledgedAt),
    errorsDigest: String(record.errorsDigest),
    refusals: parsePayRunCalculationErrors(record.refusals) ?? [],
  };
}
