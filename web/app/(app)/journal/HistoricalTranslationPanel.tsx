"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, Label, SearchSelect, Skeleton } from "@openbooks/ui";
import { CabinetSourceVersionPicker } from "@/components/cabinet-source-version-picker";
import { readApiErrorMessage } from "@/lib/api-error";
import { historicalTranslationProposalBody } from "@/lib/api/historical-translation-schema";
import { confirmDialog } from "@/lib/confirm";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { isUuid } from "@/lib/list-params";
import type { readHistoricalTranslationAuthoringContext } from "@openbooks/engine/journal/historical-translation-evidence";
import type {
  HistoricalTranslationEvidence,
  HistoricalTranslationInstruction,
  HistoricalTranslationLayerInstruction,
} from "@openbooks/engine/journal/historical-translation-evidence";
import { DateField } from "@/components/date-field";

export type HistoricalTranslationSourceOption = { id: string; label: string };
type AuthoringContext = Awaited<ReturnType<typeof readHistoricalTranslationAuthoringContext>>;
const emptyLayer = (amount = ""): HistoricalTranslationLayerInstruction => ({
  amount,
  rate: "",
  historicalDate: "",
  provenance: "",
  source: { fileId: "", versionId: "", contentHash: "" },
  originalLayerId: null,
});

/** The selected physical source owns one assessment body inside the journal shell. */
export function HistoricalTranslationPanel({
  sources,
  onDirtyChange,
}: {
  sources: HistoricalTranslationSourceOption[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useTranslations("journal.historicalTranslation");
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  async function selectSource(id: string) {
    if (dirty && !(await confirmDialog(t("discardDraft")))) return;
    setDirty(false);
    onDirtyChange(false);
    setSourceId(id);
  }
  return (
    <div className="space-y-4">
      <Label>{t("physicalLine")}</Label>
      <SearchSelect
        ariaLabel={t("physicalLine")}
        value={sourceId}
        disabled={busy}
        options={sources.map((source) => ({ value: source.id, label: source.label }))}
        onChange={(id) => {
          void selectSource(id);
        }}
      />
      {sourceId ? (
        <SourceAssessment
          key={sourceId}
          sourceLineId={sourceId}
          onBusyChange={setBusy}
          onDirtyChange={(value) => {
            setDirty(value);
            onDirtyChange(value);
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("noSources")}</p>
      )}
    </div>
  );
}

function SourceAssessment({
  sourceLineId,
  onDirtyChange,
  onBusyChange,
}: {
  sourceLineId: string;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useTranslations("journal.historicalTranslation");
  const [context, setContext] = useState<AuthoringContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState("new");
  const [kind, setKind] = useState<HistoricalTranslationInstruction["kind"]>("contribution");
  const [measurementCurrency, setMeasurementCurrency] = useState("");
  const [presentationCurrency, setPresentationCurrency] = useState("");
  const [layers, setLayers] = useState<HistoricalTranslationLayerInstruction[]>([emptyLayer()]);
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const requestIdentity = useRef<{ body: string; key: string } | null>(null);
  const initializedDraft = useRef(false);
  const loading = context === null && error === null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/journals/historical-translation?sourceLineId=${encodeURIComponent(sourceLineId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        const result = (await response.json()) as AuthoringContext;
        if (result.source.lineId !== sourceLineId) throw new Error(t("loadFailed"));
        if (!controller.signal.aborted) {
          if (!initializedDraft.current) {
            initializedDraft.current = true;
            setKind(result.source.reversesEntryId ? "correction" : "contribution");
            setLayers([emptyLayer(result.source.reversesEntryId ? "" : result.source.amount)]);
          }
          setContext(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : t("loadFailed"));
      });
    return () => controller.abort();
  }, [sourceLineId, reload, t]);

  function markDirty() {
    setDirty(true);
    onDirtyChange(true);
  }
  function updateLayer(index: number, patch: Partial<HistoricalTranslationLayerInstruction>) {
    markDirty();
    setLayers((current) =>
      current.map((layer, position) => (position === index ? { ...layer, ...patch } : layer)),
    );
  }
  async function selectAssessment(next: string) {
    if (dirty && !(await confirmDialog(t("discardDraft")))) return;
    if (next === "new") {
      setMeasurementCurrency("");
      setPresentationCurrency("");
      setReason("");
      setKind(context?.source.reversesEntryId ? "correction" : "contribution");
      setLayers([
        emptyLayer(context?.source.reversesEntryId ? "" : (context?.source.amount ?? "")),
      ]);
      requestIdentity.current = null;
    }
    setDirty(false);
    onDirtyChange(false);
    setSelection(next);
  }
  function changeKind(next: string) {
    markDirty();
    setKind(next as HistoricalTranslationInstruction["kind"]);
    setLayers([emptyLayer(next === "contribution" ? (context?.source.amount ?? "") : "")]);
  }
  const instruction: HistoricalTranslationInstruction = {
    sourceLineId,
    measurementCurrency,
    presentationCurrency,
    kind,
    layers,
  };
  const validation = historicalTranslationProposalBody.safeParse({
    instruction,
    reason,
    idempotencyKey: "validation",
  });
  const proposal = context?.proposals.find((row) => `proposal:${row.changeId}` === selection);
  const certificate = context?.certificates.find(
    (row) => `certificate:${row.basisId}` === selection,
  );
  const assessment = proposal?.evidence ?? certificate?.evidence;
  const existingPair = context?.certificates.some(
    (row) => row.evidence.instruction.presentationCurrency === presentationCurrency,
  );
  const identityRateValid =
    measurementCurrency !== presentationCurrency ||
    layers.every((layer) => canonicalDecimal(layer.rate, 10) === "1");
  const originals =
    context?.originalLayers.filter(
      (layer) =>
        layer.measurementCurrency === measurementCurrency &&
        layer.presentationCurrency === presentationCurrency &&
        (!context.source.reversesEntryId || layer.entryId === context.source.reversesEntryId),
    ) ?? [];

  async function propose() {
    if (!validation.success || !identityRateValid || busy) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    const body = JSON.stringify({
      instruction: validation.data.instruction,
      reason: validation.data.reason,
    });
    if (requestIdentity.current?.body !== body)
      requestIdentity.current = { body, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/journals/historical-translation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validation.data, idempotencyKey: requestIdentity.current.key }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("proposalFailed")));
      const result = (await response.json()) as { changeId: string };
      if (!isUuid(result.changeId)) throw new Error(t("proposalFailed"));
      requestIdentity.current = null;
      setDirty(false);
      onDirtyChange(false);
      setSelection(`proposal:${result.changeId}`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("proposalFailed"));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  async function apply(changeId: string) {
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/journals/historical-translation/${encodeURIComponent(changeId)}/apply`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("applyFailed")));
      const result = (await response.json()) as { basisId: string };
      if (!isUuid(result.basisId)) throw new Error(t("applyFailed"));
      setSelection(`certificate:${result.basisId}`);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("applyFailed"));
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }
  if (loading)
    return (
      <div aria-busy="true" className="space-y-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  if (!context)
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        {error}
        <Button
          variant="outline"
          onClick={() => {
            setError(null);
            setReload((value) => value + 1);
          }}
        >
          {t("retry")}
        </Button>
      </div>
    );
  const currencies = context.currencies.map((value) => ({ value, label: value }));
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("sourceSummary", { amount: context.source.amount, date: context.source.postingDate })}
      </p>
      <p className="break-all font-mono text-xs text-muted-foreground">{context.source.lineId}</p>
      <SearchSelect
        ariaLabel={t("assessment")}
        value={selection}
        disabled={busy}
        onChange={(value) => {
          void selectAssessment(value);
        }}
        options={[
          { value: "new", label: t("newAssessment") },
          ...context.proposals.map((row) => ({
            value: `proposal:${row.changeId}`,
            label: `${t(`statuses.${row.status}`)} · ${row.evidence.instruction.measurementCurrency} → ${row.evidence.instruction.presentationCurrency}`,
          })),
          ...context.certificates.map((row) => ({
            value: `certificate:${row.basisId}`,
            label: `${t("statuses.applied")} · ${row.evidence.instruction.measurementCurrency} → ${row.evidence.instruction.presentationCurrency}`,
          })),
        ]}
      />
      {error ? (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          {error}{" "}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : null}
      {selection === "new" ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("instructions")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("measurementCurrency")}</Label>
              <SearchSelect
                ariaLabel={t("measurementCurrency")}
                value={measurementCurrency}
                options={currencies}
                disabled={busy}
                onChange={(value) => {
                  markDirty();
                  setMeasurementCurrency(value);
                  if (kind === "correction") setLayers([emptyLayer()]);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("presentationCurrency")}</Label>
              <SearchSelect
                ariaLabel={t("presentationCurrency")}
                value={presentationCurrency}
                options={currencies}
                disabled={busy}
                onChange={(value) => {
                  markDirty();
                  setPresentationCurrency(value);
                  if (kind === "correction") setLayers([emptyLayer()]);
                }}
              />
            </div>
          </div>
          {existingPair ? (
            <p role="alert" className="text-sm text-destructive">
              {t("existingPair")}
            </p>
          ) : null}
          {measurementCurrency && measurementCurrency === presentationCurrency ? (
            <p className="text-sm text-muted-foreground">{t("identityHint")}</p>
          ) : null}
          <div className="space-y-2">
            <Label>{t("kind")}</Label>
            <SearchSelect
              ariaLabel={t("kind")}
              value={kind}
              disabled={busy}
              onChange={changeKind}
              options={[
                ...(!context.source.reversesEntryId
                  ? [{ value: "contribution", label: t("kinds.contribution") }]
                  : []),
                ...(!context.source.reversesEntryId &&
                ["opening", "book_opening", "migration"].includes(context.source.origin)
                  ? [{ value: "opening", label: t("kinds.opening") }]
                  : []),
                { value: "correction", label: t("kinds.correction") },
              ]}
            />
          </div>
          {kind === "opening" ? (
            <p className="text-sm text-muted-foreground">{t("openingHint")}</p>
          ) : null}
          {layers.map((layer, index) => (
            <fieldset key={index} className="space-y-3 rounded-md border p-4" disabled={busy}>
              <legend className="px-1 text-sm font-medium">
                {t("layer", { number: index + 1 })}
              </legend>
              {kind === "correction" ? (
                <div className="space-y-2">
                  <Label>{t("originalLayer")}</Label>
                  <SearchSelect
                    ariaLabel={t("originalLayer")}
                    value={layer.originalLayerId ?? ""}
                    disabled={busy}
                    options={originals
                      .filter(
                        (row) =>
                          row.id === layer.originalLayerId ||
                          !layers.some((other) => other.originalLayerId === row.id),
                      )
                      .map((row) => ({
                        value: row.id,
                        label: t("originalOption", {
                          id: row.id,
                          remaining: row.remainingAmount,
                          date: row.historicalDate,
                        }),
                      }))}
                    onChange={(value) => {
                      const original = originals.find((row) => row.id === value);
                      if (original)
                        updateLayer(index, {
                          rate: original.rate,
                          historicalDate: original.historicalDate,
                          provenance: original.provenance,
                          source: original.source,
                          originalLayerId: original.id,
                        });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">{t("correctionHint")}</p>
                </div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`historical-amount-${sourceLineId}-${index}`}>
                    {t("amount")}
                  </Label>
                  <Input
                    id={`historical-amount-${sourceLineId}-${index}`}
                    value={layer.amount}
                    inputMode="decimal"
                    onChange={(event) => updateLayer(index, { amount: event.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`historical-rate-${sourceLineId}-${index}`}>{t("rate")}</Label>
                  <Input
                    id={`historical-rate-${sourceLineId}-${index}`}
                    value={layer.rate}
                    inputMode="decimal"
                    readOnly={kind === "correction"}
                    onChange={(event) => updateLayer(index, { rate: event.target.value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("rateDirection", {
                      presentation: presentationCurrency || "—",
                      measurement: measurementCurrency || "—",
                    })}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`historical-date-${sourceLineId}-${index}`}>
                    {t("historicalDate")}
                  </Label>
                  <DateField
                    id={`historical-date-${sourceLineId}-${index}`}
                    value={layer.historicalDate}
                    max={context.source.postingDate}
                    readOnly={kind === "correction"}
                    onChange={(value) => updateLayer(index, { historicalDate: value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`historical-provenance-${sourceLineId}-${index}`}>
                    {t("provenance")}
                  </Label>
                  <Input
                    id={`historical-provenance-${sourceLineId}-${index}`}
                    value={layer.provenance}
                    maxLength={2000}
                    readOnly={kind === "correction"}
                    onChange={(event) => updateLayer(index, { provenance: event.target.value })}
                  />
                </div>
              </div>
              {kind === "correction" ? (
                <div className="break-all text-xs text-muted-foreground">
                  {layer.source.fileId}
                  <br />
                  {layer.source.versionId}
                  <br />
                  {layer.source.contentHash}
                </div>
              ) : (
                <CabinetSourceVersionPicker
                  value={layer.source}
                  disabled={busy}
                  onChange={(source) => updateLayer(index, { source })}
                />
              )}
              {kind !== "contribution" && layers.length > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    markDirty();
                    setLayers((current) => current.filter((_, position) => position !== index));
                  }}
                >
                  {t("removeLayer")}
                </Button>
              ) : null}
            </fieldset>
          ))}
          {kind !== "contribution" ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || layers.length >= 200}
              onClick={() => {
                markDirty();
                setLayers((current) => [...current, emptyLayer()]);
              }}
            >
              {t("addLayer")}
            </Button>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor={`historical-reason-${sourceLineId}`}>{t("reason")}</Label>
            <Input
              id={`historical-reason-${sourceLineId}`}
              value={reason}
              maxLength={1000}
              disabled={busy}
              onChange={(event) => {
                markDirty();
                setReason(event.target.value);
              }}
            />
          </div>
          <Button
            type="button"
            disabled={busy || !validation.success || !identityRateValid || existingPair}
            onClick={() => {
              void propose();
            }}
          >
            {t("propose")}
          </Button>
        </div>
      ) : assessment ? (
        <div className="space-y-4">
          <Badge variant="secondary">{t(`statuses.${proposal?.status ?? "applied"}`)}</Badge>
          <p className="text-sm">
            {t(`kinds.${assessment.instruction.kind}`)} ·{" "}
            {assessment.instruction.measurementCurrency} →{" "}
            {assessment.instruction.presentationCurrency}
          </p>
          {proposal ? <p className="text-sm">{proposal.reason}</p> : null}
          <AssessmentEvidence
            evidence={assessment}
            layerIds={certificate?.layers.map((row) => row.id)}
          />
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link
                href={`/accounting/changes?change=${encodeURIComponent(proposal?.changeId ?? certificate!.changeId)}`}
              >
                {t("review")}
              </Link>
            </Button>
            {proposal?.status === "approved" ? (
              <Button
                disabled={busy}
                onClick={() => {
                  void apply(proposal.changeId);
                }}
              >
                {t("apply")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setReload((value) => value + 1)}
            >
              {t("refresh")}
            </Button>
          </div>
          {proposal && proposal.status !== "approved" ? (
            <p className="text-sm text-muted-foreground">{t("reviewHint")}</p>
          ) : null}
        </div>
      ) : (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </div>
  );
}

function AssessmentEvidence({
  evidence,
  layerIds,
}: {
  evidence: HistoricalTranslationEvidence;
  layerIds?: string[];
}) {
  const t = useTranslations("journal.historicalTranslation");
  return (
    <div className="space-y-3">
      {evidence.instruction.layers.map((layer, index) => (
        <div key={index} className="space-y-2 rounded-md border p-4 text-sm">
          <p className="font-medium">{t("layer", { number: index + 1 })}</p>
          {layerIds?.[index] ? (
            <p className="break-all font-mono text-xs">{layerIds[index]}</p>
          ) : null}
          <dl className="grid grid-cols-2 gap-2">
            <dt>{t("amount")}</dt>
            <dd>{layer.amount}</dd>
            <dt>{t("rate")}</dt>
            <dd>{layer.rate}</dd>
            <dt>{t("historicalDate")}</dt>
            <dd>{layer.historicalDate}</dd>
            <dt>{t("provenance")}</dt>
            <dd className="break-words">{layer.provenance}</dd>
            {layer.originalLayerId ? (
              <>
                <dt>{t("originalLayer")}</dt>
                <dd className="break-all font-mono text-xs">{layer.originalLayerId}</dd>
              </>
            ) : null}
            <dt>{t("sourceFile")}</dt>
            <dd className="break-all font-mono text-xs">{layer.source.fileId}</dd>
            <dt>{t("sourceVersion")}</dt>
            <dd className="break-all font-mono text-xs">{layer.source.versionId}</dd>
            <dt>{t("sourceHash")}</dt>
            <dd className="break-all font-mono text-xs">{layer.source.contentHash}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}
