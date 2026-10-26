"use client";

import {
  Table as SharedTable,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
  TableHead as SharedTableHead,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
} from "@openbooks/ui";
import { Fragment, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useBusinessToday } from "../../../components/business-date-provider";
import { formatDecimal } from "../../../lib/money-format";
import { readApiErrorMessage } from "../../../lib/api-error";
import { toast } from "sonner";
import { ChevronDown, Download, ExternalLink, FileCheck2, Play } from "lucide-react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Popover,
  Select,
} from "@openbooks/ui";
import { DateField } from "../../../components/date-field";

type Form = {
  code: string;
  name: string;
  country: string | null;
  submission_channel: string;
  government_format: string;
  submission_url: string | null;
  /** Pack-declared filing-notice catalog key; null renders no notice. */
  notice_key: string | null;
  has_official: boolean;
};
type Box = {
  lineCode: string;
  label: string;
  value: string;
  computed: boolean;
  editable: boolean;
  inputKey?: string;
};
type Result = {
  formCode: string;
  formName: string;
  from: string;
  to: string;
  submissionChannel: string;
  watermark: string | null;
  boxes: Box[];
  subsidiaryIds: string[];
  registrationId: string | null;
  translation: { presentationCurrency: string; rateType: string; rateDate: string } | null;
};
type FilingObligation = {
  registrationId?: string;
  subsidiaryId?: string | null;
  subsidiaryName?: string | null;
  registrationNumber?: string | null;
  returnFormCode: string | null;
  reportableFrom: string;
  reportableTo: string;
};

/** An adjustment the filer entered on one of the return's adjustment lines. */
export type AdjustmentEntry = { lineCode: string; amount: string; reason: string };
/** A draft adjustment on the open preview, identified until it is saved. */
export type DraftAdjustment = AdjustmentEntry & { id: number };

/** The reason limit the engine enforces when the filing is prepared. */
export const ADJUSTMENT_REASON_MAX = 500;
const ADJUSTMENT_AMOUNT_RE = /^-?\d{1,15}(\.\d{1,4})?$/;

/**
 * Check one adjustment before it joins the preview. Returns the field to
 * correct, or the trimmed entry. Only the adjustment lines of the return
 * qualify; the server repeats every check when the filing is prepared.
 */
export function checkAdjustmentDraft(
  draft: AdjustmentEntry,
  adjustmentLines: ReadonlySet<string>,
): { ok: true; entry: AdjustmentEntry } | { ok: false; field: "lineCode" | "amount" | "reason" } {
  if (!adjustmentLines.has(draft.lineCode)) return { ok: false, field: "lineCode" };
  const amount = draft.amount.trim();
  if (!ADJUSTMENT_AMOUNT_RE.test(amount)) return { ok: false, field: "amount" };
  const reason = draft.reason.trim();
  if (!reason || reason.length > ADJUSTMENT_REASON_MAX) return { ok: false, field: "reason" };
  return { ok: true, entry: { lineCode: draft.lineCode, amount, reason } };
}

/**
 * Build the prepare-POST body for a previewed return. The prepare freezes
 * exactly what was previewed: the engine-clamped window (not the requested
 * range) plus the preview's own filing scope — the subsidiary set, the pinned
 * registration and the translation policy the engine echoed. An org-wide,
 * untranslated preview omits the optional filing entity and translation.
 */
export function buildPrepareBody(
  code: string,
  result: Pick<Result, "from" | "to" | "subsidiaryIds" | "registrationId" | "translation">,
  adjustments: readonly AdjustmentEntry[],
): Record<string, unknown> {
  return {
    code,
    from: result.from,
    to: result.to,
    adjustments: adjustments.map(({ lineCode, amount, reason }) => ({ lineCode, amount, reason })),
    ...(result.registrationId || result.subsidiaryIds.length > 0
      ? {
          filingEntity: {
            subsidiaryIds: result.subsidiaryIds,
            ...(result.registrationId ? { registrationId: result.registrationId } : {}),
          },
        }
      : {}),
    ...(result.translation
      ? {
          translation: {
            presentationCurrency: result.translation.presentationCurrency,
            rateType: result.translation.rateType,
            rateDate: result.translation.rateDate,
          },
        }
      : {}),
  };
}

/**
 * The preview's own filing scope as export query params (the export route
 * parses the same scope params as the preview): the subsidiary set, the
 * pinned registration, and the translation policy the engine echoed. An
 * org-wide, untranslated preview contributes nothing, preserving the
 * historical export shape byte-for-byte.
 */
export function exportScopeQuery(
  result: Pick<Result, "subsidiaryIds" | "registrationId" | "translation">,
): string {
  const parts: string[] = [];
  for (const id of result.subsidiaryIds) parts.push(`subsidiary=${encodeURIComponent(id)}`);
  if (result.registrationId)
    parts.push(`registration=${encodeURIComponent(result.registrationId)}`);
  if (result.translation) {
    parts.push(
      `presentationCurrency=${encodeURIComponent(result.translation.presentationCurrency)}`,
    );
    if (result.translation.rateType)
      parts.push(`rateType=${encodeURIComponent(result.translation.rateType)}`);
    if (result.translation.rateDate)
      parts.push(`rateDate=${encodeURIComponent(result.translation.rateDate)}`);
  }
  return parts.map((part) => `&${part}`).join("");
}

/**
 * The preview and export query for the entered adjustments: one `adj_<line>`
 * param per entry. The server sums entries that share a line, exactly.
 */
export function adjustmentQuery(entries: readonly AdjustmentEntry[]): string {
  return entries
    .map(
      (entry) =>
        `&adj_${encodeURIComponent(entry.lineCode)}=${encodeURIComponent(entry.amount.trim())}`,
    )
    .join("");
}

/** Return a reportable window only when the obligation belongs to this form. */
export function obligationPeriodForForm(
  obligations: readonly FilingObligation[],
  formCode: string,
): { from: string; to: string } | null {
  const match = obligations.find((obligation) => obligation.returnFormCode === formCode);
  return match ? { from: match.reportableFrom, to: match.reportableTo } : null;
}

function monthBounds(today: string): { from: string; to: string } {
  const [year, month] = today.split("-").map(Number);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year!, month!, 0));
  return { from, to: last.toISOString().slice(0, 10) };
}

function safeGovernmentUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function TaxFilingsView({
  forms,
  canSave,
  canManageSetup,
  conversionDate = null,
}: {
  forms: Form[];
  canSave: boolean;
  canManageSetup: boolean;
  /** The organization's conversion date (ISO), when its books were migrated. */
  conversionDate?: string | null;
}) {
  const t = useTranslations("tax");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const today = useBusinessToday();
  const bounds = monthBounds(today);
  const [registrations, setRegistrations] = useState<FilingObligation[]>([]);
  const [registrationId, setRegistrationId] = useState("");
  const [code, setCode] = useState(forms[0]?.code ?? "");
  const [from, setFrom] = useState(bounds.from);
  const [to, setTo] = useState(bounds.to);
  const [result, setResult] = useState<Result | null>(null);
  const [adjustments, setAdjustments] = useState<DraftAdjustment[]>([]);
  const nextAdjustmentId = useRef(1);
  const previewRequestId = useRef(0);
  const [adjustmentDraft, setAdjustmentDraft] = useState({ lineCode: "", amount: "", reason: "" });
  const [adjustmentError, setAdjustmentError] = useState<"lineCode" | "amount" | "reason" | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const selectedForm = forms.find((form) => form.code === code);
  const governmentUrl = safeGovernmentUrl(selectedForm?.submission_url);

  useEffect(
    () => () => {
      previewRequestId.current++;
    },
    [],
  );

  function invalidatePreview() {
    previewRequestId.current++;
    setResult(null);
    setBusy(false);
  }

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    void fetch(`/api/tax/filings?from=${bounds.from.slice(0, 4)}-01-01&to=${bounds.to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { obligations?: FilingObligation[] } | null) => {
        if (cancelled || !data?.obligations?.length) return;
        const matching = data.obligations.filter(
          (obligation) => obligation.returnFormCode === code,
        );
        setRegistrations(
          matching.filter(
            (value, index, all) =>
              all.findIndex((other) => other.registrationId === value.registrationId) === index,
          ),
        );
        const match = matching.length === 1 ? obligationPeriodForForm(matching, code) : null;
        if (match) {
          invalidatePreview();
          setAdjustments([]);
          setFrom(match.from);
          setTo(match.to);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code, bounds.from, bounds.to]);

  const fmt = (value: string) =>
    formatDecimal(locale, value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const editableBoxes =
    result?.boxes.filter((box) => box.editable && !box.computed && !box.inputKey) ?? [];
  const adjustmentLines = new Set(editableBoxes.map((box) => box.lineCode));
  // A return that began before the organization's conversion holds only the
  // activity recorded here; the filer adds the earlier amounts as adjustments.
  const showConversionNotice =
    Boolean(conversionDate) &&
    Boolean(result) &&
    editableBoxes.length > 0 &&
    result!.from < conversionDate!;

  async function compute(values: readonly AdjustmentEntry[] = adjustments) {
    if (!code) return;
    const requestId = ++previewRequestId.current;
    setResult(null);
    setBusy(true);
    try {
      const response = await fetch(
        `/api/tax/returns/${encodeURIComponent(code)}?from=${from}&to=${to}${adjustmentQuery(values)}${registrationId ? `&registration=${encodeURIComponent(registrationId)}${registrations.find((reg) => reg.registrationId === registrationId)?.subsidiaryId ? `&subsidiary=${registrations.find((reg) => reg.registrationId === registrationId)!.subsidiaryId}` : ""}` : ""}`,
      );
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, tCommon("feedback.saveFailed")));
      const computed = (await response.json()) as Result;
      if (requestId === previewRequestId.current) setResult(computed);
    } catch (e) {
      if (requestId === previewRequestId.current)
        toast.error(e instanceof Error ? e.message : tCommon("feedback.saveFailed"));
    } finally {
      if (requestId === previewRequestId.current) setBusy(false);
    }
  }

  async function saveSnapshot() {
    if (!result || busy || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/tax/filings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPrepareBody(code, result, adjustments)),
      });
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, tCommon("feedback.saveFailed")));
      toast.success(t("history.saved"));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tCommon("feedback.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function addAdjustment() {
    const draft = {
      lineCode: adjustmentLines.has(adjustmentDraft.lineCode)
        ? adjustmentDraft.lineCode
        : (editableBoxes[0]?.lineCode ?? ""),
      amount: adjustmentDraft.amount,
      reason: adjustmentDraft.reason,
    };
    const checked = checkAdjustmentDraft(draft, adjustmentLines);
    if (!checked.ok) {
      setAdjustmentError(checked.field);
      return;
    }
    if (busy || saving) return;
    setAdjustmentError(null);
    const next = [...adjustments, { id: nextAdjustmentId.current++, ...checked.entry }];
    setAdjustments(next);
    setAdjustmentDraft({ lineCode: draft.lineCode, amount: "", reason: "" });
    void compute(next);
  }

  function removeAdjustment(id: number) {
    if (busy || saving) return;
    const next = adjustments.filter((entry) => entry.id !== id);
    setAdjustments(next);
    void compute(next);
  }

  const exportHref = (format: string) =>
    `/api/tax/returns/${encodeURIComponent(code)}/export?from=${from}&to=${to}&format=${format}${adjustmentQuery(adjustments)}${result ? exportScopeQuery(result) : ""}`;

  return (
    <div className="space-y-6">
      {forms.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("noForms.title")}</CardTitle>
            <CardDescription>{t("noForms.description")}</CardDescription>
          </CardHeader>
          {canManageSetup ? (
            <CardContent>
              <Button asChild>
                <Link href="/admin/setup/tax-return-forms">{t("noForms.openSetup")}</Link>
              </Button>
            </CardContent>
          ) : null}
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3 pt-6">
              <div className="min-w-52 flex-1 space-y-1.5">
                <Label htmlFor="tax-form">{t("form")}</Label>
                <Select
                  id="tax-form"
                  disabled={busy || saving}
                  value={code}
                  onChange={(event) => {
                    setRegistrationId("");
                    setRegistrations([]);
                    setCode(event.target.value);
                    setFrom(bounds.from);
                    setTo(bounds.to);
                    setAdjustments([]);
                    setAdjustmentError(null);
                    invalidatePreview();
                  }}
                >
                  {forms.map((form) => (
                    <option key={form.code} value={form.code}>
                      {form.name}
                    </option>
                  ))}
                </Select>
              </div>
              {registrations.length ? (
                <div className="space-y-1.5">
                  <Label htmlFor="tax-registration">{t("registration")}</Label>
                  <Select
                    id="tax-registration"
                    disabled={busy || saving}
                    value={registrationId}
                    onChange={(event) => {
                      setRegistrationId(event.target.value);
                      setAdjustments([]);
                      invalidatePreview();
                    }}
                  >
                    <option value="">—</option>
                    {registrations.map((reg) => (
                      <option key={reg.registrationId} value={reg.registrationId}>
                        {reg.registrationNumber ?? reg.registrationId}
                        {reg.subsidiaryName ? ` — ${reg.subsidiaryName}` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="tax-from">{t("from")}</Label>
                <DateField
                  id="tax-from"
                  disabled={busy || saving}
                  value={from}
                  onChange={(value) => {
                    setFrom(value);
                    setAdjustments([]);
                    invalidatePreview();
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tax-to">{t("to")}</Label>
                <DateField
                  id="tax-to"
                  disabled={busy || saving}
                  value={to}
                  onChange={(value) => {
                    setTo(value);
                    setAdjustments([]);
                    invalidatePreview();
                  }}
                />
              </div>
              <Button onClick={() => compute()} disabled={busy || saving}>
                <Play size={15} />
                {busy ? t("computing") : t("compute")}
              </Button>
            </CardContent>
            {selectedForm ? (
              <CardContent className="border-t border-slate-100 pt-4 dark:border-slate-800">
                <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5">
                      <FileCheck2 className="mt-0.5 text-teal-600 dark:text-teal-400" size={18} />
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-slate-100">
                          {t("submission.title")}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {t("submission.description")}
                        </p>
                      </div>
                    </div>
                    {governmentUrl ? (
                      <Button variant="outline" size="sm" asChild>
                        <a href={governmentUrl} target="_blank" rel="noreferrer">
                          {t("submission.openGovernment")} <ExternalLink size={13} />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-md bg-white px-3 py-2.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {t("submission.channelLabel")}
                      </dt>
                      <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {t(`channels.${selectedForm.submission_channel}`)}
                      </dd>
                    </div>
                    <div className="rounded-md bg-white px-3 py-2.5 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
                      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {t("submission.actionLabel")}
                      </dt>
                      <dd className="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {t(`governmentFormats.${selectedForm.government_format}`)}
                      </dd>
                    </div>
                  </dl>
                </div>
                <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                  {t("submission.exportNotice")}
                </p>
                {selectedForm.notice_key ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    {t(selectedForm.notice_key)}
                  </p>
                ) : null}
              </CardContent>
            ) : null}
          </Card>

          {result ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>{result.formName}</CardTitle>
                    <CardDescription>
                      {t("period", { from: result.from, to: result.to })}
                    </CardDescription>
                  </div>
                  {canSave ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void saveSnapshot()}
                      disabled={saving || busy}
                    >
                      <FileCheck2 size={14} />
                      {saving ? t("history.saving") : t("history.save")}
                    </Button>
                  ) : null}
                  <Popover
                    open={exportOpen}
                    onOpenChange={setExportOpen}
                    align="end"
                    className="w-56 p-1"
                    trigger={
                      <Button
                        disabled={busy || saving}
                        size="sm"
                        onClick={() => setExportOpen((o) => !o)}
                      >
                        <Download size={14} />
                        {t("export.menu")}
                        <ChevronDown size={14} className="opacity-70" />
                      </Button>
                    }
                  >
                    <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {t("export.groupForm")}
                    </div>
                    <ExportItem
                      href={exportHref("facsimile")}
                      onNavigate={() => setExportOpen(false)}
                    >
                      {t("export.facsimile")}
                    </ExportItem>
                    {selectedForm?.has_official ? (
                      <ExportItem
                        href={exportHref("official")}
                        onNavigate={() => setExportOpen(false)}
                      >
                        {t("official.download")}
                      </ExportItem>
                    ) : null}
                    <div className="mt-1 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {t("export.groupData")}
                    </div>
                    <ExportItem href={exportHref("pdf")} onNavigate={() => setExportOpen(false)}>
                      {t("export.pdf")}
                    </ExportItem>
                    <ExportItem href={exportHref("xlsx")} onNavigate={() => setExportOpen(false)}>
                      {t("export.xlsx")}
                    </ExportItem>
                    <ExportItem href={exportHref("csv")} onNavigate={() => setExportOpen(false)}>
                      {t("export.csv")}
                    </ExportItem>
                    <ExportItem href={exportHref("json")} onNavigate={() => setExportOpen(false)}>
                      {t("export.json")}
                    </ExportItem>
                  </Popover>
                </div>
              </CardHeader>
              <CardContent>
                {showConversionNotice ? (
                  <div
                    role="note"
                    className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    <span>{t("conversion.notice", { date: conversionDate! })}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => document.getElementById("tax-adjustment-amount")?.focus()}
                    >
                      {t("conversion.action")}
                    </Button>
                  </div>
                ) : null}
                {result.watermark ? (
                  <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                    {result.watermark}
                  </p>
                ) : null}
                <SharedTable className="w-full text-sm">
                  <SharedTableHeader>
                    <SharedTableRow className="border-b border-slate-200 text-left text-xs uppercase text-slate-500 dark:border-slate-800">
                      <SharedTableHead className="py-2 pr-4 font-medium">
                        {t("columns.line")}
                      </SharedTableHead>
                      <SharedTableHead className="py-2 pr-4 font-medium">
                        {t("columns.description")}
                      </SharedTableHead>
                      <SharedTableHead className="py-2 text-right font-medium">
                        {t("columns.amount")}
                      </SharedTableHead>
                    </SharedTableRow>
                  </SharedTableHeader>
                  <SharedTableBody>
                    {result.boxes.map((box) => (
                      <Fragment key={box.lineCode}>
                        <SharedTableRow
                          className={`border-b border-slate-100 dark:border-slate-900 ${box.computed ? "font-semibold text-slate-900 dark:text-slate-100" : ""}`}
                        >
                          <SharedTableCell className="py-2 pr-4 tabular-nums text-slate-500">
                            {box.lineCode}
                          </SharedTableCell>
                          <SharedTableCell className="py-2 pr-4">{box.label}</SharedTableCell>
                          <SharedTableCell className="py-2 text-right tabular-nums">
                            {fmt(box.value)}
                          </SharedTableCell>
                        </SharedTableRow>
                        {adjustments
                          .filter((entry) => entry.lineCode === box.lineCode)
                          .map((entry) => (
                            <SharedTableRow
                              key={entry.id}
                              className="border-b border-slate-100 text-slate-600 dark:border-slate-900 dark:text-slate-300"
                            >
                              <SharedTableCell className="py-1.5 pr-4 text-xs text-slate-400">
                                {entry.lineCode}
                              </SharedTableCell>
                              <SharedTableCell className="py-1.5 pr-4 text-sm">
                                <span className="mr-2 text-xs uppercase tracking-wide text-slate-400">
                                  {t("adjustments.entryLabel")}
                                </span>
                                {entry.reason}
                              </SharedTableCell>
                              <SharedTableCell className="py-1.5 text-right tabular-nums">
                                {fmt(entry.amount)}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="ml-2"
                                  disabled={busy || saving}
                                  aria-label={t("adjustments.removeAria", { reason: entry.reason })}
                                  onClick={() => removeAdjustment(entry.id)}
                                >
                                  {t("adjustments.remove")}
                                </Button>
                              </SharedTableCell>
                            </SharedTableRow>
                          ))}
                      </Fragment>
                    ))}
                  </SharedTableBody>
                </SharedTable>
                {editableBoxes.length > 0 ? (
                  <section
                    aria-labelledby="tax-adjustments-heading"
                    className="mt-5 space-y-3 rounded-lg border border-slate-200 p-4 dark:border-slate-800"
                  >
                    <div>
                      <h3
                        id="tax-adjustments-heading"
                        className="text-sm font-semibold text-slate-900 dark:text-slate-100"
                      >
                        {t("adjustments.title")}
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {t("adjustments.description")}
                      </p>
                    </div>
                    <form
                      noValidate
                      className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_8rem_minmax(0,1fr)_auto] sm:items-end"
                      onSubmit={(event) => {
                        event.preventDefault();
                        addAdjustment();
                      }}
                    >
                      <div className="space-y-1.5">
                        <Label htmlFor="tax-adjustment-line">{t("adjustments.line")}</Label>
                        <Select
                          id="tax-adjustment-line"
                          value={
                            adjustmentLines.has(adjustmentDraft.lineCode)
                              ? adjustmentDraft.lineCode
                              : (editableBoxes[0]?.lineCode ?? "")
                          }
                          onChange={(event) =>
                            setAdjustmentDraft((current) => ({
                              ...current,
                              lineCode: event.target.value,
                            }))
                          }
                        >
                          {editableBoxes.map((box) => (
                            <option key={box.lineCode} value={box.lineCode}>
                              {box.lineCode} — {box.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="tax-adjustment-amount">{t("adjustments.amount")}</Label>
                        <Input
                          id="tax-adjustment-amount"
                          inputMode="decimal"
                          placeholder={t("adjustments.amountPlaceholder")}
                          value={adjustmentDraft.amount}
                          aria-invalid={adjustmentError === "amount"}
                          onChange={(event) =>
                            setAdjustmentDraft((current) => ({
                              ...current,
                              amount: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="tax-adjustment-reason">{t("adjustments.reason")}</Label>
                        <Input
                          id="tax-adjustment-reason"
                          maxLength={ADJUSTMENT_REASON_MAX}
                          placeholder={t("adjustments.reasonPlaceholder")}
                          value={adjustmentDraft.reason}
                          aria-invalid={adjustmentError === "reason"}
                          onChange={(event) =>
                            setAdjustmentDraft((current) => ({
                              ...current,
                              reason: event.target.value,
                            }))
                          }
                        />
                      </div>
                      <Button type="submit" variant="outline" disabled={busy || saving}>
                        {t("adjustments.add")}
                      </Button>
                    </form>
                    {adjustmentError ? (
                      <p
                        role="alert"
                        className="text-xs font-medium text-red-700 dark:text-red-300"
                      >
                        {t(`adjustments.errors.${adjustmentError}`)}
                      </p>
                    ) : null}
                  </section>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("empty")}</p>
          )}
        </>
      )}
    </div>
  );
}

/** A download row inside the Export dropdown: a plain browser navigation to the
 *  export URL, closing the menu on click. */
function ExportItem({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      onClick={onNavigate}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <Download size={14} className="text-slate-400" />
      {children}
    </a>
  );
}
