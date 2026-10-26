"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Button, FieldLabel, Textarea } from "@openbooks/ui";
import { fetchAppAction, readAppActionResult, readRefusalDetails } from "@/lib/api-error";
import { PermissionHint } from "../../../components/permission-hint";
import {
  formatReversalSummary,
  type VoidReversalSuggestion,
} from "../../../lib/void-reversal-period";
import { DateField } from "@/components/date-field";

type AdjustmentPeriod = { id: string; name: string };

type Suggestion = {
  periods: AdjustmentPeriod[];
  suggestion: VoidReversalSuggestion | null;
  revision: string | null;
};

type DependentDocument = {
  id: string;
  number: string;
  kind: string;
  status: string;
};

type ConsumptionDependent = {
  consumedQuantity: string;
  issueDate: string;
  returnedQuantity: string;
  sourceDocument: DependentDocument | null;
  reversible: boolean;
  reverseAction: string;
};

type ConsumptionBlocker = {
  itemCode: string | null;
  itemName: string;
  dependents: ConsumptionDependent[];
  otherBlocks: string[];
};

type ConsumptionDetails = {
  receiptNumber?: string;
  blockers?: ConsumptionBlocker[];
  allowVoidWithDependents?: boolean;
  remainderQuantity?: string;
};

/** Where a dependent source document opens; kinds without a drawer render as text. */
function dependentHref(kind: string, id: string): string | null {
  if (kind === "customer_invoice") return `/ar/invoices?doc=${id}`;
  if (kind === "vendor_bill") return `/ap/bills?doc=${id}`;
  if (kind === "sales_order") return `/sales-orders?order=${id}`;
  if (kind === "purchase_order") return `/purchase-orders?order=${id}`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Governed void for a posted goods receipt, as one dialog that never closes
 * silently. The reversal suggestion (and its revision token) loads first; a
 * denial there renders in place instead of closing into a toast. The void
 * POST runs from the confirm button: only an ok response closes the dialog,
 * any refusal stays open with the server's message — a permission denial
 * additionally names the grant to ask for, so nobody mistakes a 403 for a
 * completed void.
 */
export function VoidReceiptDialog({
  receiptId,
  onClose,
  onVoided,
  onCorrected,
}: {
  receiptId: string;
  onClose: () => void;
  onVoided: () => void;
  onCorrected?: () => void;
}) {
  const t = useTranslations("purchaseOrders.shared");
  const tCommon = useTranslations("common");
  const [suggestion, setSuggestion] = React.useState<Suggestion | null>(null);
  const [loadError, setLoadError] = React.useState<{ message: string; status?: number } | null>(
    null,
  );
  const [reason, setReason] = React.useState("");
  const [reversalDate, setReversalDate] = React.useState("");
  const [reversalPeriodId, setReversalPeriodId] = React.useState("");
  const [postError, setPostError] = React.useState<{ message: string; status?: number } | null>(
    null,
  );
  const [consumption, setConsumption] = React.useState<ConsumptionDetails | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      const result = await fetchAppAction(`/api/documents/${receiptId}/void`, undefined, {
        fallback: t("voidReceiptFailed"),
      });
      if (cancelled) return;
      if (!result.ok) {
        setLoadError({
          message: result.error.displayMessage(t("voidReceiptFailed")),
          status: result.error.status,
        });
        return;
      }
      const data = isRecord(result.data) ? result.data : null;
      const periods = Array.isArray(data?.adjustmentPeriods)
        ? (data.adjustmentPeriods as Partial<AdjustmentPeriod>[]).filter(
            (period): period is AdjustmentPeriod =>
              !!period && typeof period.id === "string" && typeof period.name === "string",
          )
        : [];
      const raw = data;
      const next: Suggestion =
        raw && typeof raw.originalDate === "string" && typeof raw.suggestedDate === "string"
          ? {
              periods,
              revision:
                typeof raw.revision === "string" && raw.revision.length > 0 ? raw.revision : null,
              suggestion: {
                originalDate: raw.originalDate,
                suggestedDate: raw.suggestedDate,
                fallbackToOpenPeriod: raw.fallbackToOpenPeriod === true,
                originalFiscalYear:
                  typeof raw.originalFiscalYear === "number" ? raw.originalFiscalYear : null,
                originalPeriodName:
                  typeof raw.originalPeriodName === "string" ? raw.originalPeriodName : null,
                suggestedFiscalYear:
                  typeof raw.suggestedFiscalYear === "number" ? raw.suggestedFiscalYear : null,
                suggestedPeriodName:
                  typeof raw.suggestedPeriodName === "string" ? raw.suggestedPeriodName : null,
                suggestedOpen: raw.suggestedOpen === true,
              },
            }
          : { periods, suggestion: null, revision: null };
      setSuggestion(next);
      if (next.suggestion) setReversalDate(next.suggestion.suggestedDate);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [receiptId, t]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [busy, onClose]);

  /** Read the refusal body alongside the action result so the dialog can offer its actions. */
  async function postVoid(body: Record<string, unknown>): Promise<boolean> {
    setPostError(null);
    setConsumption(null);
    try {
      const res = await fetch(`/api/documents/${receiptId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const copy = await res
        .clone()
        .json()
        .catch(() => null);
      const result = await readAppActionResult(res, { fallback: t("voidReceiptFailed") });
      if (result.ok) {
        onVoided();
        return true;
      }
      // The dialog stays open: the receipt is untouched and Void is still
      // offered, so the refusal must read here — never as a toast the
      // operator can mistake for completion.
      setPostError({
        message: result.error.displayMessage(t("voidReceiptFailed")),
        status: result.error.status,
      });
      if (result.error.code === "receipt-stock-consumed") {
        const details = readRefusalDetails(copy);
        if (details) setConsumption(details as ConsumptionDetails);
      }
      return false;
    } catch {
      setPostError({ message: t("voidReceiptFailed") });
      return false;
    }
  }

  async function confirmVoid(withDependents = false) {
    if (!suggestion?.revision || busy) return;
    setBusy(true);
    try {
      await postVoid({
        reason: reason.trim(),
        expectedUpdatedAt: suggestion.revision,
        ...(reversalDate ? { reversalDate } : {}),
        ...(reversalPeriodId ? { reversalPeriodId } : {}),
        ...(withDependents ? { withDependents: true } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  /** Correct a phantom remainder through the native adjustment; the receipt stands, so this closes differently. */
  async function correctRemainder() {
    if (!suggestion?.revision || busy || reason.trim() === "") return;
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${receiptId}/receipt-remainder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
          ...(reversalDate ? { date: reversalDate } : {}),
        }),
      });
      const result = await readAppActionResult(res, { fallback: t("voidReceiptFailed") });
      if (result.ok) {
        (onCorrected ?? onVoided)();
        return;
      }
      setPostError({
        message: result.error.displayMessage(t("voidReceiptFailed")),
        status: result.error.status,
      });
    } catch {
      setPostError({ message: t("voidReceiptFailed") });
    } finally {
      setBusy(false);
    }
  }

  const error = postError ?? loadError;
  const missingGrant =
    error?.status === 403 && /missing permission: (\S+)/.exec(error.message)?.[1];

  const copy = {
    summaryOriginal: tCommon("amendment.voidReversalSummaryOriginal"),
    summaryReversal: tCommon("amendment.voidReversalSummaryReversal"),
    fiscalYear: tCommon("amendment.voidReversalFiscalYear"),
    fallbackNotice: tCommon("amendment.voidReversalFallbackNotice"),
    closedNotice: tCommon("amendment.voidReversalClosedNotice"),
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={tCommon("amendment.voidTitle")}
      >
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
          onClick={() => {
            if (!busy) onClose();
          }}
          aria-hidden="true"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ type: "spring", damping: 26, stiffness: 340, mass: 0.7 }}
          className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-900"
        >
          <div className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{tCommon("amendment.voidTitle")}</h2>
            {suggestion === null && !loadError ? (
              <p>{tCommon("actions.loading")}</p>
            ) : (
              <>
                {error ? (
                  <div className="space-y-2">
                    <p
                      role="alert"
                      className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                    >
                      {error.message}
                    </p>
                    {consumption?.blockers && consumption.blockers.length > 0 ? (
                      <ul className="space-y-1 text-sm text-slate-700 dark:text-slate-200">
                        {consumption.blockers.flatMap((blocker, blockerIndex) => [
                          ...blocker.dependents.map((dependent, dependentIndex) => {
                            const doc = dependent.sourceDocument;
                            const href = doc ? dependentHref(doc.kind, doc.id) : null;
                            const label = doc
                              ? `${doc.number} — ${dependent.consumedQuantity}`
                              : `${dependent.consumedQuantity} — no source document`;
                            return (
                              <li key={`${blockerIndex}-${dependentIndex}`}>
                                {href ? (
                                  <a className="underline" href={href}>
                                    {label}
                                  </a>
                                ) : (
                                  label
                                )}
                              </li>
                            );
                          }),
                          ...blocker.otherBlocks.map((block, blockIndex) => (
                            <li key={`${blockerIndex}-other-${blockIndex}`}>{block}</li>
                          )),
                        ])}
                      </ul>
                    ) : null}
                    {missingGrant ? (
                      <PermissionHint permission={missingGrant} action={tCommon("actions.void")} />
                    ) : null}
                  </div>
                ) : null}
                {loadError || !suggestion?.suggestion ? (
                  <div className="flex justify-end">
                    <Button variant="secondary" onClick={onClose}>
                      {tCommon("actions.close")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {formatReversalSummary(copy, {
                        ...suggestion.suggestion,
                        suggestedDate: reversalDate || suggestion.suggestion.suggestedDate,
                      })}
                    </p>
                    <div>
                      <FieldLabel htmlFor="void-reason">{tCommon("amendment.reason")}</FieldLabel>
                      <Textarea
                        id="void-reason"
                        value={reason}
                        disabled={busy}
                        placeholder={tCommon("amendment.voidPlaceholder")}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor="void-reversal-date">
                        {tCommon("amendment.voidReversalDateLabel")}
                      </FieldLabel>
                      <DateField
                        id="void-reversal-date"
                        value={reversalDate}
                        disabled={busy}
                        onChange={(value) => setReversalDate(value)}
                      />
                    </div>
                    {suggestion.periods.length > 0 ? (
                      <div>
                        <FieldLabel htmlFor="void-reversal-period">
                          {tCommon("amendment.voidReversalPeriodLabel")}
                        </FieldLabel>
                        <select
                          id="void-reversal-period"
                          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                          value={reversalPeriodId}
                          disabled={busy}
                          onChange={(e) => setReversalPeriodId(e.target.value)}
                        >
                          <option value="">{tCommon("amendment.voidReversalPeriodRegular")}</option>
                          {suggestion.periods.map((period) => (
                            <option key={period.id} value={period.id}>
                              {period.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                      <Button variant="secondary" disabled={busy} onClick={onClose}>
                        {tCommon("confirm.cancel")}
                      </Button>
                      {consumption && Number(consumption.remainderQuantity ?? "0") > 0 ? (
                        <Button
                          variant="secondary"
                          disabled={busy || reason.trim() === ""}
                          onClick={() => void correctRemainder()}
                        >
                          {tCommon("amendment.adjustRemainder")}
                        </Button>
                      ) : null}
                      {consumption?.allowVoidWithDependents ? (
                        <Button
                          disabled={busy || reason.trim() === ""}
                          onClick={() => void confirmVoid(true)}
                        >
                          {tCommon("amendment.voidWithDependents")}
                        </Button>
                      ) : null}
                      <Button
                        disabled={busy || reason.trim() === ""}
                        onClick={() => void confirmVoid()}
                      >
                        {tCommon("actions.void")}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
