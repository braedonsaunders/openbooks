"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@openbooks/ui";
import type { MatchReason } from "@openbooks/engine/banking/match-scoring";

type Translate = ReturnType<typeof useTranslations>;

/** One reason as operator copy, from its code and parameters; amounts render through `amount` when given. */
export function matchReasonLabel(
  t: Translate,
  reason: MatchReason,
  amount: (value: string) => string = (value) => value,
): string {
  switch (reason.code) {
    case "exact_amount":
      return t("exactAmount");
    case "date_lag":
      if (reason.days === 0) return t("sameDay");
      return reason.days > 0
        ? t("bankPostedLater", { count: reason.days })
        : t("bankPostedEarlier", { count: -reason.days });
    case "shared_reference":
      return t("sharedReference", { reference: reason.reference });
    case "shared_counterparty":
      return t("sharedCounterparty", { words: reason.tokens.join(", ") });
    case "prior_party":
      return t("priorParty");
    case "exact_open_balance":
      return t("exactOpenBalance");
    case "combined_open_balance":
      return t("combinedOpenBalance", { count: reason.count });
    case "partial_open_balance":
      return t("partialOpenBalance", { remaining: amount(reason.remaining) });
    case "on_account_remainder":
      return t("onAccountRemainder", { remainder: amount(reason.remainder) });
    case "due_date":
      if (reason.days === 0) return t("paidOnDueDate");
      return reason.days > 0
        ? t("paidAfterDueDate", { count: reason.days })
        : t("paidBeforeDueDate", { count: -reason.days });
    case "history_payee":
      return t("historyPayee", { words: reason.tokens.join(", "), date: reason.matchedOn });
  }
}

/** The reasons behind a match or proposal, as compact badges with the full list as a tooltip. */
export function MatchReasonBadges({
  reasons,
  className,
  formatAmount,
}: {
  reasons: readonly MatchReason[];
  className?: string;
  formatAmount?: (value: string) => string;
}) {
  const t = useTranslations("banking.match.reasons");
  if (reasons.length === 0) return null;
  const labels = reasons.map((reason) => matchReasonLabel(t, reason, formatAmount));
  return (
    <ul
      className={className ?? "flex flex-wrap gap-1"}
      aria-label={t("listLabel")}
      title={labels.join(" · ")}
    >
      {labels.map((label, index) => (
        <li key={`${reasons[index]!.code}-${index}`}>
          <Badge variant="secondary" className="font-normal">
            {label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
