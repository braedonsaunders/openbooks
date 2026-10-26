"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Badge, Button, Drawer, Input, Textarea } from "@openbooks/ui";
import { PencilLine, RefreshCw } from "lucide-react";
import { readApiErrorMessage } from "../../../lib/api-error";

/** One exposure row from the revaluation engine's selected-entity read model. */
type Exposure = {
  subsidiaryId: string;
  subsidiaryName: string;
  accountId: string;
  accountNumber: string | null;
  accountName: string;
  currency: string;
  measurementCurrency: string;
  rateDate: string;
  carryingBase: string;
  foreignBalance: string;
  periodEndRate: string | null;
  rateRefusal: string | null;
  rateEvidence: {
    id: string;
    version: number;
    rate: string;
    source: string;
    reason: string;
    rateDate: string;
    measurementCurrency: string;
  } | null;
};

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; exposures: Exposure[] };

const exposureKey = (row: Exposure) => [row.subsidiaryId, row.accountId, row.currency].join(":");

/**
 * Recorded closing rates for the close run's own FX exposures. The list is
 * the revaluation engine's position population for this book, period and
 * selected legal entities; recording a rate opens the selected exposure and
 * appends its quote (or a successor) — nothing here posts, and no rate is
 * ever written to the organization's exchange rates.
 */
export function RevaluationEvidencePanel(props: {
  periodId: string;
  bookId: string;
  subsidiaryIds: string[];
  canRun: boolean;
}) {
  const t = useTranslations("close.revaluationEvidence");
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [rate, setRate] = useState("");
  const [source, setSource] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const subsidiaryKey = props.subsidiaryIds.join(",");
  const loadKey = JSON.stringify([props.periodId, props.bookId, subsidiaryKey, attempt]);
  const state: LoadState = loaded?.key === loadKey ? loaded.state : { status: "loading" };
  const load = useCallback(async () => {
    const params = new URLSearchParams({ periodId: props.periodId, bookId: props.bookId });
    if (subsidiaryKey) params.set("subsidiaryIds", subsidiaryKey);
    const response = await fetch(`/api/close/revaluation-rate-evidence?${params.toString()}`);
    if (!response.ok) throw new Error(await readApiErrorMessage(response, t("loadFailed")));
    const body = (await response.json()) as { exposures: Exposure[] };
    return body.exposures;
  }, [props.periodId, props.bookId, subsidiaryKey, t]);

  useEffect(() => {
    let live = true;
    load()
      .then((exposures) => {
        if (live) setLoaded({ key: loadKey, state: { status: "ready", exposures } });
      })
      .catch((error: unknown) => {
        if (live) {
          setLoaded({
            key: loadKey,
            state: {
              status: "failed",
              message: error instanceof Error ? error.message : t("loadFailed"),
            },
          });
        }
      });
    return () => {
      live = false;
    };
  }, [load, loadKey, t]);

  const exposures = state.status === "ready" ? state.exposures : [];
  const selected = exposures.find((row) => exposureKey(row) === selectedKey) ?? null;

  function openRecorder(row: Exposure) {
    setSelectedKey(exposureKey(row));
    setRate(row.rateEvidence?.rate ?? "");
    setSource("");
    setReason("");
  }

  async function record() {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await fetch("/api/close/revaluation-rate-evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: props.bookId,
          subsidiaryId: selected.subsidiaryId,
          periodId: props.periodId,
          accountId: selected.accountId,
          transactionCurrency: selected.currency,
          measurementCurrency: selected.measurementCurrency,
          rateDate: selected.rateDate,
          rate,
          source,
          reason,
          expectedCurrentId: selected.rateEvidence?.id ?? null,
          requestId: crypto.randomUUID(),
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("recordFailed")));
      toast.success(t("recorded"));
      setSelectedKey(null);
      setAttempt((value) => value + 1);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("recordFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t("title")}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={state.status === "loading"}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <RefreshCw size={13} />
          {t("reload")}
        </Button>
      </div>
      {state.status === "loading" ? (
        <p className="text-sm text-slate-500">{t("loading")}</p>
      ) : state.status === "failed" ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {state.message}
        </p>
      ) : exposures.length === 0 ? (
        <p className="text-sm text-slate-500">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {exposures.map((row) => (
            <li key={exposureKey(row)} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {row.accountNumber ? `${row.accountNumber} · ` : ""}
                  {row.accountName}
                  <span className="text-slate-500"> — {row.subsidiaryName}</span>
                </p>
                <p className="text-xs text-slate-500">
                  {t("position", {
                    foreign: `${row.foreignBalance} ${row.currency}`,
                    carrying: `${row.carryingBase} ${row.measurementCurrency}`,
                    date: row.rateDate,
                  })}
                </p>
                {row.rateRefusal ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{row.rateRefusal}</p>
                ) : null}
              </div>
              {row.rateEvidence ? (
                <Badge variant="outline">
                  {t("recordedRate", {
                    rate: row.rateEvidence.rate,
                    version: row.rateEvidence.version,
                  })}
                </Badge>
              ) : row.periodEndRate ? (
                <Badge variant="outline">
                  {t("organizationRate", { rate: row.periodEndRate })}
                </Badge>
              ) : (
                <Badge variant="warning">{t("rateMissing")}</Badge>
              )}
              {props.canRun ? (
                <Button size="sm" variant="outline" onClick={() => openRecorder(row)}>
                  <PencilLine size={13} />
                  {row.rateEvidence ? t("recordSuccessor") : t("recordRate")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Drawer
        open={selected !== null}
        onClose={() => setSelectedKey(null)}
        title={t("drawerTitle")}
        description={
          selected
            ? t("position", {
                foreign: `${selected.foreignBalance} ${selected.currency}`,
                carrying: `${selected.carryingBase} ${selected.measurementCurrency}`,
                date: selected.rateDate,
              })
            : undefined
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => setSelectedKey(null)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !rate.trim() || !source.trim() || reason.trim().length < 8}
              onClick={record}
            >
              {t("recordRate")}
            </Button>
          </div>
        }
      >
        {selected ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-slate-500">{t("legalEntity")}</dt>
                <dd className="font-medium">{selected.subsidiaryName}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("account")}</dt>
                <dd className="font-medium">
                  {selected.accountNumber ? `${selected.accountNumber} · ` : ""}
                  {selected.accountName}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("conversion")}</dt>
                <dd className="font-medium">
                  {selected.currency} → {selected.measurementCurrency}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("rateDate")}</dt>
                <dd className="font-medium">{selected.rateDate}</dd>
              </div>
            </dl>
            {selected.rateEvidence ? (
              <p className="rounded-md border border-slate-200 p-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-300">
                {t("currentQuote", {
                  rate: selected.rateEvidence.rate,
                  version: selected.rateEvidence.version,
                  source: selected.rateEvidence.source,
                })}
              </p>
            ) : null}
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("rate")}</span>
              <Input
                value={rate}
                onChange={(event) => setRate(event.target.value)}
                inputMode="decimal"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("source")}</span>
              <Input
                value={source}
                onChange={(event) => setSource(event.target.value)}
                maxLength={120}
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">{t("reason")}</span>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                rows={3}
              />
            </label>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
