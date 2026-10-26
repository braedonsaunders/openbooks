import { BenefitsError } from "./errors.ts";
import type { TransactionRecipientSource } from "./transaction-policy.ts";

type RecordedRole = Exclude<TransactionRecipientSource, "assignment">;
export type TransactionRoleEvidence = {
  ticket_reference: string | null;
  ticket_id: string | null;
  project_reference: string | null;
  project_id: string | null;
  ticket_foreman: string | null;
  ticket_superintendent: string | null;
  project_foreman: string | null;
  project_manager: string | null;
};
const columns = {
  field_ticket_foreman: "ticket_foreman",
  field_ticket_superintendent: "ticket_superintendent",
  project_foreman: "project_foreman",
  project_manager: "project_manager",
} as const;
/** Context absence is distinct from an empty role on an extant source. */
export function transactionRoleRecipient(
  source: RecordedRole,
  fallback: RecordedRole | null,
  onlyWhenAbsent: boolean | undefined,
  evidence: TransactionRoleEvidence | undefined,
): string | null {
  if (!onlyWhenAbsent)
    return (
      evidence?.[columns[source]] ?? (fallback ? (evidence?.[columns[fallback]] ?? null) : null)
    );
  if (!evidence)
    throw new BenefitsError(
      "REFUSED",
      "A selected transaction has no retained recipient-source context — reconcile its native source before settlement.",
    );
  const context = (role: RecordedRole) => {
    const ticket = role.startsWith("field_ticket_");
    const reference = ticket ? evidence.ticket_reference : evidence.project_reference;
    const identity = ticket ? evidence.ticket_id : evidence.project_id;
    const holder = evidence[columns[role]];
    if (holder !== null && typeof holder !== "string")
      throw new BenefitsError(
        "REFUSED",
        "A recipient source has unknown recorded role evidence — reconcile it before settlement.",
      );
    if (
      (reference !== null && typeof reference !== "string") ||
      (identity !== null && typeof identity !== "string")
    )
      throw new BenefitsError(
        "REFUSED",
        "A recipient source has unknown native context — reconcile it before settlement.",
      );
    if (reference !== null && identity !== reference)
      throw new BenefitsError(
        "REFUSED",
        "A recipient source references an unavailable ticket or project — restore its native identity before settlement.",
      );
    if (reference === null && (identity !== null || holder !== null))
      throw new BenefitsError(
        "REFUSED",
        "A recipient source context has conflicting native identity — reconcile it before settlement.",
      );
    return reference !== null;
  };
  if (context(source)) return evidence[columns[source]];
  if (!fallback || !context(fallback)) return null;
  return evidence[columns[fallback]];
}
