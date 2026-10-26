"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, EmptyState, Label, Select } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { useAppAction } from "@/lib/use-app-action";
import { createMoneyFormatter } from "@/lib/money-format";
import type { ShippingAccountOption } from "../../_fulfillment/types";
import { addExact } from "../_fulfillment/shipping-display";
import { DateField } from "@/components/date-field";

interface CandidateView {
  shipmentId: string;
  handlingUnitId: string;
  handlingUnitCode?: string;
  documentNumber: string;
  customerName: string | null;
  promisedDate: string | null;
  labelCount: number;
}

type PreviewRowView =
  | {
      shipmentId: string;
      handlingUnitId: string;
      handlingUnitCode?: string;
      documentNumber: string;
      ok: true;
      providerRateId: string;
      carrier: string;
      service: string;
      amount: string;
      currency: string;
      deliveryDate: string | null;
    }
  | {
      shipmentId: string;
      handlingUnitId: string;
      handlingUnitCode?: string;
      documentNumber: string | null;
      ok: false;
      code: string;
      message: string;
      remedy?: string;
    };

type SuccessfulPreviewRow = Extract<PreviewRowView, { ok: true }>;

type BuyRowView =
  | {
      shipmentId: string;
      handlingUnitId: string;
      ok: true;
      labelId: string;
      trackingNumber: string | null;
      duplicate: boolean;
    }
  | {
      shipmentId: string;
      handlingUnitId: string;
      ok: false;
      code: string;
      message: string;
      remedy?: string;
    };

type Rule = "cheapest" | "fastest" | "cheapest_by_date";

/**
 * Bulk label buying: draft shipments without a label, a buying rule, a
 * priced preview with every failure named beside its fix, then one buy for
 * the ready rows with a merged PDF for the printer. Preview rates; buying
 * spends carrier money, so the buy step stays behind the shipping grant.
 */
export function BulkBuyClient({
  accounts,
  canBuy,
}: {
  accounts: ShippingAccountOption[];
  canBuy: boolean;
}) {
  const t = useTranslations("fulfillment");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { busy, refusal, execute, refuse } = useAppAction();
  const [activeTab, setActiveTab] = useState<"shipments" | "rates" | "labels">("shipments");
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [accountId, setAccountId] = useState(
    () => accounts.find((account) => account.isDefault)?.id ?? "",
  );
  const [rule, setRule] = useState<Rule>("cheapest");
  const [promisedDate, setPromisedDate] = useState("");
  const [preview, setPreview] = useState<PreviewRowView[] | null>(null);
  const [bought, setBought] = useState<BuyRowView[] | null>(null);
  const [merged, setMerged] = useState<{ pages: number; pdfBase64: string } | null>(null);

  const moneyFor = useCallback(
    (currency: string) => createMoneyFormatter(locale, currency),
    [locale],
  );

  const loadCandidates = useCallback(
    async (keepPurchase = false) => {
      const result = await fetchAction<{ candidates: CandidateView[] }>("/api/shipping/bulk", {
        cache: "no-store",
      });
      if (!result.ok) {
        setCandidatesError(result.error.displayMessage(t("shipping.bulk.fail.candidates")));
        setCandidates([]);
        return;
      }
      setCandidatesError(null);
      setCandidates(result.data.candidates);
      setSelected(new Set(result.data.candidates.map((candidate) => candidate.handlingUnitId)));
      setPreview(null);
      if (!keepPurchase) {
        setBought(null);
        setMerged(null);
        setActiveTab("shipments");
      }
    },
    [t],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCandidates(), 0);
    return () => window.clearTimeout(timer);
  }, [loadCandidates]);

  function invalidatePreview() {
    setPreview(null);
    setBought(null);
    setMerged(null);
    setActiveTab("shipments");
  }

  function toggle(handlingUnitId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(handlingUnitId)) next.delete(handlingUnitId);
      else next.add(handlingUnitId);
      return next;
    });
    setPreview(null);
    setBought(null);
    setMerged(null);
  }

  function toggleAll(ids: string[]) {
    setSelected((current) => {
      const allSelected = ids.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    setPreview(null);
    setBought(null);
    setMerged(null);
  }

  const readyRows = useMemo(
    () => (preview ?? []).filter((row): row is SuccessfulPreviewRow => row.ok),
    [preview],
  );
  const failedRows = useMemo(() => (preview ?? []).filter((row) => !row.ok), [preview]);

  const totals = useMemo(() => {
    const sums = new Map<string, string>();
    for (const row of readyRows) {
      const running = sums.get(row.currency) ?? "0";
      const next = addExact(running, row.amount);
      if (next !== null) sums.set(row.currency, next);
    }
    return [...sums.entries()];
  }, [readyRows]);

  async function previewRates() {
    if (selected.size === 0) {
      refuse(null, t("shipping.bulk.fail.nothingSelected"));
      return;
    }
    if (rule === "cheapest_by_date" && !promisedDate) {
      refuse(null, t("shipping.bulk.fail.dateRequired"));
      return;
    }
    setBought(null);
    setMerged(null);
    await execute(
      () =>
        fetchAction<{ rows: PreviewRowView[] }>("/api/shipping/bulk", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            items: (candidates ?? [])
              .filter((candidate) => selected.has(candidate.handlingUnitId))
              .map((candidate) => ({
                shipmentId: candidate.shipmentId,
                handlingUnitId: candidate.handlingUnitId,
              })),
            ...(accountId ? { accountId } : {}),
            rule,
            ...(rule === "cheapest_by_date" ? { promisedDate } : {}),
          }),
        }),
      {
        fallbackMessage: t("shipping.bulk.fail.preview"),
        onOk: (result) => {
          setPreview(result.rows);
          setActiveTab("rates");
        },
      },
    );
  }

  async function buyReady() {
    if (!canBuy || readyRows.length === 0) return;
    await execute(
      () =>
        fetchAction<{ rows: BuyRowView[]; merged: { pages: number; pdfBase64: string } | null }>(
          "/api/shipping/bulk/buy",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(accountId ? { accountId } : {}),
              items: readyRows
                .filter((row) => row.ok)
                .map((row) => ({
                  shipmentId: row.shipmentId,
                  handlingUnitId: row.handlingUnitId,
                  providerRateId: row.providerRateId,
                })),
            }),
          },
        ),
      {
        fallbackMessage: t("shipping.bulk.fail.buy"),
        successMessage: t("shipping.bulk.bought"),
        onOk: (result) => {
          setBought(result.rows);
          setMerged(result.merged);
          setActiveTab("labels");
          void loadCandidates(true);
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <ActionAlert error={refusal} fallbackMessage={t("actionFailed")} />
      {candidatesError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <p>{candidatesError}</p>
          <Button variant="outline" disabled={busy} onClick={() => void loadCandidates(true)}>
            {tCommon("actions.retry")}
          </Button>
        </div>
      ) : null}

      <RecordTabs
        label={t("shipping.bulk.preview")}
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: "shipments", label: t("shipping.bulk.tabs.shipments") },
          { key: "rates", label: t("shipping.bulk.tabs.rates"), disabled: preview === null },
          { key: "labels", label: t("shipping.bulk.tabs.labels"), disabled: bought === null },
        ]}
      >
        {activeTab === "shipments" ? (
          <>
            {candidatesError ? null : candidates === null ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("shipping.bulk.loading")}
              </p>
            ) : candidates.length === 0 ? (
              <EmptyState
                title={t("shipping.bulk.emptyTitle")}
                description={t("shipping.bulk.emptyDescription")}
                action={
                  <Button asChild>
                    <Link href="/shipments">{t("shipping.bulk.backToShipments")}</Link>
                  </Button>
                }
              />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-account">{t("shipping.rateAccount")}</Label>
                    <Select
                      id="bulk-account"
                      value={accountId}
                      onChange={(event) => {
                        setAccountId(event.target.value);
                        invalidatePreview();
                      }}
                    >
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name} · {account.provider === "shippo" ? "Shippo" : "EasyPost"}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bulk-rule">{t("shipping.bulk.rule")}</Label>
                    <Select
                      id="bulk-rule"
                      value={rule}
                      onChange={(event) => {
                        setRule(event.target.value as Rule);
                        invalidatePreview();
                      }}
                    >
                      <option value="cheapest">{t("shipping.bulk.rules.cheapest")}</option>
                      <option value="fastest">{t("shipping.bulk.rules.fastest")}</option>
                      <option value="cheapest_by_date">
                        {t("shipping.bulk.rules.cheapest_by_date")}
                      </option>
                    </Select>
                  </div>
                  {rule === "cheapest_by_date" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="bulk-date">{t("shipping.bulk.promisedDate")}</Label>
                      <DateField
                        id="bulk-date"
                        value={promisedDate}
                        onChange={(value) => {
                          setPromisedDate(value);
                          invalidatePreview();
                        }}
                      />
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2">
                    <Button
                      disabled={busy || selected.size === 0}
                      onClick={() => void previewRates()}
                    >
                      {t("shipping.bulk.preview")}
                    </Button>
                  </div>
                </div>

                <PagedTable
                  source="shipping_bulk_candidates"
                  rows={candidates}
                  rowKey={(candidate) => candidate.handlingUnitId}
                  rowLabel={(candidate) =>
                    `${candidate.documentNumber} ${candidate.customerName ?? ""}`
                  }
                  searchable
                  empty={t("shipping.bulk.emptyTitle")}
                  columns={[
                    {
                      key: "shipment",
                      header: t("shipping.bulk.colShipment"),
                      search: (candidate) =>
                        `${candidate.documentNumber} ${candidate.handlingUnitCode ?? ""}`,
                      cell: (candidate) => (
                        <span className="font-mono">
                          {candidate.documentNumber} · {candidate.handlingUnitCode ?? ""}
                        </span>
                      ),
                    },
                    {
                      key: "customer",
                      header: t("shipping.bulk.colCustomer"),
                      search: (candidate) => candidate.customerName ?? "",
                      cell: (candidate) => candidate.customerName ?? "—",
                    },
                    {
                      key: "promised",
                      header: t("shipping.bulk.colPromised"),
                      search: (candidate) => candidate.promisedDate ?? "",
                      cell: (candidate) => candidate.promisedDate ?? "—",
                    },
                  ]}
                  selection={{
                    getId: (candidate) => candidate.handlingUnitId,
                    selectedIds: selected,
                    onToggle: toggle,
                    onToggleAll: toggleAll,
                    disabled: busy,
                  }}
                />
              </>
            )}
          </>
        ) : null}
        {activeTab === "rates" && preview ? (
          <section aria-label={t("shipping.bulk.previewTitle")} className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t("shipping.bulk.previewTitle", {
                ready: readyRows.length,
                failed: failedRows.length,
              })}
            </h3>
            {totals.length > 0 ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {t("shipping.bulk.totalLabel")}{" "}
                {totals
                  .map(([currency, total]) => moneyFor(currency).money(total, { currency }))
                  .join(" · ")}
              </p>
            ) : null}
            {readyRows.length > 0 ? (
              <PagedTable
                source="shipping_bulk_rates"
                rows={readyRows}
                rowKey={(row) => row.handlingUnitId}
                rowLabel={(row) => `${row.documentNumber} ${row.carrier} ${row.service}`}
                searchable
                empty={t("shipping.bulk.emptyTitle")}
                columns={[
                  {
                    key: "shipment",
                    header: t("shipping.bulk.colShipment"),
                    search: (row) => row.documentNumber,
                    cell: (row) => <span className="font-mono">{row.documentNumber}</span>,
                  },
                  {
                    key: "rate",
                    header: t("shipping.colRate"),
                    search: (row) => `${row.carrier} ${row.service}`,
                    cell: (row) => `${row.carrier} · ${row.service}`,
                  },
                  {
                    key: "delivery",
                    header: t("shipping.colDelivery"),
                    search: (row) => row.deliveryDate ?? "",
                    cell: (row) => row.deliveryDate ?? "—",
                  },
                  {
                    key: "price",
                    header: t("shipping.colPrice"),
                    align: "right",
                    cell: (row) => (
                      <span className="font-medium tabular-nums">
                        {moneyFor(row.currency).money(row.amount, { currency: row.currency })}
                      </span>
                    ),
                  },
                ]}
              />
            ) : null}
            {failedRows.length > 0 ? (
              <ul className="space-y-2">
                {failedRows.map((row) =>
                  !row.ok ? (
                    <li
                      key={row.handlingUnitId}
                      className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                    >
                      <span className="font-medium">{row.documentNumber ?? row.shipmentId}</span>
                      {" — "}
                      {row.message}
                      {row.remedy ? <> {row.remedy}</> : null}{" "}
                      <Link
                        href={`/shipments?shipment=${encodeURIComponent(row.shipmentId)}`}
                        className="font-medium underline"
                      >
                        {t("shipping.bulk.openShipment")}
                      </Link>
                    </li>
                  ) : null,
                )}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={!canBuy || busy || readyRows.length === 0}
                onClick={() => void buyReady()}
              >
                {t("shipping.bulk.buy")}
              </Button>
              {!canBuy ? (
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {t("shipping.noBuyGrant")}
                </span>
              ) : null}
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("shipping.costNote")}</p>
          </section>
        ) : null}

        {activeTab === "labels" && bought ? (
          <section aria-label={t("shipping.bulk.resultTitle")} className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t("shipping.bulk.resultTitle")}
            </h3>
            {merged ? (
              <Button asChild>
                <a
                  href={`data:application/pdf;base64,${merged.pdfBase64}`}
                  download="shipping-labels.pdf"
                >
                  {t("shipping.bulk.printMerged")}
                </a>
              </Button>
            ) : null}
            <ul className="space-y-2">
              {bought.map((row) =>
                row.ok ? (
                  <li
                    key={row.handlingUnitId}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                  >
                    <Badge variant="success">{t("shipping.bulk.boughtOne")}</Badge>
                    <span className="font-mono">{row.trackingNumber ?? row.labelId}</span>
                    {row.duplicate ? <span>{t("shipping.bulk.duplicate")}</span> : null}
                  </li>
                ) : (
                  <li
                    key={row.handlingUnitId}
                    className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                  >
                    <span className="font-mono">{row.shipmentId}</span>
                    {" — "}
                    {row.message}
                    {row.remedy ? <> {row.remedy}</> : null}
                  </li>
                ),
              )}
            </ul>
          </section>
        ) : null}
      </RecordTabs>
    </div>
  );
}
