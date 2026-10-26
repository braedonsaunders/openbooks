"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Button, FieldLabel, Select } from "@openbooks/ui";
import { fetchAppAction } from "../lib/api-error";

interface ReceiptReference {
  id: string;
  documentNumber: string;
  documentDate: string;
  status: string;
}

interface MatchCandidate {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  purchaseOrderLineId: string;
  purchaseOrderLineNumber: number;
  unit: string | null;
  unitPrice: string;
  billableQuantity: string;
  receipts: ReceiptReference[];
}

interface CandidateLine {
  billLineId: string;
  lineNumber: number;
  itemCode: string | null;
  itemName: string;
  quantity: string;
  unit: string | null;
  matched: { purchaseOrderNumber: string; purchaseOrderLineNumber: number } | null;
  candidates: MatchCandidate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asLines(data: unknown): CandidateLine[] {
  if (!isRecord(data) || !Array.isArray(data.lines)) return [];
  const lines: CandidateLine[] = [];
  for (const entry of data.lines) {
    if (!isRecord(entry) || typeof entry.billLineId !== "string") continue;
    const candidates: MatchCandidate[] = [];
    if (Array.isArray(entry.candidates)) {
      for (const raw of entry.candidates) {
        if (!isRecord(raw) || typeof raw.purchaseOrderLineId !== "string") continue;
        candidates.push({
          purchaseOrderId: typeof raw.purchaseOrderId === "string" ? raw.purchaseOrderId : "",
          purchaseOrderNumber:
            typeof raw.purchaseOrderNumber === "string" ? raw.purchaseOrderNumber : "",
          purchaseOrderLineId: raw.purchaseOrderLineId,
          purchaseOrderLineNumber:
            typeof raw.purchaseOrderLineNumber === "number" ? raw.purchaseOrderLineNumber : 0,
          unit: typeof raw.unit === "string" ? raw.unit : null,
          unitPrice: typeof raw.unitPrice === "string" ? raw.unitPrice : "",
          billableQuantity: typeof raw.billableQuantity === "string" ? raw.billableQuantity : "",
          receipts: Array.isArray(raw.receipts)
            ? raw.receipts.filter(isRecord).map((receipt) => ({
                id: typeof receipt.id === "string" ? receipt.id : "",
                documentNumber:
                  typeof receipt.documentNumber === "string" ? receipt.documentNumber : "",
                documentDate: typeof receipt.documentDate === "string" ? receipt.documentDate : "",
                status: typeof receipt.status === "string" ? receipt.status : "",
              }))
            : [],
        });
      }
    }
    const matched = isRecord(entry.matched) ? entry.matched : null;
    lines.push({
      billLineId: entry.billLineId,
      lineNumber: typeof entry.lineNumber === "number" ? entry.lineNumber : 0,
      itemCode: typeof entry.itemCode === "string" ? entry.itemCode : null,
      itemName: typeof entry.itemName === "string" ? entry.itemName : "",
      quantity: typeof entry.quantity === "string" ? entry.quantity : "",
      unit: typeof entry.unit === "string" ? entry.unit : null,
      matched:
        matched &&
        typeof matched.purchaseOrderNumber === "string" &&
        typeof matched.purchaseOrderLineNumber === "number"
          ? {
              purchaseOrderNumber: matched.purchaseOrderNumber,
              purchaseOrderLineNumber: matched.purchaseOrderLineNumber,
            }
          : null,
      candidates,
    });
  }
  return lines;
}

/**
 * Match a hand-coded vendor bill to its purchase order, line by line. The
 * candidate list loads first so the operator confirms the delivery (the
 * goods receipts behind each open order line) before linking anything; a
 * refusal stays open in the dialog with the server's message, never as a
 * toast the operator can mistake for a completed match.
 */
export function BillMatchDialog({
  billId,
  onClose,
  onMatched,
}: {
  billId: string;
  onClose: () => void;
  onMatched: () => void;
}) {
  const t = useTranslations("ap");
  const tCommon = useTranslations("common");
  const [lines, setLines] = React.useState<CandidateLine[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<Record<string, string>>({});
  const [postError, setPostError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback.
      const result = await fetchAppAction(`/api/documents/${billId}/bill-match`, undefined, {
        fallback: t("match.loadFailed"),
      });
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(result.error.displayMessage(t("match.loadFailed")));
        return;
      }
      const next = asLines(result.data);
      setLines(next);
      const preselect: Record<string, string> = {};
      for (const line of next) {
        if (!line.matched && line.candidates.length === 1) {
          preselect[line.billLineId] = line.candidates[0]!.purchaseOrderLineId;
        }
      }
      setSelection(preselect);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [billId, t]);

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

  async function confirmMatch() {
    const matches = Object.entries(selection)
      .filter(([, purchaseOrderLineId]) => purchaseOrderLineId !== "")
      .map(([billLineId, purchaseOrderLineId]) => ({ billLineId, purchaseOrderLineId }));
    if (matches.length === 0 || busy) return;
    setBusy(true);
    setPostError(null);
    try {
      const result = await fetchAppAction(
        `/api/documents/${billId}/bill-match`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matches }),
        },
        { fallback: t("match.matchFailed") },
      );
      if (result.ok) {
        onMatched();
        return;
      }
      setPostError(result.error.displayMessage(t("match.matchFailed")));
    } finally {
      setBusy(false);
    }
  }

  const error = postError ?? loadError;
  const matchable = (lines ?? []).filter((line) => !line.matched && line.candidates.length > 0);
  const chosen = matchable.filter((line) => (selection[line.billLineId] ?? "") !== "").length;

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label={t("match.title")}
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
            <h2 className="text-lg font-semibold">{t("match.title")}</h2>
            {lines === null && !loadError ? (
              <p>{tCommon("actions.loading")}</p>
            ) : (
              <>
                {error ? (
                  <p
                    role="alert"
                    className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
                  >
                    {error}
                  </p>
                ) : null}
                {lines !== null && matchable.length === 0 ? (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("match.noCandidates")}
                  </p>
                ) : null}
                {matchable.length > 0 ? (
                  <p className="text-sm text-slate-600 dark:text-slate-300">
                    {t("match.description")}
                  </p>
                ) : null}
                {matchable.map((line) => (
                  <div key={line.billLineId} className="space-y-1">
                    <FieldLabel htmlFor={`match-line-${line.billLineId}`}>
                      {t("match.lineLabel", {
                        lineNumber: line.lineNumber,
                        item: line.itemCode ?? line.itemName,
                        quantity: line.quantity,
                        unit: line.unit ?? "",
                      })}
                    </FieldLabel>
                    <Select
                      id={`match-line-${line.billLineId}`}
                      value={selection[line.billLineId] ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setSelection((prev) => ({ ...prev, [line.billLineId]: e.target.value }))
                      }
                    >
                      <option value="">{t("match.chooseOrder")}</option>
                      {line.candidates.map((candidate) => (
                        <option
                          key={candidate.purchaseOrderLineId}
                          value={candidate.purchaseOrderLineId}
                        >
                          {t("match.candidateLabel", {
                            orderNumber: candidate.purchaseOrderNumber,
                            lineNumber: candidate.purchaseOrderLineNumber,
                            quantity: candidate.billableQuantity,
                            unit: candidate.unit ?? "",
                            unitPrice: candidate.unitPrice,
                          })}
                        </option>
                      ))}
                    </Select>
                    {(() => {
                      const chosenCandidate = line.candidates.find(
                        (candidate) => candidate.purchaseOrderLineId === selection[line.billLineId],
                      );
                      return chosenCandidate && chosenCandidate.receipts.length > 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {t("match.receipts", {
                            list: chosenCandidate.receipts
                              .map(
                                (receipt) => `${receipt.documentNumber} (${receipt.documentDate})`,
                              )
                              .join(", "),
                          })}
                        </p>
                      ) : null;
                    })()}
                  </div>
                ))}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" disabled={busy} onClick={onClose}>
                    {tCommon("actions.cancel")}
                  </Button>
                  {matchable.length > 0 ? (
                    <Button disabled={busy || chosen === 0} onClick={() => void confirmMatch()}>
                      {t("match.confirm")}
                    </Button>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>,
    document.body,
  );
}
