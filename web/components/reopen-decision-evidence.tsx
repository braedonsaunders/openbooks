"use client";

import { useTranslations } from "next-intl";

/** Stored decision/end evidence behind a reopen request row. Every field
 * is read from the request row or its audit trail — the component never
 * reconstructs who decided what: absent evidence renders nothing. */
export interface ReopenDecisionEvidenceSource {
  status: unknown;
  requestedById?: unknown;
  approvedById?: unknown;
  approvedByName?: unknown;
  decisionAction?: unknown;
  attestation?: unknown;
  endActorName?: unknown;
  endReason?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Approver identity on every decided request, the quoted sole-approver
 * attestation on a self-approval, and the reject/end actor with the end
 * reason where the audit trail holds them. Requested windows render
 * nothing: there is no decision to evidence yet.
 */
export function ReopenDecisionEvidence({ source }: { source: ReopenDecisionEvidenceSource }) {
  const t = useTranslations("close.setup");
  const status = text(source.status);
  if (
    status !== "approved" &&
    status !== "rejected" &&
    status !== "reclosed" &&
    status !== "expired"
  )
    return null;
  const approverName = text(source.approvedByName);
  const selfApproved =
    source.decisionAction === "self_approve" ||
    (source.requestedById != null &&
      source.approvedById != null &&
      source.requestedById === source.approvedById);
  const attestation = text(source.attestation);
  const endActorName = text(source.endActorName);
  const endReason = text(source.endReason);
  return (
    <div className="space-y-1">
      {status === "rejected" ? (
        approverName ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("periods.rejectedBy", { name: approverName })}
          </p>
        ) : null
      ) : selfApproved ? (
        <>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("periods.selfApprovedNote")}
          </p>
          {attestation ? (
            <p className="text-sm text-slate-700 dark:text-slate-200">“{attestation}”</p>
          ) : null}
        </>
      ) : approverName ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t("periods.approvedBy", { name: approverName })}
        </p>
      ) : null}
      {status === "reclosed" && (endActorName || endReason) ? (
        <>
          {endActorName ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("periods.endedBy", { name: endActorName })}
            </p>
          ) : null}
          {endReason ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("periods.reopenEndReason", { reason: endReason })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
