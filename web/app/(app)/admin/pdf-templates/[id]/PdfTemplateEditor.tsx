"use client";

// The PDF template editor shell — top bar (name, paper setup, save), a
// header/footer bar, and three bodies: Design (GrapesJS paper canvas), HTML
// (CodeMirror source), Preview (exact Chromium-rendered PDF merged with the
// org's most recent record). The design and code tabs edit the SAME source —
// switching serializes one into the other, so raw-HTML authors and visual
// authors round-trip losslessly.

import Link from "next/link";
import { assertMicrFont } from "@openbooks/pdf/micr-font";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { refusalMessageFromBody } from "@/lib/api-error";
import { toast } from "sonner";
import { html as htmlLang } from "@codemirror/lang-html";
import { EditorView } from "@codemirror/view";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, Input } from "@openbooks/ui";
import { readApiErrorMessage } from "../../../../../lib/api-error";
import { confirmDialog } from "../../../../../lib/confirm";
import { prettifyTemplateHtml } from "../../../../../lib/pdf-templates/prettify";
import { useUnsavedNavigationGuard } from "../../../../../lib/use-unsaved-navigation-guard";
import { type PaletteCollection, type PaletteField } from "./builder-blocks";
import { PDF_RECORD_TYPE_BY_KEY } from "../../../../../lib/pdf-templates/catalog";
import { starterTemplate } from "../../../../../lib/pdf-templates/starters";
import {
  applyChequeStock,
  chequeStockFromSource,
  applyChequeBankDesign,
  type ChequeStockPosition,
} from "../../../../../lib/pdf-templates/cheque-stock";

const PdfBuilder = dynamic(() => import("./PdfBuilder"), { ssr: false });
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), { ssr: false });

export type EditorTemplate = {
  id: string;
  recordType: string;
  recordTypeLabel: string;
  name: string;
  description: string | null;
  paperSize: "letter" | "a4" | "legal" | "4x6";
  orientation: "portrait" | "landscape";
  marginMm: number;
  headerHtml: string | null;
  footerHtml: string | null;
  sourceHtml: string;
  isDefault: boolean;
  isActive: boolean;
};

// 96-dpi page pixel sizes (portrait) per paper.
const PAPER_PX: Record<string, [number, number]> = {
  letter: [816, 1056],
  a4: [794, 1123],
  legal: [816, 1344],
  "4x6": [384, 576],
};
const MM_TO_PX = 3.7795;

export default function PdfTemplateEditor({
  template,
  mergeFields,
  collections,
  chequeBankProfiles = [],
}: {
  template: EditorTemplate;
  mergeFields: PaletteField[];
  collections: PaletteCollection[];
  chequeBankProfiles?: Array<{ id: string; name: string }>;
}) {
  const t = useTranslations("pdfTemplates");
  const tCommon = useTranslations("common");
  const paperLabel = {
    letter: t("list.paperLetter"),
    a4: t("list.paperA4"),
    legal: t("list.paperLegal"),
    "4x6": t("list.paper4x6"),
  };
  const router = useRouter();

  const [tab, setTab] = useState<"design" | "code" | "preview">("design");
  const [name, setName] = useState(template.name);
  const [paperSize, setPaperSize] = useState(template.paperSize);
  const [orientation, setOrientation] = useState(template.orientation);
  const [marginMm, setMarginMm] = useState(template.marginMm);
  const [headerHtml, setHeaderHtml] = useState(template.headerHtml ?? "");
  const [footerHtml, setFooterHtml] = useState(template.footerHtml ?? "");
  const [isDefault, setIsDefault] = useState(template.isDefault);
  const [sourceHtml, setSourceHtml] = useState(template.sourceHtml);
  const initialSnapshot = JSON.stringify([
    template.name,
    template.sourceHtml,
    template.headerHtml ?? "",
    template.footerHtml ?? "",
    template.paperSize,
    template.orientation,
    template.marginMm,
    template.isDefault,
  ]);
  const [savedSnapshot, setSavedSnapshot] = useState(initialSnapshot);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // A renderer outage is a persistent pane refusal, not a transient toast:
  // the preview can never succeed until the server's renderer is fixed.
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Remount the builder whenever we re-enter Design so it reloads sourceHtml.
  const [designEpoch, setDesignEpoch] = useState(0);
  const [stock, setStock] = useState<ChequeStockPosition>(
    chequeStockFromSource(template.sourceHtml)?.stock ?? "top",
  );
  const [offsetX, setOffsetX] = useState(
    String(chequeStockFromSource(template.sourceHtml)?.xMm ?? 0),
  );
  const [bankProfileId, setBankProfileId] = useState(
    () => template.sourceHtml.match(/data-cheque-bank-profile=["']([^"']*)["']/i)?.[1] ?? "",
  );
  const [micrEncoding, setMicrEncoding] = useState<"unicode" | "abcd">(() =>
    template.sourceHtml.includes('data-cheque-micr-encoding="abcd"') ? "abcd" : "unicode",
  );
  const [printMicr, setPrintMicr] = useState(() =>
    template.sourceHtml.includes('data-cheque-micr="printed"'),
  );
  const [offsetY, setOffsetY] = useState(
    String(chequeStockFromSource(template.sourceHtml)?.yMm ?? 0),
  );

  const [pw, ph] = PAPER_PX[paperSize] ?? PAPER_PX.letter!;
  const pageWidthPx = orientation === "landscape" ? ph : pw;
  const pageHeightPx = orientation === "landscape" ? pw : ph;
  const marginPx = Math.round(marginMm * MM_TO_PX);

  /** The current source, preferring the live canvas when Design is open. */
  const snapshot = useCallback((): string => {
    return sourceHtml;
  }, [sourceHtml]);

  const draftSnapshot = useMemo(
    () =>
      JSON.stringify([
        name,
        snapshot(),
        headerHtml,
        footerHtml,
        paperSize,
        orientation,
        marginMm,
        isDefault,
      ]),
    [footerHtml, headerHtml, isDefault, marginMm, name, orientation, paperSize, snapshot],
  );
  const dirty = draftSnapshot !== savedSnapshot;
  useUnsavedNavigationGuard(
    dirty,
    tCommon("feedback.unsavedChanges"),
    tCommon("confirm.discardChanges"),
  );

  function switchTab(next: "design" | "code" | "preview") {
    if (next === tab) return;
    const current = snapshot();
    setSourceHtml(current);
    if (next === "design") {
      setDesignEpoch((n) => n + 1);
    }
    if (next === "code") {
      // Show human-readable markup even before the first save (the canvas
      // serializes to one long line). Whitespace-only; render-neutral.
      void prettifyTemplateHtml(current).then((pretty) => setSourceHtml(pretty));
    }
    if (next === "preview") void refreshPreview(current);
    setTab(next);
  }

  async function refreshPreview(source?: string, calibration = false) {
    setPreviewBusy(true);
    setPreviewError(null);
    setPreviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    try {
      const res = await fetch("/api/pdf-templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordType: template.recordType,
          sourceHtml: source ?? snapshot(),
          headerHtml,
          footerHtml,
          paperSize,
          orientation,
          marginMm,
          calibration,
        }),
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res, t("editor.previewFailed"));
        setPreviewError(message);
        return;
      }
      const blob = await res.blob();
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch {
      setPreviewError(t("editor.previewFailed"));
    } finally {
      setPreviewBusy(false);
    }
  }

  function changeStock(replaceBody: boolean) {
    try {
      const source = replaceBody
        ? starterTemplate(PDF_RECORD_TYPE_BY_KEY.payroll_cheque!).sourceHtml
        : snapshot();
      if (!offsetX.trim() || !offsetY.trim()) throw new Error(t("editor.chequeOffsetsRequired"));
      setSourceHtml(
        applyChequeBankDesign(
          applyChequeStock(source, stock, Number(offsetX), Number(offsetY)),
          bankProfileId || null,
          printMicr,
          micrEncoding,
        ),
      );
      setPaperSize("letter");
      setOrientation("portrait");
      setMarginMm(0);
      setHeaderHtml("");
      setFooterHtml("");
      setDesignEpoch((epoch) => epoch + 1);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      if (tab === "preview") setTab("design");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("editor.saveFailed"));
    }
  }

  function changeBankControls(profileId: string, micr: boolean, encoding: "unicode" | "abcd") {
    try {
      setSourceHtml(applyChequeBankDesign(snapshot(), profileId || null, micr, encoding));
      setBankProfileId(profileId);
      setPrintMicr(micr);
      setMicrEncoding(encoding);
      setDesignEpoch((epoch) => epoch + 1);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("editor.saveFailed"));
    }
  }

  async function embedMicrFont(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 262144) throw new Error(t("editor.chequeFontSize"));
      const bytes = new Uint8Array(await file.arrayBuffer());
      assertMicrFont(bytes, micrEncoding);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const font = `<style id="ob-cheque-micr-font">@font-face{font-family:OpenBooksE13B;src:url(data:font/ttf;base64,${btoa(binary)}) format('truetype');font-weight:normal;font-style:normal;}</style>`;
      setSourceHtml(
        snapshot().replace(
          /<style[^>]*id=["']ob-cheque-micr-font["'][^>]*>[\s\S]*?<\/style>/gi,
          "",
        ) + font,
      );
      setDesignEpoch((epoch) => epoch + 1);
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("editor.saveFailed"));
    }
  }

  useEffect(() => () => void (previewUrl && URL.revokeObjectURL(previewUrl)), [previewUrl]);

  async function save() {
    const source = snapshot();
    setSourceHtml(source);
    setBusy(true);
    try {
      const res = await fetch(`/api/pdf-templates/${template.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sourceHtml: source,
          headerHtml,
          footerHtml,
          paperSize,
          orientation,
          marginMm,
          isDefault,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of the bare `error` field.
      if (!res.ok) {
        toast.error(
          refusalMessageFromBody(data, { fallback: t("editor.saveFailed") }) ??
            t("editor.saveFailed"),
        );
        return;
      }
      setSavedSnapshot(
        JSON.stringify([
          name,
          source,
          headerHtml,
          footerHtml,
          paperSize,
          orientation,
          marginMm,
          isDefault,
        ]),
      );
      toast.success(t("editor.saved"));
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: tCommon("actions.delete"),
        message: t("editor.deleteConfirm"),
        tone: "danger",
      }))
    )
      return;
    setBusy(true);
    try {
      const res = await fetch(`/api/pdf-templates/${template.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("editor.saveFailed")));
        return;
      }
      router.push(`/admin/pdf-templates?recordType=${template.recordType}`);
    } catch {
      toast.error(t("editor.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const tabButton = (key: "design" | "code" | "preview", label: string) => (
    <button
      onClick={() => switchTab(key)}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${
        tab === key
          ? "bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300"
          : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-[calc(100vh-6.5rem)] min-h-[540px] flex-col gap-3" inert={busy}>
      {/* ---- Top bar ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/pdf-templates?recordType=${template.recordType}`}
          className="flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
        >
          <ArrowLeft size={15} /> {t("editor.back")}
        </Link>
        <Badge variant="secondary">{template.recordTypeLabel}</Badge>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-64" />
        <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
          {tabButton("design", t("editor.design"))}
          {tabButton("code", t("editor.code"))}
          {tabButton("preview", t("editor.preview"))}
        </div>
        <span className="flex-1" />
        <select
          value={paperSize}
          onChange={(e) => setPaperSize(e.target.value as EditorTemplate["paperSize"])}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          {Object.entries(paperLabel).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={orientation}
          onChange={(e) => setOrientation(e.target.value as EditorTemplate["orientation"])}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="portrait">{t("editor.portrait")}</option>
          <option value="landscape">{t("editor.landscape")}</option>
        </select>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          {t("editor.margins")}
          <Input
            type="number"
            min={template.recordType === "payroll_cheque" ? 0 : 5}
            max={30}
            value={marginMm}
            onChange={(e) =>
              setMarginMm(
                Math.min(
                  30,
                  Math.max(
                    template.recordType === "payroll_cheque" ? 0 : 5,
                    Number(e.target.value) || 0,
                  ),
                ),
              )
            }
            className="h-9 w-16"
          />
          mm
        </label>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          {t("editor.makeDefault")}
        </label>
        <Button onClick={save} disabled={busy}>
          {busy ? tCommon("actions.saving") : tCommon("actions.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={remove}
          className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          {tCommon("actions.delete")}
        </Button>
      </div>

      {/* ---- Running header/footer ---- */}
      {template.recordType === "payroll_cheque" ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <label>
            {t("editor.chequeStock")}
            <select
              className="ml-2 rounded border p-1 dark:bg-slate-900"
              value={stock}
              onChange={(event) => setStock(event.target.value as ChequeStockPosition)}
            >
              {(["top", "middle", "bottom"] as const).map((position) => (
                <option key={position} value={position}>
                  {t(`editor.chequeStock_${position}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("editor.chequeOffsetX")}
            <Input
              className="mt-1 h-8 w-24"
              type="number"
              min="-6"
              max="6"
              step="0.1"
              value={offsetX}
              onChange={(event) => setOffsetX(event.target.value)}
            />
          </label>
          <label>
            {t("editor.chequeOffsetY")}
            <Input
              className="mt-1 h-8 w-24"
              type="number"
              min="-6"
              max="6"
              step="0.1"
              value={offsetY}
              onChange={(event) => setOffsetY(event.target.value)}
            />
          </label>
          <label>
            {t("editor.chequeBankProfile")}
            <select
              className="ml-2 rounded border p-1 dark:bg-slate-900"
              value={bankProfileId}
              onChange={(event) => changeBankControls(event.target.value, printMicr, micrEncoding)}
            >
              <option value="">{t("editor.chequePreprinted")}</option>
              {bankProfileId && !chequeBankProfiles.some((p) => p.id === bankProfileId) ? (
                <option value={bankProfileId}>{t("editor.chequeSavedProfile")}</option>
              ) : null}
              {chequeBankProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={printMicr}
              onChange={(event) =>
                changeBankControls(bankProfileId, event.target.checked, micrEncoding)
              }
            />
            {t("editor.chequePrintMicr")}
          </label>
          {printMicr ? (
            <label>
              {t("editor.chequeFontEncoding")}
              <select
                className="ml-2 rounded border p-1 dark:bg-slate-900"
                value={micrEncoding}
                onChange={(event) =>
                  changeBankControls(
                    bankProfileId,
                    printMicr,
                    event.target.value as "unicode" | "abcd",
                  )
                }
              >
                <option value="unicode">Unicode · ⑆ ⑈ ⑉</option>
                <option value="abcd">A / C / D</option>
              </select>
            </label>
          ) : null}
          {printMicr ? (
            <label>
              {t("editor.chequeFont")}
              <Input
                type="file"
                accept=".ttf,font/ttf"
                onChange={(event) => void embedMicrFont(event.target.files?.[0])}
              />
            </label>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => changeStock(false)}
            disabled={!chequeStockFromSource(sourceHtml)}
          >
            {t("editor.chequeAlign")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => changeStock(true)}>
            {t("editor.chequeStartPreset")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={previewBusy}
            onClick={() => {
              setTab("preview");
              void refreshPreview(undefined, true);
            }}
          >
            {t("editor.chequeCalibration")}
          </Button>
          <p className="w-full text-xs text-slate-500">
            {t("editor.chequeStockHint")} {t("editor.chequeMicrHint")}{" "}
            <Link
              href="/admin/setup/payment-operations?view=profiles"
              className="text-teal-700 underline"
            >
              {t("editor.chequeBankSetup")}
            </Link>
          </p>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <Input
          value={headerHtml}
          onChange={(e) => setHeaderHtml(e.target.value)}
          placeholder={t("editor.headerPlaceholder")}
          className="h-8 font-mono text-xs"
        />
        <Input
          value={footerHtml}
          onChange={(e) => setFooterHtml(e.target.value)}
          placeholder={t("editor.footerPlaceholder")}
          className="h-8 font-mono text-xs"
        />
      </div>

      {/* ---- Body ---- */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
        {tab === "design" ? (
          <PdfBuilder
            key={designEpoch}
            initialHtml={sourceHtml}
            pageWidthPx={pageWidthPx}
            pageHeightPx={pageHeightPx}
            marginPx={marginPx}
            paperLabel={`${paperLabel[paperSize]} · ${orientation === "landscape" ? t("editor.landscape") : t("editor.portrait")}`}
            onReady={() => {}}
            onChange={setSourceHtml}
            mergeFields={mergeFields}
            collections={collections}
            labels={{
              content: t("editor.blockContent"),
              fields: t("editor.blockFields"),
              tables: t("editor.blockTables"),
            }}
          />
        ) : tab === "code" ? (
          <div className="h-full overflow-auto bg-white dark:bg-slate-950">
            <CodeMirror
              value={sourceHtml}
              onChange={(v) => setSourceHtml(v)}
              extensions={[htmlLang(), EditorView.lineWrapping]}
              height="100%"
              style={{ height: "100%", fontSize: 12 }}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col bg-[#3f4856]">
            <div className="flex items-center gap-3 border-b border-black/20 px-3 py-2">
              <span className="text-xs text-white/80">{t("editor.previewHint")}</span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="outline"
                onClick={() => refreshPreview()}
                disabled={previewBusy}
              >
                {previewBusy ? tCommon("actions.saving") : t("editor.refreshPreview")}
              </Button>
            </div>
            {previewUrl ? (
              <iframe title="pdf-preview" src={previewUrl} className="min-h-0 w-full flex-1" />
            ) : previewError ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <div
                  role="alert"
                  className="max-w-lg rounded-lg border border-amber-300/40 bg-amber-950/60 p-5 text-sm text-amber-100"
                >
                  <p className="font-semibold text-amber-200">{t("editor.previewFailed")}</p>
                  <p className="mt-2 leading-relaxed">{previewError}</p>
                  <p className="mt-2 text-amber-200/80">{t("editor.chequePreviewRemedy")}</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-white/70">
                {previewBusy ? "…" : t("editor.previewHint")}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
