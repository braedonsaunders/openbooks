/**
 * HRM AI rails (HR-21) errors. Every refusal names the remedy — a computed
 * refusal must reach the caller, and the operator acts on the remedy, so
 * the remedy must exist in the product.
 */
export class AiRailsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AiRailsError";
    this.code = code;
  }
}

/** Capability key is unknown to the code registry. */
export function unknownCapability(key: string): AiRailsError {
  return new AiRailsError(
    "ai_unknown_capability",
    `unknown AI capability "${key}": enable it on Company Settings → Features and review it on /admin/ai before use`,
  );
}

/** Autonomy may only move down from the code maximum, never up. */
export function autonomyRaiseRefused(key: string, max: string): AiRailsError {
  return new AiRailsError(
    "ai_autonomy_raise_refused",
    `AI capability "${key}" cannot be raised above "${max}": autonomy is set in code and the org may only lower it on /admin/ai`,
  );
}

/** The actor may not see this subject's data. */
export function aiSubjectRefused(what: string, remedy: string): AiRailsError {
  return new AiRailsError("ai_subject_refused", `${what}; ${remedy}`);
}

/** A report definition failed validation — refused by name, never repaired. */
export function nlDefinitionRefused(reason: string): AiRailsError {
  return new AiRailsError("ai_nl_definition_refused", `report definition refused: ${reason}`);
}

/** The pay-run commit gate found open blocking flags. */
export function finalizeBlockedRefusal(open: number, periodFrom: string, periodTo: string): AiRailsError {
  return new AiRailsError(
    "ai_finalize_blocked",
    `pay run cannot be finalized — ${open} blocking payroll check(s) are open for ${periodFrom} to ${periodTo}; resolve or acknowledge them on /payroll/anomalies first`,
  );
}
