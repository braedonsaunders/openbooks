"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { Button, Card, Input, Label, PageHeader, Select } from "@openbooks/ui";
import { useMoney } from "../../../../components/money-provider";
import { useBusinessToday } from "../../../../components/business-date-provider";
import {
  ListPageLayout,
  PageContainer,
} from "../../../../components/page-layout";

const SETTLEMENT_PROVIDERS = ["stripe", "adyen", "gocardless", "recurly", "chargebee"] as const;
const SETTLEMENT_STATUSES = ["draft", "posted", "void"] as const;

type SettlementProvider = (typeof SETTLEMENT_PROVIDERS)[number];
type ImportProvider = Extract<SettlementProvider, "stripe" | "recurly" | "chargebee">;
type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

interface SettlementBatch {
  id: string;
  provider: SettlementProvider;
  externalRef: string;
  settlementDate: string;
  currency: string;
  netAmount: string;
  status: SettlementStatus;
}

const STATUS_MESSAGE: Record<SettlementStatus, "draft" | "posted" | "voided"> = {
  draft: "draft",
  posted: "posted",
  void: "voided",
};

function isSettlementBatch(value: unknown): value is SettlementBatch {
  if (!value || typeof value !== "object") return false;
  const batch = value as Record<string, unknown>;
  return typeof batch.id === "string"
    && SETTLEMENT_PROVIDERS.includes(batch.provider as SettlementProvider)
    && typeof batch.externalRef === "string"
    && typeof batch.settlementDate === "string"
    && typeof batch.currency === "string"
    && typeof batch.netAmount === "string"
    && SETTLEMENT_STATUSES.includes(batch.status as SettlementStatus);
}

async function fetchSettlements(signal?: AbortSignal): Promise<SettlementBatch[] | null> {
  try {
    const response = await fetch("/api/psp/settlements", { signal });
    if (!response.ok) return null;
    const data = await response.json() as { batches?: unknown };
    if (!Array.isArray(data.batches) || !data.batches.every(isSettlementBatch)) return null;
    return data.batches;
  } catch {
    return null;
  }
}

async function requestSettlement<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const response = await fetch("/api/psp/settlements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return null;
    return await response.json() as T;
  } catch {
    return null;
  }
}

/**
 * Minimal PSP settlement import UI — paste Stripe/Recurly/Chargebee JSON
 * and post the balanced kernel journal for fees/disputes/FX/net deposit.
 */
export default function PspSettlementsPage() {
  const t = useTranslations("banking.pspSettlements");
  const common = useTranslations("common");
  const format = useFormatter();
  const { money } = useMoney();
  const today = useBusinessToday();
  const [batches, setBatches] = useState<SettlementBatch[]>([]);
  const [provider, setProvider] = useState<ImportProvider>("stripe");
  const [externalRef, setExternalRef] = useState("");
  const [settlementDate, setSettlementDate] = useState(today);
  const [payload, setPayload] = useState("[]");
  const [bankAccountId, setBankAccountId] = useState("");
  const [feeAccountId, setFeeAccountId] = useState("");
  const [clearingAccountId, setClearingAccountId] = useState("");
  const [reversalDate, setReversalDate] = useState(today);
  const [reversalReason, setReversalReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    const loadedBatches = await fetchSettlements();
    if (loadedBatches === null) {
      setLoadFailed(true);
    } else {
      setBatches(loadedBatches);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetchSettlements(controller.signal).then((loadedBatches) => {
      if (controller.signal.aborted) return;
      if (loadedBatches === null) {
        setLoadFailed(true);
      } else {
        setBatches(loadedBatches);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const importBatch = async () => {
    setErr(null);
    setMsg(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      setErr(t("invalidJson"));
      return;
    }
    const body: Record<string, unknown> = {
      action: "import",
      provider,
      externalRef,
      settlementDate,
      bankAccountId: bankAccountId || undefined,
      feeAccountId: feeAccountId || undefined,
      clearingAccountId: clearingAccountId || undefined,
    };
    if (provider === "stripe") {
      body.transactions = parsed;
      body.payoutId = externalRef;
    } else {
      body.payload = parsed;
    }
    const d = await requestSettlement<{ batchId?: string }>(body);
    if (!d || typeof d.batchId !== "string") {
      setErr(t("importFailed"));
      return;
    }
    setMsg(t("importedToast", { id: d.batchId }));
    void load();
  };

  const post = async (batchId: string) => {
    setErr(null);
    const d = await requestSettlement<{ entryId?: string }>({ action: "post", batchId });
    if (!d || typeof d.entryId !== "string") {
      setErr(t("postFailed"));
      return;
    }
    setMsg(t("postedToast", { id: d.entryId }));
    void load();
  };

  const reverse = async (batchId: string) => {
    setErr(null);
    if (reversalReason.trim().length < 5) {
      setErr(t("reasonTooShort"));
      return;
    }
    const d = await requestSettlement<{ entryId?: string }>({
      action: "reverse",
      batchId,
      reversalDate,
      reason: reversalReason,
    });
    if (!d || typeof d.entryId !== "string") {
      setErr(t("reversalFailed"));
      return;
    }
    setMsg(t("reversedToast", { id: d.entryId }));
    setReversalReason("");
    void load();
  };

  const settlementDateLabel = (value: string) => format.dateTime(
    new Date(`${value}T12:00:00Z`),
    { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
  );
  const providerLabel = (value: SettlementProvider) => t(`providers.${value}`);
  const statusLabel = (value: SettlementStatus) => common(`status.${STATUS_MESSAGE[value]}`);

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("description")}
        />
      }
    >
      <PageContainer className="space-y-6">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("acceptanceNote")}{" "}
          <Link
            href="/admin/setup/payment-providers"
            className="text-teal-700 hover:underline dark:text-teal-300"
          >
            {t("acceptanceLink")}
          </Link>
        </p>
        {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
        {msg && (
          <p aria-live="polite" className="text-sm text-teal-700 dark:text-teal-300">{msg}</p>
        )}

        <Card className="space-y-3 p-4">
          <h3 className="text-sm font-semibold">{t("importTitle")}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label>{t('providerLabel')}</Label>
              <Select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ImportProvider)}
              >
                <option value="stripe">{t("providers.stripe")}</option>
                <option value="recurly">{t("providers.recurly")}</option>
                <option value="chargebee">{t("providers.chargebee")}</option>
              </Select>
            </div>
            <div>
              <Label>{t('externalRef')}</Label>
              <Input
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('settlementDate')}</Label>
              <Input
                type="date"
                value={settlementDate}
                onChange={(e) => setSettlementDate(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('bankAccountId')}</Label>
              <Input
                value={bankAccountId}
                onChange={(e) => setBankAccountId(e.target.value)}
                placeholder={t("uuidPlaceholder")}
              />
            </div>
            <div>
              <Label>{t('feeAccountId')}</Label>
              <Input
                value={feeAccountId}
                onChange={(e) => setFeeAccountId(e.target.value)}
                placeholder={t("uuidPlaceholder")}
              />
            </div>
            <div>
              <Label>{t('clearingAccountId')}</Label>
              <Input
                value={clearingAccountId}
                onChange={(e) => setClearingAccountId(e.target.value)}
                placeholder={t("uuidPlaceholder")}
              />
            </div>
          </div>
          <div>
            <Label>
              {provider === "stripe"
                ? t("stripePayloadLabel")
                : t("genericPayloadLabel")}
            </Label>
            <textarea
              className="mt-1 min-h-32 w-full rounded border p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={!externalRef}
            onClick={() => void importBatch()}
          >
            {t("importDraft")}
          </Button>
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold">{t("recentBatches")}</h3>
          <div className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div>
              <Label>{t('reversalDate')}</Label>
              <Input
                type="date"
                value={reversalDate}
                onChange={(e) => setReversalDate(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('reversalReason')}</Label>
              <Input
                value={reversalReason}
                onChange={(e) => setReversalReason(e.target.value)}
                placeholder={t("reversalPlaceholder")}
                maxLength={500}
              />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1">{t("colProvider")}</th>
                <th>{common("labels.reference")}</th>
                <th>{common("labels.date")}</th>
                <th className="text-right">{t("colNet")}</th>
                <th>{common("labels.status")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {!loading && !loadFailed && batches.map((b) => (
                <tr key={b.id} className="border-t">
                  <td className="py-1">{providerLabel(b.provider)}</td>
                  <td className="font-mono text-xs">{b.externalRef}</td>
                  <td>{settlementDateLabel(b.settlementDate)}</td>
                  <td className="text-right tabular-nums">{money(b.netAmount, { currency: b.currency })}</td>
                  <td>{statusLabel(b.status)}</td>
                  <td className="text-right">
                    {b.status === "draft" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void post(b.id)}
                      >
                        {common("actions.post")}
                      </Button>
                    )}
                    {b.status === "posted" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={reversalReason.trim().length < 5}
                        onClick={() => void reverse(b.id)}
                      >
                        {t("reverse")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {loading && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground">
                    {common("feedback.loading")}
                  </td>
                </tr>
              )}
              {!loading && loadFailed && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-muted-foreground">
                    <p>{common("feedback.loadFailed")}</p>
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
                      {common("actions.retry")}
                    </Button>
                  </td>
                </tr>
              )}
              {!loading && !loadFailed && batches.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="py-4 text-center text-muted-foreground"
                  >
                    {t('empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </PageContainer>
    </ListPageLayout>
  );
}
