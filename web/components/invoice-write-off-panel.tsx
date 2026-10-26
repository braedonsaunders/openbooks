"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { Button, Input } from "@openbooks/ui";
import { useMoney } from "./money-provider";
import { useBusinessToday } from "./business-date-provider";
import { useAppAction } from "../lib/use-app-action";
import { decimalCmp } from "../lib/statement-format";
import { moneyFieldError } from "./money-input";
import type { InvoiceWriteOffDrawer } from "../lib/invoice-write-off-drawer";
import { DateField } from "./date-field";

/**
 * Write off the open balance of a posted customer invoice. The engine posts a
 * credit memo that debits the write-off account and settles the invoice with
 * it; this panel only collects the amount, date and reason and submits them.
 * The server re-checks the balance, the account configuration and the periods,
 * so this form never decides what may post.
 */
export function InvoiceWriteOffPanel({ documentId, currency, openBalance }: InvoiceWriteOffDrawer) {
  const t = useTranslations("payments.invoiceWriteOff");
  const tCommon = useTranslations("common");
  const { money } = useMoney();
  // The default date is the organization's business day, never the browser's.
  const today = useBusinessToday();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState(openBalance);
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Shared action path: refusals toast through the hook and render inline, and
  // busy always releases, so a dead network can never wedge the submit.
  const { busy, execute } = useAppAction();
  // One key per logical write-off: minted on first submit and reused across
  // retries until the outcome is visible, so a network retry replays the
  // write-off it already recorded instead of posting a second one.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // Nothing owed means nothing to write off.
  if (decimalCmp(openBalance, "0") <= 0) return null;

  async function submit() {
    setError(null);
    const amountError = moneyFieldError(t("amount"), t("amountExpected"), amount);
    if (amountError) {
      setError(amountError);
      return;
    }
    if (decimalCmp(amount, openBalance) > 0) {
      setError(t("aboveOpen", { amount: money(openBalance, { currency }) }));
      return;
    }
    if (reason.trim() === "") {
      setError(t("reasonRequired"));
      return;
    }
    const key = pendingKey ?? crypto.randomUUID();
    setPendingKey(key);
    await execute(
      () =>
        fetchAction("/api/payments/invoice-write-offs", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": key },
          body: JSON.stringify({
            invoiceId: documentId,
            amount: amount.trim(),
            date,
            reason: reason.trim(),
          }),
        }),
      {
        fallbackMessage: t("failed"),
        onOk: () => {
          setPendingKey(null);
          setExpanded(false);
          setReason("");
          router.refresh();
        },
        onRefused: (actionError) => {
          setError(actionError.displayMessage(t("failed")));
          // A named refusal means this key cannot serve a retry, so the next
          // attempt starts a fresh request. A network failure keeps the key, so
          // the retry replays rather than writing off again.
          if (actionError.kind !== "transport") setPendingKey(null);
        },
      },
    );
  }

  return (
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("title")}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
            {t("open", { amount: money(openBalance, { currency }) })}
          </span>
          {!expanded ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setExpanded(true)}>
              {t("start")}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {expanded ? (
        <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("hint")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              {t("amount")}
              <Input
                type="number"
                step="0.01"
                min="0"
                className="h-8 text-right"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
              {t("date")}
              <DateField className="h-8" value={date} onChange={(value) => setDate(value)} />
            </label>
          </div>
          <label className="block space-y-1 text-xs font-medium text-slate-600 dark:text-slate-300">
            {t("reason")}
            <Input
              className="h-8"
              maxLength={500}
              placeholder={t("reasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setExpanded(false);
                setError(null);
              }}
            >
              {tCommon("actions.cancel")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void submit()}>
              {t("submit")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
