import { canonicalDecimal } from "../money/exact-decimal.ts";
import { cmp, roundMoney } from "../money/money.ts";
import { isUuid } from "../platform/uuid.ts";

export type DeclaredVacationAccrualEvidence = {
  kind: "declared_vacation_accrual";
  reason: string;
  sourceReference: string;
  requestId: string;
};

export type DeclaredVacationAccrualInput = DeclaredVacationAccrualEvidence & {
  adjustmentId: string;
  componentId: string;
  amount: string;
};

export function parseDeclaredVacationAccrualEvidence(
  value: string | null,
): DeclaredVacationAccrualEvidence | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DeclaredVacationAccrualEvidence>;
    if (
      parsed.kind !== "declared_vacation_accrual" ||
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
    return parsed as DeclaredVacationAccrualEvidence;
  } catch {
    return null;
  }
}

export function isDeclaredVacationAccrualCandidate(value: string | null): boolean {
  return value != null && /"kind"\s*:\s*"declared_vacation_accrual"/.test(value);
}

export function declaredVacationAccrualEvidence(
  reason: string,
  sourceReference: string,
  requestId: string,
): string {
  return JSON.stringify({
    kind: "declared_vacation_accrual",
    reason: reason.trim(),
    sourceReference: sourceReference.trim(),
    requestId: requestId.toLowerCase(),
  } satisfies DeclaredVacationAccrualEvidence);
}

export function isDeclaredVacationAccrualInput(
  value: unknown,
): value is DeclaredVacationAccrualInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const amount = typeof row.amount === "string" ? canonicalDecimal(row.amount, 4) : null;
  return (
    row.kind === "declared_vacation_accrual" &&
    typeof row.adjustmentId === "string" &&
    isUuid(row.adjustmentId) &&
    typeof row.componentId === "string" &&
    isUuid(row.componentId) &&
    typeof row.requestId === "string" &&
    isUuid(row.requestId) &&
    typeof row.reason === "string" &&
    row.reason.trim().length > 0 &&
    row.reason.length <= 500 &&
    typeof row.sourceReference === "string" &&
    row.sourceReference.trim().length > 0 &&
    row.sourceReference.length <= 300 &&
    amount !== null &&
    cmp(amount, "0") > 0 &&
    cmp(roundMoney(amount, 2), amount) === 0
  );
}
