"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createMoneyFormatter } from "@/lib/money-format";
import { refusalMessageFromBody } from "@/lib/api-error";
import { add, cmp, mulPercent } from "@openbooks/engine/money";
import { SignaturePad } from "../../../../components/signature-pad";

type QuoteView = {
  orgName: string;
  customerName: string;
  quoteNumber: string;
  title: string | null;
  currency: string;
  status: string;
  expiresAt: string;
  signerName: string;
  consentText: string;
  depositBasis: "none" | "percent" | "amount";
  depositValue: string;
  lines: {
    id: string;
    description: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    taxAmount: string;
    optional: boolean;
  }[];
};

/** The customer's side of a service quote: review, choose add-ons, accept or decline. */
export function ServiceQuoteForm({ token }: { token: string }) {
  const t = useTranslations("service.sign");
  const locale = useLocale();
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/sign/service-quotes/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      setRefusal(refusalMessageFromBody(body, { fallback: t("linkInvalid") }) ?? t("linkInvalid"));
      return;
    }
    setQuote(body as QuoteView);
  }, [t, token]);
  useEffect(() => {
    queueMicrotask(() => {
      void load();
    });
  }, [load]);

  const money = useMemo(
    () => (quote ? createMoneyFormatter(locale, quote.currency) : null),
    [locale, quote],
  );
  // Totals are exact decimal sums of the engine's line amounts; the engine
  // recomputes and records the accepted total on acceptance.
  const total = useMemo(() => {
    if (!quote) return "0";
    return quote.lines
      .filter((line) => !line.optional || selected.has(line.id))
      .reduce((sum, line) => add(sum, add(line.amount, line.taxAmount)), "0");
  }, [quote, selected]);
  const deposit = useMemo(() => {
    if (!quote || quote.depositBasis === "none") return null;
    const due =
      quote.depositBasis === "percent"
        ? mulPercent(total, quote.depositValue, 2)
        : quote.depositValue;
    return cmp(due, total) > 0 ? total : due;
  }, [quote, total]);

  async function answer(kind: "accept" | "decline") {
    setBusy(true);
    setRefusal(null);
    try {
      const body =
        kind === "accept"
          ? {
              answer: "accept",
              name: name.trim(),
              selectedOptionalLineIds: [...selected],
              signatureSvg: signature,
            }
          : { answer: "decline", name: name.trim() };
      const response = await fetch(`/api/sign/service-quotes/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setRefusal(
          refusalMessageFromBody(await response.json().catch(() => null), {
            fallback: t("answerFailed"),
          }) ?? t("answerFailed"),
        );
        return;
      }
      setDone(kind === "accept" ? "accepted" : "declined");
    } finally {
      setBusy(false);
    }
  }

  if (refusal && !quote)
    return (
      <div
        role="alert"
        className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
      >
        {refusal}
      </div>
    );
  if (!quote || !money)
    return (
      <p className="text-center text-sm text-slate-500" aria-busy="true">
        {t("loading")}
      </p>
    );
  if (done)
    return (
      <div
        role="status"
        className="rounded-xl border border-teal-200 bg-teal-50 p-4 text-center text-sm text-teal-900"
      >
        {t(done === "accepted" ? "acceptedThanks" : "declinedThanks")}
      </div>
    );
  const required = quote.lines.filter((line) => !line.optional);
  const optional = quote.lines.filter((line) => line.optional);
  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div>
        <p className="text-xs uppercase tracking-widest text-slate-400">{quote.orgName}</p>
        <h1 className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t("quoteHeading", { number: quote.quoteNumber })}
        </h1>
        {quote.title ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{quote.title}</p>
        ) : null}
        <p className="text-xs text-slate-500">{t("preparedFor", { name: quote.customerName })}</p>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {required.map((line) => (
            <tr key={line.id} className="border-b border-slate-100 dark:border-slate-800">
              <td className="py-1.5">{line.description}</td>
              <td className="py-1.5 text-right tabular-nums">
                {money.money(add(line.amount, line.taxAmount), { currency: quote.currency })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {optional.length ? (
        <fieldset className="space-y-1">
          <legend className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t("addOns")}
          </legend>
          {optional.map((line) => (
            <label key={line.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(line.id)}
                  onChange={(event) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(line.id);
                      else next.delete(line.id);
                      return next;
                    })
                  }
                />
                {line.description}
              </span>
              <span className="tabular-nums">
                {money.money(add(line.amount, line.taxAmount), { currency: quote.currency })}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold dark:border-slate-800">
        <span>{t("total")}</span>
        <span className="tabular-nums">{money.money(total, { currency: quote.currency })}</span>
      </div>
      {deposit ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t("depositDue", { amount: money.money(deposit, { currency: quote.currency }) })}
        </p>
      ) : null}
      <div className="space-y-2">
        <input
          aria-label={t("yourName")}
          placeholder={t("yourName")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm dark:border-slate-600 dark:bg-slate-900"
        />
        <SignaturePad onChange={setSignature} clearLabel={t("clear")} />
        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={consented}
            onChange={(event) => setConsented(event.target.checked)}
          />
          {quote.consentText}
        </label>
      </div>
      {refusal ? (
        <p role="alert" className="text-sm text-rose-600">
          {refusal}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || !name.trim() || !consented}
          onClick={() => void answer("accept")}
          className="flex-1 rounded-md bg-teal-600 py-2 text-sm font-medium text-white hover:bg-teal-700 disabled:opacity-50"
        >
          {t("accept")}
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void answer("decline")}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-600 dark:text-slate-200"
        >
          {t("decline")}
        </button>
      </div>
      <p className="text-xs text-slate-400">
        {t("expires", {
          date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
            new Date(quote.expiresAt),
          ),
        })}
      </p>
    </div>
  );
}
