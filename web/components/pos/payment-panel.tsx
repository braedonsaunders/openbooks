"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label } from "@openbooks/ui";
import { fromUnits, toUnits } from "@openbooks/engine/money/money";
import { cashSuggestions } from "@openbooks/engine/pos/cart";
import { useMoney } from "../money-provider";
import type { PosPayment } from "./pos-api";

type Tender = "cash" | "card" | "stored_value" | "other";

function units(value: string): bigint | null {
  const text = value.trim();
  if (!/^\d{1,13}(\.\d{1,4})?$/.test(text)) return null;
  return toUnits(text);
}

/**
 * Split tenders. Card, gift card and other payments apply their amounts;
 * cash covers what remains and any cash handed over beyond it is change.
 * The panel only collects the payments — the server re-prices the cart and
 * refuses a total that moved since the cashier saw it.
 */
export function PaymentPanel(props: {
  currency: string;
  currencyDecimals: number;
  total: string;
  accepted: Tender[];
  busy: boolean;
  onCancel: () => void;
  onComplete: (payments: PosPayment[]) => void;
}) {
  const t = useTranslations("pos");
  const { money } = useMoney(props.currency);
  const totalUnits = toUnits(props.total);
  const [payments, setPayments] = useState<PosPayment[]>([]);
  const [mode, setMode] = useState<Tender>(
    props.accepted.includes("cash") ? "cash" : (props.accepted[0] ?? "cash"),
  );
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");

  const nonCash = payments.reduce(
    (sum, payment) => sum + (payment.amount ? toUnits(payment.amount) : 0n),
    0n,
  );
  const remaining = totalUnits - nonCash > 0n ? totalUnits - nonCash : 0n;
  const tendered = units(amount);
  const change =
    mode === "cash" && tendered !== null && tendered >= remaining ? tendered - remaining : null;
  const suggestions = useMemo(
    () => (remaining > 0n ? cashSuggestions(remaining, props.currencyDecimals) : []),
    [remaining, props.currencyDecimals],
  );

  function addNonCash() {
    const value = units(amount);
    if (value === null || value <= 0n || value > remaining) return;
    setPayments((current) => [
      ...current,
      {
        kind: mode,
        amount: fromUnits(value),
        reference: mode === "card" ? reference.trim() || null : null,
        code: mode === "stored_value" ? code.trim() : null,
        label: mode === "other" ? label.trim() || null : null,
      },
    ]);
    setAmount("");
    setReference("");
    setCode("");
    setLabel("");
  }

  function completeWithCash(cashUnits: bigint | null) {
    if (remaining > 0n && (cashUnits === null || cashUnits < remaining)) return;
    const cash: PosPayment[] =
      remaining > 0n && cashUnits !== null
        ? [{ kind: "cash", tendered: fromUnits(cashUnits) }]
        : [];
    props.onComplete([...payments, ...cash]);
  }

  const canFinishNonCash = remaining === 0n && payments.length > 0;
  const tenderLabel: Record<Tender, string> = {
    cash: t("tender.cash"),
    card: t("tender.card"),
    stored_value: t("tender.storedValue"),
    other: t("tender.other"),
  };

  if (totalUnits === 0n) {
    // Nothing is due: the sale completes with no tender at all.
    return (
      <div className="flex h-full flex-col gap-4">
        <div className="rounded-lg bg-slate-100 p-3 text-center dark:bg-slate-800">
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("totals.total")}</p>
          <p className="text-3xl font-bold">{money(props.total)}</p>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("payment.noCharge")}</p>
        </div>
        <div className="mt-auto flex gap-2">
          <Button
            variant="outline"
            size="lg"
            className="flex-1"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {t("actions.back")}
          </Button>
          <Button
            size="lg"
            className="flex-1"
            disabled={props.busy}
            onClick={() => props.onComplete([])}
          >
            {t("payment.completeNoCharge")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("totals.total")}</p>
          <p className="text-3xl font-bold">{money(props.total)}</p>
        </div>
        <div className="rounded-lg bg-teal-50 p-3 dark:bg-teal-950">
          <p className="text-sm text-teal-800 dark:text-teal-200">{t("payment.remaining")}</p>
          <p className="text-3xl font-bold text-teal-900 dark:text-teal-100">
            {money(fromUnits(remaining))}
          </p>
        </div>
      </div>
      {payments.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {payments.map((payment, index) => (
            <li key={index} className="flex items-center justify-between px-3 py-2">
              <span>
                {tenderLabel[payment.kind]}
                {payment.reference ? ` · ${payment.reference}` : ""}
                {payment.code ? ` · …${payment.code.slice(-4)}` : ""}
                {payment.label ? ` · ${payment.label}` : ""}
              </span>
              <span className="flex items-center gap-3">
                <strong>{money(payment.amount ?? "0")}</strong>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPayments((current) => current.filter((_, i) => i !== index))}
                >
                  {t("actions.remove")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2" role="tablist">
        {props.accepted.map((kind) => (
          <Button
            key={kind}
            role="tab"
            aria-selected={mode === kind}
            variant={mode === kind ? "default" : "outline"}
            size="lg"
            onClick={() => {
              setMode(kind);
              setAmount("");
            }}
          >
            {tenderLabel[kind]}
          </Button>
        ))}
      </div>
      {remaining > 0n ? (
        mode === "cash" ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {suggestions.map((value) => (
                <Button
                  key={value.toString()}
                  variant="secondary"
                  size="lg"
                  className="min-w-24 text-lg"
                  disabled={props.busy}
                  onClick={() => completeWithCash(value)}
                >
                  {money(fromUnits(value))}
                </Button>
              ))}
            </div>
            <div className="space-y-1">
              <Label htmlFor="pos-cash-tendered">{t("payment.cashTendered")}</Label>
              <Input
                id="pos-cash-tendered"
                autoFocus
                inputMode="decimal"
                className="h-14 text-2xl"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
            {change !== null ? (
              <p className="text-lg">
                {t("payment.changeDue")} <strong>{money(fromUnits(change))}</strong>
              </p>
            ) : null}
            <Button
              size="lg"
              className="h-14 w-full text-lg"
              disabled={props.busy || tendered === null || tendered < remaining}
              onClick={() => completeWithCash(tendered)}
            >
              {t("payment.completeCash")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {mode === "stored_value" ? (
              <div className="space-y-1">
                <Label htmlFor="pos-sv-code">{t("payment.cardCode")}</Label>
                <Input
                  id="pos-sv-code"
                  autoFocus
                  className="h-12 text-lg"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
            ) : null}
            {mode === "card" ? (
              <div className="space-y-1">
                <Label htmlFor="pos-card-ref">{t("payment.reference")}</Label>
                <Input
                  id="pos-card-ref"
                  className="h-12 text-lg"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </div>
            ) : null}
            {mode === "other" ? (
              <div className="space-y-1">
                <Label htmlFor="pos-other-label">{t("payment.otherLabel")}</Label>
                <Input
                  id="pos-other-label"
                  className="h-12 text-lg"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="pos-tender-amount">{t("payment.amount")}</Label>
              <div className="flex gap-2">
                <Input
                  id="pos-tender-amount"
                  inputMode="decimal"
                  className="h-12 text-lg"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => setAmount(fromUnits(remaining))}
                >
                  {t("payment.exact")}
                </Button>
              </div>
            </div>
            <Button
              size="lg"
              className="h-12 w-full"
              disabled={
                props.busy ||
                units(amount) === null ||
                (units(amount) ?? 0n) <= 0n ||
                (units(amount) ?? 0n) > remaining ||
                (mode === "stored_value" && code.trim() === "")
              }
              onClick={addNonCash}
            >
              {t("payment.add")}
            </Button>
          </div>
        )
      ) : null}
      <div className="mt-auto flex gap-2">
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {t("actions.back")}
        </Button>
        {canFinishNonCash ? (
          <Button
            size="lg"
            className="flex-1"
            disabled={props.busy}
            onClick={() => props.onComplete(payments)}
          >
            {t("payment.complete")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
