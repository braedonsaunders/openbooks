"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@openbooks/ui";

/**
 * Shared pay-run status language: the document's posted and approval state
 * trump the run lifecycle (draft → calculated → committed), so one badge tells
 * the whole story everywhere (dashboard cards, wizard header, runs list). An
 * approved run whose inputs moved since approval reads as needing
 * recalculation; `stale` is known only to the run page, so list views omit it.
 */

export function runDisplayStatus(
  run: { document_status: string; run_status: string },
  stale = false,
): string {
  if (run.document_status === "posted") return "posted";
  if (run.document_status === "void" || run.document_status === "voided") return "void";
  if (run.document_status === "approved") return stale ? "approvedStale" : "approved";
  if (run.document_status === "pending_approval") return "pendingApproval";
  return run.run_status;
}

export function RunStatusBadge({ status }: { status: string }) {
  const t = useTranslations("payroll");
  const variant =
    status === "posted"
      ? "success"
      : status === "committed" || status === "approved"
        ? "default"
        : status === "calculated" || status === "approvedStale" || status === "pendingApproval"
          ? "warning"
          : status === "void" || status === "rejected"
            ? "destructive"
            : "secondary";
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}
