import { createHash } from "node:crypto";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { type EmployerLevyProgramKey } from "./run-levy-adjustment-evidence.ts";

/**
 * Refusal when a reused adjustment idempotency key cannot replay: the key
 * names another org's row, or the same key arrived with different details.
 * The route maps this to 409 invalid_idempotency_key — fail closed, never
 * the older row as though it matched. The message names the remedy (send a
 * fresh key), and the remedy exists: the wizard mints one key per form
 * session and rotates it after every successful add.
 */
export class PayRunAdjustmentIdempotencyConflict extends Error {
  readonly status = 409 as const;
  readonly code = "idempotency-conflict" as const;
  constructor(reason: "changed-payload" | "foreign-key" | "corrected-request" | "source-recorded") {
    super(
      reason === "source-recorded"
        ? "This issued levy source already has an audited recording. Review that recording and its correction history instead of entering the same source again."
        : reason === "foreign-key"
          ? "This request key is already in use by another organization. Reopen the adjustment form to try again with a fresh request."
          : reason === "corrected-request"
            ? "This audited payroll input request has been corrected or removed. Review the current run input and submit any further correction with a fresh request key."
            : "This adjustment was already saved with different details. Reopen the adjustment form to try again with a fresh request.",
    );
  }
}

/**
 * Deterministic adjustment row id for one member of an idempotent bulk
 * batch: UUIDv5 over (batch key, employee), so a replayed batch addresses
 * the same rows and the engine's per-row claim-or-replay applies unchanged.
 * The namespace is this derivation's own fixed identity, not a claim about
 * any external system.
 */
const BULK_ADJUSTMENT_NAMESPACE = Buffer.from("payroll.bulk.adj.", "utf8");
export function payRunBulkAdjustmentId(batchKey: string, employeePartyId: string): string {
  const hash = createHash("sha1")
    .update(BULK_ADJUSTMENT_NAMESPACE)
    .update(batchKey, "utf8")
    .update(":")
    .update(employeePartyId, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Adjustment money must be an exact 4dp amount the numeric(19,4) column can
 * hold: anything wider died at storage with a driver error.
 */
export function persistAdjustmentMoney(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new PayrollError(
      "adjustment amount must be an exact decimal of at most 4 decimal places",
    );
  }
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new PayrollError(
      "adjustment amount must be an exact decimal of at most 4 decimal places",
    );
  }
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new PayrollError(
      "adjustment amount is out of range — at most 15 whole digits fit the ledger",
    );
  }
  return amount;
}

/**
 * Adjustment hours persist into numeric(12,2): at most 2dp and ten whole
 * digits. Anything past 2dp was silently rounded by the column; anything
 * wider died at storage. Signed bank-deposit candidates are validated against
 * their native plan before a fresh write; ordinary worked hours stay non-negative.
 */
export function persistAdjustmentHours(value: unknown, amount: string): string {
  const exact = canonicalDecimal(value, 2);
  if (exact === null || (exact.startsWith("-") && !amount.startsWith("-"))) {
    throw new PayrollError(
      "adjustment hours must be a non-negative decimal of at most 2 decimal places",
    );
  }
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) {
    throw new PayrollError(
      "adjustment hours are out of range — at most 10 whole digits fit the ledger",
    );
  }
  return exact;
}

/**
 * Canonicalize API-supplied adjustment hours for the numeric(12,2) column:
 * at most 2dp and ten whole digits. Negative hours require a negative amount
 * to become a deposit candidate; the writer must still validate the bank.
 * With no amount supplied, only non-negative hours are accepted. Returns null
 * for absent input (no hours) and for anything unpersistable. HTTP seams must use this — NOT
 * the 4dp money normalizer, which pads every value past the column scale so
 * the engine gate below rejects even whole hours.
 */
export function canonicalAdjustmentHours(
  value: unknown,
  bankDepositAmount?: unknown,
): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 2);
  if (exact === null) return null;
  const amount = canonicalDecimal(bankDepositAmount, 4);
  if (exact.startsWith("-") && (amount === null || !amount.startsWith("-"))) return null;
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) return null;
  return exact;
}

export type PayRunAdjustmentMutation =
  | {
      action: "add";
      employeePartyId: string;
      componentId: string;
      amount: string;
      hours?: string | null;
      /** Inclusive source dates for the earning; absent retains legacy period-wide treatment. */
      earnedFrom?: string | null;
      earnedTo?: string | null;
      replaceComponent?: boolean;
      note?: string | null;
      /**
       * Client-minted idempotency key (UUID). The key BECOMES the adjustment
       * row id — the same contract as document creates — so a replayed
       * request addresses the same row: identical details replay the
       * original result, anything else (or another org's row) is refused.
       * Absent for legacy callers, which keep generated ids.
       */
      idempotencyKey?: string;
    }
  | {
      action: "override_income_tax";
      employeePartyId: string;
      /** Absolute income-tax withholding for this cheque, not a delta. */
      amount: string;
      reason: string;
      sourceReference: string;
      /** Required request key; retries replay only the matching current input. */
      idempotencyKey: string;
    }
  | {
      action: "bank_cash_input";
      employeePartyId: string;
      componentId: string;
      /** Signed hours are positive for a withdrawal and negative for a deposit. */
      hours: string;
      /** Supply an issued cash amount, a keyed hourly rate, or both for a consistency check. */
      amount?: string | null;
      rate?: string | null;
      /** Positive withdrawal cash paid outside the entitlement bank; never inferred. */
      outsideBankAmount?: string | null;
      reason: string;
      sourceReference: string;
      idempotencyKey: string;
    }
  | {
      action: "declared_vacation_accrual";
      employeePartyId: string;
      /** Exact positive vacation liability recorded on this cheque, in currency. */
      amount: string;
      reason: string;
      sourceReference: string;
      idempotencyKey: string;
    }
  | {
      action: "employer_levy_adjustment";
      employeePartyId: string;
      /** Employer-only statutory levy programme being trued up. */
      programKey: EmployerLevyProgramKey;
      /** Required for ca_wcb: the group the issued premium belongs to. */
      workerCompGroupId?: string | null;
      /** Exact positive issued premium amount, recorded as issued. */
      amount: string;
      /** Stable identity of the issued source record; recorded once. */
      sourceKey: string;
      reason: string;
      sourceReference: string;
      idempotencyKey: string;
    }
  | { action: "delete"; adjustmentId: string }
  | { action: "exclude"; employeePartyId: string }
  | { action: "include"; employeePartyId: string };

export type IncomeTaxOverrideEvidence = {
  kind: "income_tax_override";
  reason: string;
  sourceReference: string;
  requestId: string;
};

export function parseIncomeTaxOverrideEvidence(
  value: string | null,
): IncomeTaxOverrideEvidence | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<IncomeTaxOverrideEvidence>;
    if (
      parsed.kind !== "income_tax_override" ||
      typeof parsed.reason !== "string" ||
      typeof parsed.sourceReference !== "string" ||
      typeof parsed.requestId !== "string"
    )
      return null;
    return parsed as IncomeTaxOverrideEvidence;
  } catch {
    return null;
  }
}

export function incomeTaxOverrideEvidence(
  reason: string,
  sourceReference: string,
  requestId: string,
): string {
  return JSON.stringify({
    kind: "income_tax_override",
    reason,
    sourceReference,
    requestId,
  } satisfies IncomeTaxOverrideEvidence);
}
