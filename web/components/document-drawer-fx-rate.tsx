"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Drawer, FieldLabel, Input, Label, Textarea } from "@openbooks/ui";
import type { DocumentDoc } from "./document-drawer-types";

/** The explicit-rate request a draft save carries (see the document edit API). */
export interface ExplicitFxDraft {
  rate: string;
  source: string;
  reason: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
}

/** Kinds that accept an explicit exchange rate. */
export const EXPLICIT_FX_KINDS: ReadonlySet<string> = new Set([
  "customer_invoice",
  "vendor_bill",
  "customer_credit",
  "vendor_credit",
]);

/** Stored evidence as the drawer shows it; anything else reads as none. */
export function storedExplicitFx(value: unknown): ExplicitFxDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const evidence = value as Record<string, unknown>;
  const fields = ["rate", "source", "reason", "fromCurrency", "toCurrency", "rateDate"] as const;
  if (!fields.every((key) => typeof evidence[key] === "string")) return null;
  return Object.fromEntries(
    fields.map((key) => [key, evidence[key]]),
  ) as unknown as ExplicitFxDraft;
}

/**
 * The document's exchange rate into its legal entity's functional currency.
 * A draft invoice or bill can record an explicit rate with its source and
 * reason, or return to the organization's exchange rates; the change rides
 * the next save, which binds it to the currency, entity and posting date
 * shown here. Absent for documents in their entity's functional currency.
 */
export function DocumentFxRateField({
  kind,
  doc,
  editable,
  isCreate,
  subsidiaryId,
  documentDate,
  postingDate,
  pending,
  onChange,
}: {
  kind: string;
  doc: DocumentDoc;
  editable: boolean;
  isCreate: boolean;
  /** Form values: the posting identity the next save carries. */
  subsidiaryId: string;
  documentDate: string;
  postingDate: string;
  /** Unsaved change: undefined keeps the stored rate, null clears it. */
  pending: ExplicitFxDraft | null | undefined;
  onChange: (next: ExplicitFxDraft | null | undefined) => void;
}) {
  const t = useTranslations("documents.explicitFx");
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");

  const functional = typeof doc.functional_currency === "string" ? doc.functional_currency : null;
  const stored = storedExplicitFx(doc.document_fx_rate_evidence);
  if (!EXPLICIT_FX_KINDS.has(kind) || isCreate || !functional) return null;
  if (doc.currency === functional && !stored) return null;

  const shown = pending === undefined ? stored : pending;
  const rateDate = postingDate || documentDate;
  const entityChanged = (subsidiaryId || null) !== (doc.subsidiary_id || null);
  const staleStored =
    pending === undefined && stored !== null && (stored.rateDate !== rateDate || entityChanged);
  const stalePending = pending != null && (pending.rateDate !== rateDate || entityChanged);
  const draft = doc.status === "draft";

  const openEditor = () => {
    setRate(shown?.rate ?? "");
    setSource(shown?.source ?? "");
    setReason(pending ? pending.reason : "");
    setOpen(true);
  };
  const apply = () => {
    onChange({
      rate: rate.trim(),
      source: source.trim(),
      reason: reason.trim(),
      fromCurrency: doc.currency,
      toCurrency: functional,
      rateDate,
    });
    setOpen(false);
  };

  return (
    <div className="space-y-1.5">
      <FieldLabel fieldName={t("label")}>{t("label")}</FieldLabel>
      {shown ? (
        <div className="text-sm">
          <p className="tabular-nums">
            {t("conversion", {
              from: shown.fromCurrency,
              rate: shown.rate,
              to: shown.toCurrency,
              date: shown.rateDate,
            })}
            {pending !== undefined ? (
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {t("unsaved")}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("sourceLine", { source: shown.source })}
          </p>
        </div>
      ) : (
        <p className="text-sm">
          {pending === null
            ? t("clearedUnsaved")
            : t("marketRates", { from: doc.currency, to: functional })}
        </p>
      )}
      {staleStored ? (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {t("staleStored", { date: rateDate })}
        </p>
      ) : null}
      {stalePending ? (
        <p role="alert" className="text-xs text-amber-700 dark:text-amber-300">
          {t("stalePending", { date: rateDate })}
        </p>
      ) : null}
      {editable && draft ? (
        <div className="flex flex-wrap gap-2">
          {doc.currency !== functional ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={entityChanged}
              onClick={openEditor}
            >
              {shown ? t("change") : t("record")}
            </Button>
          ) : null}
          {shown ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(stored ? null : undefined)}
            >
              {t("useMarketRates")}
            </Button>
          ) : pending === null ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
              {t("keepRecorded")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {editable && draft && entityChanged && doc.currency !== functional ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("entityChanged")}</p>
      ) : null}
      <Drawer
        open={open}
        stacked
        size="sm"
        onClose={() => setOpen(false)}
        title={t("editorTitle")}
        description={t("editorDescription", { from: doc.currency, to: functional, date: rateDate })}
        footer={
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              type="button"
              onClick={apply}
              disabled={!rate.trim() || !source.trim() || !reason.trim()}
            >
              {t("apply")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="document-fx-rate">
              {t("rate", { from: doc.currency, to: functional })}
            </Label>
            <Input
              id="document-fx-rate"
              inputMode="decimal"
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="document-fx-source">{t("source")}</Label>
            <Input
              id="document-fx-source"
              maxLength={120}
              value={source}
              placeholder={t("sourcePlaceholder")}
              onChange={(event) => setSource(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="document-fx-reason">{t("reason")}</Label>
            <Textarea
              id="document-fx-reason"
              maxLength={500}
              rows={3}
              value={reason}
              placeholder={t("reasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("appliedOnSave")}</p>
        </div>
      </Drawer>
    </div>
  );
}
