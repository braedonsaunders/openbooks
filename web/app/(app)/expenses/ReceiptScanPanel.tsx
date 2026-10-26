"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileImage, Loader2, ReceiptText, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  cn,
} from "@openbooks/ui";
import { SUPPORTED_CURRENCIES } from "@openbooks/engine/fx/currencies";
import { add, neg } from "@openbooks/engine/money/money";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import type { ReceiptCaptureView } from "@openbooks/engine/payables/receipt-capture-service";
import type { DraftField } from "@openbooks/engine/payables/receipt-capture";
import { useMoney } from "../../../components/money-provider";
import { MoneyInput, moneyFieldError } from "../../../components/money-input";
import { editableMoneyDecimal } from "../../../lib/exact-decimal";
import { readApiErrorMessage } from "../../../lib/api-error";
import { confirmDialog } from "../../../lib/confirm";
import {
  blankForeignLine,
  convertForeignLine,
  ExpenseLineCurrency,
  foreignLineReady,
  type ForeignLineState,
  type ForeignOriginal,
} from "./ExpenseLineCurrency";
import { DateField } from "../../../components/date-field";
import { AttachmentPanel } from "../../../components/attachment-panel";

/** A confirmed receipt reading, as the expense line it becomes. */
export interface ReceiptLineInput {
  accountId: string;
  description: string;
  taxProfileId: string;
  /** Report-currency amounts; converted from the receipt's currency for a foreign receipt. */
  amount: string;
  taxOverridden: boolean;
  taxAmount: string;
  settlementType: string;
  /** A receipt in another currency than the report: how its line converts. */
  foreign: { state: ForeignLineState; original: ForeignOriginal } | null;
}

/** Receipt facts the reviewer confirmed; saved with the line. */
export interface ReceiptLineFacts {
  transactionDate: string;
  merchantName: string;
  merchantPartyId: string | null;
}

type CaptureIssue = ReceiptCaptureView["issues"][number];

interface ReceiptsPayload {
  captures: ReceiptCaptureView[];
  reportCurrency: string;
  canScan: boolean;
  captureOperational: boolean;
  canConfigure: boolean;
  configureHref: string;
}

type Upload = {
  key: string;
  filename: string;
  status: "queued" | "scanning" | "failed";
  error?: string;
};

const ACCEPT = "application/pdf,image/jpeg,image/png,image/tiff";
const PREVIEWABLE_IMAGES = new Set(["image/jpeg", "image/png"]);
/** Readings whose currency must be settled before they can become a line. */
const CURRENCY_BLOCKS = new Set(["currency_conflict", "invalid_currency"]);

function percent(confidence: string | null): string | null {
  if (!confidence) return null;
  const [whole = "0", fraction = ""] = confidence.split(".");
  return String(Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2)));
}

async function fetchReceipts(
  documentId: string,
  fallback: string,
): Promise<{ ok: true; payload: ReceiptsPayload } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/expenses/${documentId}/receipts`);
    if (!res.ok) return { ok: false, message: await readApiErrorMessage(res, fallback) };
    const payload = (await res.json().catch(() => null)) as ReceiptsPayload | null;
    return payload ? { ok: true, payload } : { ok: false, message: fallback };
  } catch {
    return { ok: false, message: fallback };
  }
}

/**
 * Receipt scanning for one draft expense report: upload with per-receipt
 * progress, then one review card per reading with the receipt beside it.
 * A reading becomes a line only when the reviewer adds it and saves the
 * report; the save confirms the receipt in the same transaction.
 */
export function ReceiptScanPanel({
  documentId,
  canAdd,
  accounts,
  taxProfiles,
  pendingCaptureIds,
  refreshKey,
  onAddLine,
}: {
  documentId: string;
  /** The drawer can enter edit mode and take a new line. */
  canAdd: boolean;
  accounts: { value: string; label: string }[];
  taxProfiles: { value: string; label: string }[];
  /** Receipts already added to the editor's lines but not yet saved. */
  pendingCaptureIds: ReadonlySet<string>;
  /** Changes when the report is saved, so confirmed receipts reload. */
  refreshKey: string;
  onAddLine: (captureId: string, line: ReceiptLineInput, facts: ReceiptLineFacts) => void;
}) {
  const t = useTranslations("expenses");
  const [data, setData] = useState<ReceiptsPayload | null>(null);
  // A scanned receipt is presented by its capture card; every other file on
  // the report (imported receipts included) is listed below the cards.
  const captureFileIds = useMemo(
    () =>
      new Set(
        (data?.captures ?? []).flatMap((capture) => (capture.fileId ? [capture.fileId] : [])),
      ),
    [data],
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadFailed = t("receipts.loadFailed");
  const apply = useCallback((result: Awaited<ReturnType<typeof fetchReceipts>>) => {
    if (result.ok) {
      setData(result.payload);
      setLoadError(null);
    } else {
      setLoadError(result.message);
    }
  }, []);
  const load = useCallback(
    async () => apply(await fetchReceipts(documentId, loadFailed)),
    [apply, documentId, loadFailed],
  );

  useEffect(() => {
    let active = true;
    void fetchReceipts(documentId, loadFailed).then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply, documentId, loadFailed, refreshKey]);

  function mergeCaptures(next: ReceiptCaptureView[]) {
    setData((current) => {
      if (!current) return current;
      const byId = new Map(current.captures.map((capture) => [capture.id, capture]));
      for (const capture of next) byId.set(capture.id, capture);
      return {
        ...current,
        captures: [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      };
    });
  }

  function setUpload(key: string, patch: Partial<Upload> | null) {
    setUploads((current) =>
      patch === null
        ? current.filter((upload) => upload.key !== key)
        : current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)),
    );
  }

  async function scan(files: File[]) {
    if (files.length === 0) return;
    const queued = files.map((file) => ({ file, key: crypto.randomUUID() }));
    setUploads((current) => [
      ...current,
      ...queued.map(({ file, key }) => ({ key, filename: file.name, status: "queued" as const })),
    ]);
    // One receipt per request: each card reports its own progress and a
    // refused file never holds back the others.
    for (const { file, key } of queued) {
      setUpload(key, { status: "scanning" });
      const form = new FormData();
      form.append("files", file);
      try {
        const res = await fetch(`/api/expenses/${documentId}/receipts`, {
          method: "POST",
          body: form,
        });
        if (!res.ok) {
          setUpload(key, {
            status: "failed",
            error: await readApiErrorMessage(res, t("receipts.toasts.actionFailed")),
          });
          if (res.status === 409) void load();
          continue;
        }
        const body = (await res.json().catch(() => null)) as {
          captures?: ReceiptCaptureView[];
        } | null;
        mergeCaptures(body?.captures ?? []);
        setUpload(key, null);
      } catch {
        setUpload(key, { status: "failed", error: t("receipts.toasts.actionFailed") });
      }
    }
    if (input.current) input.current.value = "";
  }

  async function act(capture: ReceiptCaptureView, action: "retry" | "discard") {
    if (
      action === "discard" &&
      !(await confirmDialog({
        title: t("receipts.discardTitle"),
        message: t("receipts.discardBody"),
        confirmLabel: t("receipts.discard"),
        tone: "danger",
      }))
    )
      return;
    if (action === "retry")
      mergeCaptures([{ ...capture, status: "extracting", interrupted: false, lastError: null }]);
    try {
      const res = await fetch(`/api/expenses/${documentId}/receipts/${capture.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("receipts.toasts.actionFailed")));
        void load();
        return;
      }
      if (action === "discard") {
        await res.json().catch(() => null);
        setData(
          (current) =>
            current && {
              ...current,
              captures: current.captures.filter((entry) => entry.id !== capture.id),
            },
        );
        toast.success(t("receipts.toasts.discarded"));
      } else {
        const body = (await res.json().catch(() => null)) as {
          capture?: ReceiptCaptureView | null;
        } | null;
        if (body?.capture) mergeCaptures([body.capture]);
        else void load();
      }
    } catch {
      toast.error(t("receipts.toasts.actionFailed"));
      void load();
    }
  }

  if (loadError) {
    return (
      <Alert variant="destructive" className="flex items-center justify-between gap-3">
        <AlertDescription>{loadError}</AlertDescription>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoadError(null);
            void load();
          }}
        >
          {t("receipts.retryLoad")}
        </Button>
      </Alert>
    );
  }
  if (!data) {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-slate-500 dark:text-slate-400">
        <Loader2 size={14} className="animate-spin" /> {t("receipts.loading")}
      </p>
    );
  }

  const scanAvailable = data.canScan && data.captureOperational;
  return (
    <div className="space-y-4">
      {data.canScan && !data.captureOperational ? (
        <Alert variant="warning">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("receipts.notConfigured")} {data.canConfigure ? null : t("receipts.askAdmin")}
            </span>
            {data.canConfigure ? (
              <Button variant="outline" size="sm" asChild>
                <a href={data.configureHref}>{t("receipts.configure")}</a>
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {scanAvailable ? (
        <div
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center text-sm transition-colors",
            dragging
              ? "border-sky-400 bg-sky-50 dark:border-sky-600 dark:bg-sky-950/30"
              : "border-slate-300 dark:border-slate-700",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void scan(Array.from(event.dataTransfer.files));
          }}
        >
          <UploadCloud size={20} className="text-slate-400" aria-hidden="true" />
          <p className="text-slate-700 dark:text-slate-200">{t("receipts.dropHint")}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("receipts.formats")}</p>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => void scan(Array.from(event.target.files ?? []))}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            {t("receipts.chooseFiles")}
          </Button>
        </div>
      ) : null}

      {uploads.length > 0 ? (
        <ul className="space-y-1.5" aria-live="polite">
          {uploads.map((upload) => (
            <li
              key={upload.key}
              className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              {upload.status === "failed" ? (
                <Badge variant="destructive">{t("receipts.progress.failed")}</Badge>
              ) : (
                <Loader2 size={14} className="animate-spin text-slate-400" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">{upload.filename}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {upload.status === "failed"
                  ? upload.error
                  : t(`receipts.progress.${upload.status}`)}
              </span>
              {upload.status === "failed" ? (
                <Button variant="ghost" size="sm" onClick={() => setUpload(upload.key, null)}>
                  {t("receipts.dismiss")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {scanAvailable && data.captures.length === 0 && uploads.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          <ReceiptText size={14} aria-hidden="true" /> {t("receipts.empty")}
        </p>
      ) : null}

      {data.captures.map((capture) => (
        <ReceiptCard
          key={`${capture.id}:${capture.status}:${capture.attempts}`}
          capture={capture}
          documentId={documentId}
          reportCurrency={data.reportCurrency}
          canAdd={canAdd && data.canScan}
          canManage={data.canScan}
          pending={pendingCaptureIds.has(capture.id)}
          accounts={accounts}
          taxProfiles={taxProfiles}
          onAddLine={onAddLine}
          onAction={(action) => void act(capture, action)}
        />
      ))}

      <AttachmentPanel
        targetTable="documents"
        targetId={documentId}
        canEdit={false}
        title={t("receipts.filesTitle")}
        excludeFileIds={captureFileIds}
      />
    </div>
  );
}

function ReceiptCard({
  capture,
  documentId,
  reportCurrency,
  canAdd,
  canManage,
  pending,
  accounts,
  taxProfiles,
  onAddLine,
  onAction,
}: {
  capture: ReceiptCaptureView;
  documentId: string;
  reportCurrency: string;
  canAdd: boolean;
  canManage: boolean;
  pending: boolean;
  accounts: { value: string; label: string }[];
  taxProfiles: { value: string; label: string }[];
  onAddLine: (captureId: string, line: ReceiptLineInput, facts: ReceiptLineFacts) => void;
  onAction: (action: "retry" | "discard") => void;
}) {
  const t = useTranslations("expenses");
  const { money } = useMoney();
  const draft = capture.draft;
  const [date, setDate] = useState(draft?.transactionDate.value ?? "");
  const [merchant, setMerchant] = useState(draft?.merchantName.value ?? "");
  const [vendorId, setVendorId] = useState(draft?.merchantPartyId ?? "");
  const [total, setTotal] = useState(editableMoneyDecimal(draft?.total.value));
  const [tax, setTax] = useState(editableMoneyDecimal(draft?.taxAmount.value));
  const [taxProfileId, setTaxProfileId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [description, setDescription] = useState("");
  const [settlementType, setSettlementType] = useState("out_of_pocket");
  // The currency the receipt was spent in: what it states, else the report's.
  const [currency, setCurrency] = useState(draft?.currency.value ?? reportCurrency);
  // The expense date follows the receipt date until the reviewer sets its own.
  const [foreignState, setForeignState] = useState<ForeignLineState>(() =>
    blankForeignLine(draft?.currency.value ?? reportCurrency, ""),
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((current) => new Set(current).add(key));

  const fieldLabel = (field: string): string => {
    const key = (
      {
        merchantName: "merchant",
        transactionDate: "date",
        total: "total",
        taxTotal: "tax",
        tip: "tip",
        subtotal: "subtotal",
        currency: "currency",
      } as Record<string, string>
    )[field];
    return key ? t(`receipts.fields.${key}`) : field;
  };

  function issueText(issue: CaptureIssue): string {
    const field = issue.field ? fieldLabel(issue.field) : "";
    switch (issue.code) {
      case "required_field":
        return t("receipts.issues.requiredField", { field });
      case "low_confidence":
        return t("receipts.issues.lowConfidence", { field });
      case "invalid_date":
        return t("receipts.issues.invalidDate", { value: issue.actual ?? "" });
      case "future_date":
        return t("receipts.issues.futureDate", { value: issue.actual ?? "" });
      case "total_mismatch":
        return t("receipts.issues.totalMismatch", {
          expected: money(issue.expected ?? "0"),
          actual: money(issue.actual ?? "0"),
        });
      case "tax_detail_mismatch":
        return t("receipts.issues.taxDetailMismatch", {
          expected: money(issue.expected ?? "0"),
          actual: money(issue.actual ?? "0"),
        });
      case "items_mismatch":
        return t("receipts.issues.itemsMismatch", {
          expected: money(issue.expected ?? "0"),
          actual: money(issue.actual ?? "0"),
        });
      case "non_positive_total":
        return t("receipts.issues.nonPositiveTotal", { value: money(issue.actual ?? "0") });
      case "amount_out_of_range":
        return t("receipts.issues.amountOutOfRange", { field });
      case "currency_unread":
        return t("receipts.issues.currencyUnread", { currency: reportCurrency });
      case "foreign_currency":
      case "currency_mismatch":
        return t("receipts.issues.foreignCurrency", {
          actual: issue.actual ?? "",
          currency: reportCurrency,
        });
      case "currency_conflict":
        return t("receipts.issues.currencyConflict", { actual: issue.actual ?? "" });
      case "invalid_currency":
        return t("receipts.issues.invalidCurrency", { actual: issue.actual ?? "" });
      case "possible_duplicate":
        if (!issue.detail) return t("receipts.issues.duplicateElsewhere");
        return issue.cause === "same_file"
          ? t("receipts.issues.duplicateFile", { report: issue.detail ?? "" })
          : t("receipts.issues.duplicateReceipt", { report: issue.detail ?? "" });
      default:
        return issue.message ?? issue.code;
    }
  }

  const reading = (
    field: DraftField | undefined,
    key: string,
    apply: (value: string) => void,
    valid = true,
  ) => {
    if (!field?.needsReview || field.reading === null || touched.has(key)) return null;
    const confidence = percent(field.confidence);
    return (
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <span>
          {confidence
            ? t("receipts.readAsConfidence", { value: field.reading, confidence })
            : t("receipts.readAs", { value: field.reading })}
        </span>
        {valid ? (
          <button
            type="button"
            className="font-medium underline"
            onClick={() => {
              apply(field.reading!);
              touch(key);
            }}
          >
            {t("receipts.useReading")}
          </button>
        ) : null}
      </p>
    );
  };
  const flagged = (field: DraftField | undefined, key: string) =>
    field?.needsReview === true && !touched.has(key)
      ? "ring-2 ring-amber-400 dark:ring-amber-500"
      : undefined;

  const preview =
    capture.fileId && capture.contentType
      ? `/api/file-cabinet/files/${capture.fileId}/download`
      : null;
  const issues = capture.issues;
  const currencyBlocked = issues.some((issue) => CURRENCY_BLOCKS.has(issue.code));
  const totalCanonical = canonicalDecimal(total.trim(), 4);
  const taxCanonical = tax.trim() === "" ? null : canonicalDecimal(tax.trim(), 4);
  const withTax = taxProfileId !== "" && taxCanonical !== null;
  const receiptAmount =
    totalCanonical === null
      ? null
      : withTax
        ? add(totalCanonical, neg(taxCanonical!))
        : add(totalCanonical, "0");
  // A receipt in another currency converts into the report currency; its
  // expense date defaults to the receipt date until the reviewer sets one.
  const foreign = currency !== reportCurrency;
  const foreignLine: ForeignLineState = {
    ...foreignState,
    currency,
    rateDate: foreignState.rateDate || date,
  };
  const original: ForeignOriginal = {
    amount: receiptAmount,
    taxAmount: withTax ? add(taxCanonical!, "0") : null,
  };
  const conversion = foreign ? convertForeignLine(foreignLine, original, reportCurrency) : null;
  const lineAmount = foreign ? (conversion?.amount ?? null) : receiptAmount;
  const lineTax = foreign
    ? (conversion?.taxAmount ?? null)
    : withTax
      ? add(taxCanonical!, "0")
      : null;
  const ready =
    canAdd &&
    !pending &&
    !currencyBlocked &&
    isIsoCalendarDate(date) &&
    merchant.trim() !== "" &&
    totalCanonical !== null &&
    (tax.trim() === "" || taxCanonical !== null) &&
    accountId !== "" &&
    (!foreign || foreignLineReady(foreignLine, original, reportCurrency));
  const suggestion = draft?.suggestedAccount ?? null;
  const suggestionLabel = suggestion
    ? (accounts.find((account) => account.value === suggestion.accountId)?.label ?? null)
    : null;

  function addLine() {
    if (!ready || lineAmount === null) return;
    const merchantName = merchant.trim();
    onAddLine(
      capture.id,
      {
        accountId,
        description: description.trim() || `${merchantName} · ${date}`,
        taxProfileId,
        amount: lineAmount,
        taxOverridden: withTax,
        taxAmount: lineTax ?? "",
        settlementType,
        foreign: foreign ? { state: foreignLine, original } : null,
      },
      { transactionDate: date, merchantName, merchantPartyId: vendorId || null },
    );
  }

  return (
    <section
      className="grid gap-4 rounded-lg border border-slate-200 p-3 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] dark:border-slate-800"
      aria-label={capture.originalFilename}
    >
      <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-slate-50 dark:bg-slate-900">
        {preview && PREVIEWABLE_IMAGES.has(capture.contentType!) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt={t("receipts.previewAlt", { name: capture.originalFilename })}
            className="max-h-96 w-full object-contain"
          />
        ) : preview && capture.contentType === "application/pdf" ? (
          <iframe
            src={`${preview}#view=FitH`}
            title={t("receipts.previewAlt", { name: capture.originalFilename })}
            className="h-96 w-full"
          />
        ) : (
          <div className="flex flex-col items-center gap-2 p-4 text-center text-xs text-slate-500 dark:text-slate-400">
            <FileImage size={20} aria-hidden="true" />
            <span>{t("receipts.noPreview")}</span>
            {preview ? (
              <a className="font-medium underline" href={preview}>
                {t("receipts.openFile")}
              </a>
            ) : null}
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {capture.originalFilename}
          </span>
          <Badge
            variant={
              capture.status === "failed"
                ? "destructive"
                : capture.status === "confirmed"
                  ? "success"
                  : "secondary"
            }
          >
            {t(`receipts.status.${capture.interrupted ? "interrupted" : capture.status}`)}
          </Badge>
          {capture.status === "failed" || capture.interrupted ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!canManage}
              onClick={() => onAction("retry")}
            >
              <RotateCcw size={14} /> {t("receipts.retry")}
            </Button>
          ) : null}
          {capture.status !== "extracting" || capture.interrupted ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!canManage || pending}
              onClick={() => onAction("discard")}
              className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <Trash2 size={14} /> {t("receipts.discard")}
            </Button>
          ) : null}
        </div>

        {capture.status === "extracting" && !capture.interrupted ? (
          <p className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 size={14} className="animate-spin" /> {t("receipts.reading")}
          </p>
        ) : null}
        {capture.status === "failed" ? (
          <p className="text-sm text-red-600 dark:text-red-400">{capture.lastError}</p>
        ) : null}
        {capture.status === "confirmed" && capture.confirmed ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("receipts.confirmedLine", {
              line: capture.confirmed.lineNumber,
              merchant: capture.confirmed.merchantName,
              date: capture.confirmed.transactionDate,
              amount: money(add(capture.confirmed.amount, capture.confirmed.taxAmount ?? "0"), {
                currency: reportCurrency,
              }),
            })}
          </p>
        ) : null}

        {capture.status === "extracted" && draft ? (
          <>
            {issues.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {issues.map((issue, index) => (
                  <li
                    key={`${issue.code}:${issue.field ?? ""}:${index}`}
                    className={
                      issue.severity === "blocking"
                        ? "text-red-700 dark:text-red-300"
                        : "text-amber-700 dark:text-amber-300"
                    }
                  >
                    {issueText(issue)}
                  </li>
                ))}
              </ul>
            ) : null}

            {pending ? (
              <Alert variant="info">
                <AlertDescription>{t("receipts.pending")}</AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-date`}>{t("receipts.fields.date")}</Label>
                  <DateField
                    id={`${capture.id}-date`}
                    value={date}
                    className={flagged(draft.transactionDate, "date")}
                    onChange={(value) => {
                      setDate(value);
                      touch("date");
                    }}
                  />
                  {reading(
                    draft.transactionDate,
                    "date",
                    setDate,
                    isIsoCalendarDate(draft.transactionDate.reading),
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-merchant`}>{t("receipts.fields.merchant")}</Label>
                  <Input
                    id={`${capture.id}-merchant`}
                    value={merchant}
                    maxLength={200}
                    className={flagged(draft.merchantName, "merchant")}
                    onChange={(event) => {
                      setMerchant(event.target.value);
                      touch("merchant");
                    }}
                  />
                  {reading(draft.merchantName, "merchant", setMerchant)}
                  {vendorId && capture.merchantPartyName ? (
                    <p className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                      <span>
                        {t("receipts.matchedVendor", { name: capture.merchantPartyName })}
                      </span>
                      <button type="button" className="underline" onClick={() => setVendorId("")}>
                        {t("receipts.clearVendor")}
                      </button>
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-currency`}>{t("receipts.fields.currency")}</Label>
                  <Select
                    id={`${capture.id}-currency`}
                    value={currency}
                    className={flagged(draft.currency, "currency")}
                    onChange={(event) => {
                      setCurrency(event.target.value);
                      touch("currency");
                    }}
                  >
                    {SUPPORTED_CURRENCIES.map((entry) => (
                      <option key={entry.code} value={entry.code}>
                        {entry.code} · {entry.name}
                      </option>
                    ))}
                  </Select>
                  {reading(
                    draft.currency,
                    "currency",
                    setCurrency,
                    draft.currency.reading !== null &&
                      SUPPORTED_CURRENCIES.some((entry) => entry.code === draft.currency.reading),
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-total`}>
                    {t("receipts.fields.totalIn", { currency })}
                  </Label>
                  <MoneyInput
                    id={`${capture.id}-total`}
                    value={total}
                    required
                    field={t("receipts.fields.total")}
                    className={flagged(draft.total, "total")}
                    onChange={(value) => {
                      setTotal(value);
                      touch("total");
                    }}
                  />
                  {reading(
                    draft.total,
                    "total",
                    (value) => setTotal(editableMoneyDecimal(value)),
                    !currencyBlocked && canonicalDecimal(draft.total.reading, 4) !== null,
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-tax`}>
                    {t("receipts.fields.taxIn", { currency })}
                  </Label>
                  <MoneyInput
                    id={`${capture.id}-tax`}
                    value={tax}
                    field={t("receipts.fields.tax")}
                    className={flagged(draft.taxAmount, "tax")}
                    onChange={(value) => {
                      setTax(value);
                      touch("tax");
                    }}
                  />
                  {reading(
                    draft.taxAmount,
                    "tax",
                    (value) => setTax(editableMoneyDecimal(value)),
                    !currencyBlocked && canonicalDecimal(draft.taxAmount.reading, 4) !== null,
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-tax-code`}>{t("receipts.fields.taxCode")}</Label>
                  <Select
                    id={`${capture.id}-tax-code`}
                    value={taxProfileId}
                    onChange={(event) => setTaxProfileId(event.target.value)}
                  >
                    <option value="">{t("receipts.noTaxCode")}</option>
                    {taxProfiles.map((profile) => (
                      <option key={profile.value} value={profile.value}>
                        {profile.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>{t("receipts.fields.account")}</Label>
                  <SearchSelect
                    options={accounts}
                    value={accountId}
                    onChange={(value) => setAccountId(value ?? "")}
                    placeholder={t("drawer.accountPlaceholder")}
                    ariaLabel={t("receipts.fields.account")}
                  />
                  {suggestion && suggestionLabel && accountId !== suggestion.accountId ? (
                    <p className="flex flex-wrap items-center gap-1.5 text-xs text-sky-700 dark:text-sky-300">
                      <span>
                        {t(`receipts.suggested.${suggestion.source}`, { account: suggestionLabel })}
                      </span>
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => setAccountId(suggestion.accountId)}
                      >
                        {t("receipts.useSuggestion")}
                      </button>
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-settlement`}>{t("drawer.settlement.label")}</Label>
                  <Select
                    id={`${capture.id}-settlement`}
                    value={settlementType}
                    onChange={(event) => setSettlementType(event.target.value)}
                  >
                    <option value="out_of_pocket">{t("drawer.settlement.outOfPocket")}</option>
                    <option value="company_paid">{t("drawer.settlement.companyPaid")}</option>
                    <option value="personal">{t("drawer.settlement.personal")}</option>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${capture.id}-description`}>
                    {t("receipts.fields.description")}
                  </Label>
                  <Input
                    id={`${capture.id}-description`}
                    value={description}
                    placeholder={
                      merchant.trim() && date ? `${merchant.trim()} · ${date}` : undefined
                    }
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
                {foreign ? (
                  <div className="space-y-2 rounded-md border border-slate-200 p-3 sm:col-span-2 dark:border-slate-800">
                    <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                      {t("receipts.foreignTitle", { currency, reportCurrency })}
                    </p>
                    <ExpenseLineCurrency
                      idPrefix={`${capture.id}-fx`}
                      reportCurrency={reportCurrency}
                      reportId={documentId}
                      state={foreignLine}
                      original={original}
                      editable={canAdd && !pending}
                      showCurrency={false}
                      onChange={setForeignState}
                    />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2 sm:col-span-2">
                  <span className="text-xs text-slate-600 tabular-nums dark:text-slate-300">
                    {lineAmount === null ||
                    moneyFieldError("", "", total, 4, { required: true }) !== null
                      ? t("receipts.requiredHint")
                      : lineTax !== null
                        ? t("receipts.lineAmount", {
                            amount: money(lineAmount, { currency: reportCurrency }),
                            tax: money(lineTax, { currency: reportCurrency }),
                          })
                        : t("receipts.lineAmountNoTax", {
                            amount: money(lineAmount, { currency: reportCurrency }),
                          })}
                  </span>
                  <Button size="sm" disabled={!ready} onClick={addLine}>
                    {t("receipts.addToReport")}
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
