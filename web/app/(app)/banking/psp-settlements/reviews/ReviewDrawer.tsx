"use client";

import { useRouter } from "next/navigation";
import { Button } from "@openbooks/ui";
import { ApprovalActions } from "@/components/approval-actions";

export interface ReviewHistoryEntry {
  status: string;
  statusLabel: string;
  at: string;
  reason: string | null;
}

export interface ReviewDrawerData {
  id: string;
  providerLabel: string;
  kindLabel: string;
  statusLabel: string;
  isPending: boolean;
  amount: string;
  providerEventId: string;
  providerRef: string | null;
  reason: string | null;
  receiptNumber: string | null;
  invoiceNumber: string | null;
  history: ReviewHistoryEntry[];
  canDecide: boolean;
  closeHref: string;
  strings: {
    kindRow: string;
    statusRow: string;
    amountRow: string;
    eventRow: string;
    providerRefRow: string;
    reasonGivenRow: string;
    receiptRow: string;
    invoiceRow: string;
    historyTitle: string;
    approveLabel: string;
    rejectLabel: string;
    reasonLabel: string;
    reasonPlaceholder: string;
    decidedNote: string;
    approvedMessage: string;
    rejectedMessage: string;
    closeLabel: string;
  };
}

/**
 * One parked refund or dispute with its consequence and its decision. The
 * drawer shows what approving will post (the amount, the linked receipt or
 * invoice it reopens) before the operator commits — accounting detail on
 * demand, never required to proceed — and rejecting moves nothing without a
 * named reason the audit keeps.
 */
export function PspDisputeReviewDrawer({ review }: { review: ReviewDrawerData }) {
  const router = useRouter();
  const { strings } = review;
  const rows: [string, string | null][] = [
    [strings.kindRow, review.kindLabel],
    [strings.statusRow, review.statusLabel],
    [strings.amountRow, review.amount],
    [strings.eventRow, review.providerEventId],
    [strings.providerRefRow, review.providerRef],
    [strings.reasonGivenRow, review.reason],
    [strings.receiptRow, review.receiptNumber],
    [strings.invoiceRow, review.invoiceNumber],
  ];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-semibold text-slate-900 dark:text-white">{review.providerLabel}</h3>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) =>
          value ? (
            <div key={label} className="contents">
              <dt className="text-slate-500 dark:text-slate-400">{label}</dt>
              <dd className="tabular-nums">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {review.history.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
            {strings.historyTitle}
          </h4>
          <ul className="space-y-1 text-sm">
            {review.history.map((entry, index) => (
              <li key={`${entry.at}-${index}`} className="tabular-nums">
                {entry.statusLabel} · {entry.at}
                {entry.reason ? (
                  <span className="text-slate-500 dark:text-slate-400"> — {entry.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {review.isPending ? (
        <ApprovalActions
          subjectKind="payment_dispute_review"
          subjectId={review.id}
          {...(review.canDecide
            ? {
                submitApprovalHref: "/api/psp/disputes",
                submitApprovalBody: { action: "submit", disputeId: review.id },
              }
            : {})}
          submissionStatuses={["pending_review"]}
        />
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">{strings.decidedNote}</p>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={() => router.push(review.closeHref)}>
          {strings.closeLabel}
        </Button>
      </div>
    </div>
  );
}
