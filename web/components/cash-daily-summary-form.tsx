"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, FieldLabel, Input, SearchSelect, Select } from "@openbooks/ui";
import {
  CashTendersSection,
  parseTenderDrafts,
  type CloseoutDraft,
  type TenderDraft,
} from "./cash-tenders-section";
import { normalizeMoney, sum } from "@openbooks/engine/money/money";
import { DateField } from "./date-field";

export interface DailySummaryOption {
  value: string;
  label: string;
}

interface SummaryLine {
  accountId: string;
  description: string;
  amount: string;
  quantity: string;
  taxCodeId: string;
}

const blankLine = (): SummaryLine => ({
  accountId: "",
  description: "",
  amount: "",
  quantity: "",
  taxCodeId: "",
});

/**
 * One-form daily close: the date, one row per category/tax-code total, the
 * tenders with tips and fees, and the over/short. Submits to the
 * daily-summary endpoint, which creates the cash sale as a draft through
 * the native document path (per-line tax from the named codes); the
 * cashier reviews and posts it from the drawer.
 */
export function CashDailySummaryForm({
  currency,
  defaultDate,
  accounts,
  taxCodes,
  tenderAccounts,
  defaultTenderAccountId,
  serverOptions,
  subsidiaries,
  defaultSubsidiaryId,
}: {
  currency: string;
  defaultDate: string;
  accounts: DailySummaryOption[];
  taxCodes: DailySummaryOption[];
  tenderAccounts: DailySummaryOption[];
  defaultTenderAccountId: string | null;
  serverOptions: DailySummaryOption[];
  subsidiaries: DailySummaryOption[] | null;
  defaultSubsidiaryId: string | null;
}) {
  const t = useTranslations("ar");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [date, setDate] = useState(defaultDate);
  const [subsidiaryId, setSubsidiaryId] = useState(defaultSubsidiaryId ?? "");
  const [lines, setLines] = useState<SummaryLine[]>([blankLine()]);
  const [tenders, setTenders] = useState<TenderDraft[]>([
    { kind: "cash", accountId: defaultTenderAccountId ?? "", amount: "" },
  ]);
  const [closeout, setCloseout] = useState<CloseoutDraft>({ overShort: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Exact decimal total of the entered lines. An amount that is not a decimal
  // leaves the total unknown (empty) rather than reading as zero; the save
  // refuses that line by name.
  const total = useMemo(() => {
    const amounts = lines.map((line) => line.amount.trim()).filter((amount) => amount !== "");
    try {
      return sum(amounts.map((amount) => normalizeMoney(amount)));
    } catch {
      return "";
    }
  }, [lines]);

  const updateLine = (index: number, patch: Partial<SummaryLine>) => {
    setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/cash-sales/daily-summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date,
          ...(subsidiaryId ? { subsidiaryId } : {}),
          lines: lines
            .filter((line) => line.accountId !== "" || line.amount.trim() !== "")
            .map((line) => ({
              accountId: line.accountId,
              amount: line.amount,
              ...(line.description.trim() !== "" ? { description: line.description.trim() } : {}),
              ...(line.quantity.trim() !== "" ? { quantity: line.quantity.trim() } : {}),
              ...(line.taxCodeId !== "" ? { taxCodeId: line.taxCodeId } : {}),
            })),
          tenders: parseTenderDrafts(tenders),
          ...(closeout.overShort.trim() !== "" || closeout.serverPartyId
            ? {
                closeout: {
                  ...(closeout.overShort.trim() !== ""
                    ? { overShort: closeout.overShort.trim() }
                    : {}),
                  ...(closeout.serverPartyId ? { serverPartyId: closeout.serverPartyId } : {}),
                },
              }
            : {}),
        }),
      });
      const json = (await response.json().catch(() => null)) as {
        id?: string;
        error?: string;
      } | null;
      if (!response.ok || !json?.id) {
        setError(
          typeof json?.error === "string" && json.error !== ""
            ? json.error
            : t("dailySummary.createFailed"),
        );
        return;
      }
      router.push(`/cash-sales?doc=${json.id}`);
    } catch {
      setError(t("dailySummary.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[160px_1fr] items-end gap-2">
        <div>
          <FieldLabel fieldName={t("dailySummary.date")}>{t("dailySummary.date")}</FieldLabel>
          <DateField value={date} onChange={(value) => setDate(value)} />
        </div>
        {subsidiaries ? (
          <div>
            <FieldLabel fieldName="subsidiary">{tCommon("labels.subsidiary")}</FieldLabel>
            <SearchSelect
              options={subsidiaries}
              value={subsidiaryId}
              onChange={(v) => setSubsidiaryId(v ?? "")}
            />
          </div>
        ) : null}
      </div>
      <div className="space-y-1">
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid grid-cols-[1fr_1fr_110px_80px_130px_auto] items-end gap-2"
          >
            <div>
              <FieldLabel fieldName={t("drawer.accountColumn")}>
                {t("drawer.accountColumn")}
              </FieldLabel>
              <SearchSelect
                options={accounts}
                value={line.accountId}
                onChange={(v) => updateLine(index, { accountId: v ?? "" })}
              />
            </div>
            <div>
              <FieldLabel fieldName={t("dailySummary.description")}>
                {t("dailySummary.description")}
              </FieldLabel>
              <Input
                value={line.description}
                onChange={(e) => updateLine(index, { description: e.target.value })}
              />
            </div>
            <div>
              <FieldLabel fieldName={t("tenders.amount")}>{t("tenders.amount")}</FieldLabel>
              <Input
                inputMode="decimal"
                value={line.amount}
                onChange={(e) => updateLine(index, { amount: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div>
              <FieldLabel fieldName={t("dailySummary.quantity")}>
                {t("dailySummary.quantity")}
              </FieldLabel>
              <Input
                inputMode="decimal"
                value={line.quantity}
                onChange={(e) => updateLine(index, { quantity: e.target.value })}
                placeholder="1"
              />
            </div>
            <div>
              <FieldLabel fieldName={t("dailySummary.tax")}>{t("dailySummary.tax")}</FieldLabel>
              <Select
                value={line.taxCodeId}
                onChange={(e) => updateLine(index, { taxCodeId: e.target.value })}
              >
                <option value="">{t("drawer.noTax")}</option>
                {taxCodes.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))}
            >
              {t("tenders.remove")}
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLines((rows) => [...rows, blankLine()])}
          >
            {t("dailySummary.addLine")}
          </Button>
        </div>
      </div>
      <CashTendersSection
        value={tenders}
        onChange={setTenders}
        editable
        total={total}
        currency={currency}
        accountOptions={tenderAccounts}
        defaultAccountId={defaultTenderAccountId}
        storedValueEnabled={false}
        closeoutValue={closeout}
        onCloseoutChange={setCloseout}
        serverOptions={serverOptions}
      />
      {error ? <p className="text-sm text-red-700 dark:text-red-300">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button type="button" disabled={busy} onClick={() => void submit()}>
          {t("actions.newCashSale")}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push("/cash-sales")}>
          {t("dailySummary.back")}
        </Button>
      </div>
    </div>
  );
}
