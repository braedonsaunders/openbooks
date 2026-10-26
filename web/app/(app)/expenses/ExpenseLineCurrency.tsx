"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Input, Label, Select } from "@openbooks/ui";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";
import { SUPPORTED_CURRENCIES } from "@openbooks/engine/fx/currencies";
import { isIsoCalendarDate } from "@openbooks/engine/platform/iso-date";
import {
  convertExpenseAtRate,
  convertExpenseFromBilled,
  currencyMinorUnits,
  expenseFxRate,
  type ExpenseFxMethod,
} from "@openbooks/engine/payables/expense-line-currency";
import { useMoney } from "../../../components/money-provider";
import { MoneyInput } from "../../../components/money-input";
import { DateField } from "../../../components/date-field";

/** How a foreign-currency expense line converts, as the operator states it. */
export interface ForeignLineState {
  currency: string;
  rateDate: string;
  method: ExpenseFxMethod;
  /** The operator's rate for an explicit-rate line. */
  rate: string;
  reason: string;
  /** The report-currency amount the statement billed. */
  billedAmount: string;
  /** The dated rate the preview showed; the save refuses if it has changed. */
  quotedRate: string | null;
}

/** The original amounts a foreign line converts, in canonical form (or null while invalid). */
export interface ForeignOriginal {
  amount: string | null;
  taxAmount: string | null;
}

/** The converted report-currency amounts a valid foreign line saves. */
export interface ForeignConversion {
  amount: string;
  taxAmount: string | null;
  rate: string;
}

type Quote = {
  rate: string;
  rateType: string;
  observationDate: string;
  source: string;
};

type QuotePayload = {
  reportCurrency: string;
  minorUnits: number | null;
  allowRateOverride: boolean;
  quote: Quote | null;
  refusal: { error: string; code: string; remedy: string } | null;
};

export function blankForeignLine(currency: string, rateDate: string): ForeignLineState {
  return {
    currency,
    rateDate,
    method: "rate_table",
    rate: "",
    reason: "",
    billedAmount: "",
    quotedRate: null,
  };
}

/** The foreign-currency statement a line saves with; the server converts it again. */
export function foreignLinePayload(state: ForeignLineState, original: ForeignOriginal) {
  return {
    currency: state.currency,
    amount: original.amount,
    taxAmount: original.taxAmount,
    rateDate: state.rateDate,
    method: state.method,
    rate:
      state.method === "override"
        ? state.rate.trim()
        : state.method === "rate_table"
          ? state.quotedRate
          : null,
    reason: state.method === "override" ? state.reason.trim() : null,
    billedAmount: state.method === "billed_amount" ? state.billedAmount.trim() : null,
  };
}

/**
 * The report-currency amounts a foreign line converts to under its stated
 * method, or null while something it needs is missing. The same pure
 * conversion the server applies, so the preview is the saved figure.
 */
export function convertForeignLine(
  state: ForeignLineState,
  original: ForeignOriginal,
  reportCurrency: string,
): ForeignConversion | null {
  const minorUnits = currencyMinorUnits(reportCurrency);
  if (minorUnits === null || original.amount === null) return null;
  if (state.method === "billed_amount") {
    const billed = canonicalDecimal(state.billedAmount.trim(), 4);
    if (billed === null) return null;
    return convertExpenseFromBilled({
      amount: original.amount,
      taxAmount: original.taxAmount,
      billedAmount: billed,
      minorUnits,
    });
  }
  const rate = state.method === "override" ? expenseFxRate(state.rate.trim()) : state.quotedRate;
  if (rate === null || rate === undefined || rate === "") return null;
  return {
    ...convertExpenseAtRate({
      amount: original.amount,
      taxAmount: original.taxAmount,
      rate,
      minorUnits,
    }),
    rate,
  };
}

/** Whether a foreign line states everything its method needs. */
export function foreignLineReady(
  state: ForeignLineState,
  original: ForeignOriginal,
  reportCurrency: string,
): boolean {
  if (!isIsoCalendarDate(state.rateDate) || state.currency === reportCurrency) return false;
  if (
    state.method === "override" &&
    (state.reason.trim().length < 8 || state.reason.trim().length > 500)
  )
    return false;
  return convertForeignLine(state, original, reportCurrency) !== null;
}

/**
 * Conversion controls for one foreign-currency expense line: the currency
 * and expense date, how the amount converts (the dated exchange rate, the
 * amount billed in the report currency, or an explicit rate where policy
 * allows), and the converted amount the line will save. The dated rate is
 * read from the organization's exchange rates; a missing rate shows the
 * refusal the save would meet and where to add the rate.
 */
export function ExpenseLineCurrency({
  idPrefix,
  reportCurrency,
  reportId,
  state,
  original,
  editable,
  showCurrency = true,
  onChange,
}: {
  idPrefix: string;
  reportCurrency: string;
  /** The saved report, so the rate follows its legal entity; omitted before the first save. */
  reportId?: string;
  state: ForeignLineState;
  original: ForeignOriginal;
  editable: boolean;
  /** False where the surrounding form already chooses the currency. */
  showCurrency?: boolean;
  onChange: (next: ForeignLineState) => void;
}) {
  const t = useTranslations("expenses.currency");
  const { money } = useMoney();
  const [payload, setPayload] = useState<QuotePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const quoteKey = `${state.currency}|${state.rateDate}|${reportId ?? ""}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!isIsoCalendarDate(state.rateDate) || state.currency === reportCurrency) return;
    let active = true;
    const params = new URLSearchParams({ currency: state.currency, date: state.rateDate });
    if (reportId) params.set("reportId", reportId);
    void fetch(`/api/expenses/fx-rate?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(t("quoteFailed"));
        return (await res.json()) as QuotePayload;
      })
      .then((next) => {
        if (!active) return;
        setPayload(next);
        setLoadError(null);
        setLoadedKey(quoteKey);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPayload(null);
        setLoadError(error instanceof Error ? error.message : t("quoteFailed"));
        setLoadedKey(quoteKey);
      });
    return () => {
      active = false;
    };
  }, [quoteKey, reportCurrency, reportId, state.currency, state.rateDate, t]);

  // The dated rate follows the quote for the current currency and date.
  const quoted = loadedKey === quoteKey ? (payload?.quote?.rate ?? null) : state.quotedRate;
  useEffect(() => {
    if (loadedKey !== quoteKey || !editable) return;
    const next = payload?.quote?.rate ?? null;
    if (next !== state.quotedRate) onChange({ ...state, quotedRate: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, quoteKey, payload, editable]);

  const allowOverride = payload?.allowRateOverride === true || state.method === "override";
  const conversion = convertForeignLine({ ...state, quotedRate: quoted }, original, reportCurrency);
  const currencies = SUPPORTED_CURRENCIES.filter((currency) => currency.code !== reportCurrency);
  const set = (patch: Partial<ForeignLineState>) => onChange({ ...state, ...patch });

  return (
    <div className="space-y-3">
      <div className={showCurrency ? "grid gap-3 sm:grid-cols-3" : "grid gap-3 sm:grid-cols-2"}>
        {showCurrency ? (
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-currency`}>{t("currency")}</Label>
            <Select
              id={`${idPrefix}-currency`}
              value={state.currency}
              disabled={!editable}
              onChange={(event) => set({ currency: event.target.value, quotedRate: null })}
            >
              {currencies.map((currency) => (
                <option key={currency.code} value={currency.code}>
                  {currency.code} · {currency.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-rate-date`}>{t("expenseDate")}</Label>
          <DateField
            id={`${idPrefix}-rate-date`}
            value={state.rateDate}
            disabled={!editable}
            onChange={(value) => set({ rateDate: value, quotedRate: null })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-method`}>{t("method")}</Label>
          <Select
            id={`${idPrefix}-method`}
            value={state.method}
            disabled={!editable}
            onChange={(event) => set({ method: event.target.value as ExpenseFxMethod })}
          >
            <option value="rate_table">{t("methods.rate_table")}</option>
            <option value="billed_amount">
              {t("methods.billed_amount", { currency: reportCurrency })}
            </option>
            {allowOverride ? <option value="override">{t("methods.override")}</option> : null}
          </Select>
        </div>
      </div>

      {state.method === "billed_amount" ? (
        <div className="space-y-1 sm:max-w-xs">
          <Label htmlFor={`${idPrefix}-billed`}>
            {t("billedAmount", { currency: reportCurrency })}
          </Label>
          <MoneyInput
            id={`${idPrefix}-billed`}
            value={state.billedAmount}
            required
            field={t("billedAmount", { currency: reportCurrency })}
            disabled={!editable}
            onChange={(value) => set({ billedAmount: value })}
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("billedHint")}</p>
        </div>
      ) : null}

      {state.method === "override" ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-rate`}>
              {t("rate", { from: state.currency, to: reportCurrency })}
            </Label>
            <Input
              id={`${idPrefix}-rate`}
              inputMode="decimal"
              value={state.rate}
              disabled={!editable}
              onChange={(event) => set({ rate: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-reason`}>{t("reason")}</Label>
            <Input
              id={`${idPrefix}-reason`}
              value={state.reason}
              maxLength={500}
              disabled={!editable}
              placeholder={t("reasonPlaceholder")}
              onChange={(event) => set({ reason: event.target.value })}
            />
          </div>
        </div>
      ) : null}

      {state.method === "rate_table" && loadedKey === quoteKey && payload?.refusal ? (
        <Alert variant="warning">
          <AlertDescription>
            {payload.refusal.error} {payload.refusal.remedy}
          </AlertDescription>
        </Alert>
      ) : null}
      {loadError ? (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <p className="text-sm text-slate-700 tabular-nums dark:text-slate-200" aria-live="polite">
        {conversion
          ? conversion.taxAmount !== null
            ? t("convertedWithTax", {
                amount: money(conversion.amount, { currency: reportCurrency }),
                tax: money(conversion.taxAmount, { currency: reportCurrency }),
                rate: conversion.rate,
                from: state.currency,
                to: reportCurrency,
              })
            : t("converted", {
                amount: money(conversion.amount, { currency: reportCurrency }),
                rate: conversion.rate,
                from: state.currency,
                to: reportCurrency,
              })
          : t("conversionPending")}
        {conversion && state.method === "rate_table" && payload?.quote && loadedKey === quoteKey
          ? ` ${t("rateSource", { date: payload.quote.observationDate, rateType: payload.quote.rateType })}`
          : null}
      </p>
    </div>
  );
}
