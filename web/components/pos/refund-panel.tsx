"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label } from "@openbooks/ui";
import { cmp, fromUnits, toUnits } from "@openbooks/engine/money/money";
import { proratedReturnUnits } from "@openbooks/engine/pos/cart";
import { useMoney } from "../money-provider";
import {
  newRequestKey,
  posRequest,
  PosRequestError,
  type PosCompletion,
  type PosReceipt,
  type PosRegisterContext,
} from "./pos-api";

type RefundTender = "cash" | "card" | "stored_value" | "other";

/**
 * Refund from a prior receipt: look the receipt up by its number, choose the
 * returned quantities (never more than remain unreturned), and pay the
 * refund back through one tender. The server prices the refund at the
 * receipt's own prices and tax.
 */
export function RefundPanel(props: {
  context: PosRegisterContext;
  sessionId: string;
  onRefunded: (completion: PosCompletion) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("pos");
  const [number, setNumber] = useState("");
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [tender, setTender] = useState<RefundTender>("cash");
  const [reference, setReference] = useState("");
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const { money } = useMoney(receipt?.currency ?? props.context.register.currency);
  const accepted = props.context.acceptedTenders;

  async function lookup() {
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      const found = await posRequest<{ documentId: string }>(
        `/api/pos/receipts?number=${encodeURIComponent(number.trim())}`,
        {},
        t("errors.receiptNotFound"),
      );
      const body = await posRequest<{ receipt: PosReceipt }>(
        `/api/pos/receipts/${found.documentId}`,
        {},
        t("errors.receiptLoad"),
      );
      setReceipt(body.receipt);
      setQuantities({});
      setRequestKey(newRequestKey());
    } catch (cause) {
      setError(
        cause instanceof PosRequestError && cause.status === 404
          ? t("errors.receiptNotFound")
          : cause instanceof Error
            ? cause.message
            : t("errors.receiptLoad"),
      );
    } finally {
      setBusy(false);
    }
  }

  const decimals = props.context.register.currencyDecimals;
  const selected = (receipt?.lines ?? []).flatMap((line) => {
    const raw = (quantities[line.lineNumber] ?? "").trim();
    if (raw === "" || !/^\d{1,9}(\.\d{1,4})?$/.test(raw) || toUnits(raw) <= 0n) return [];
    if (cmp(raw, line.refundableQuantity) > 0) return [];
    return [{ line, quantity: raw }];
  });
  const estimate = selected.reduce((sum, { line, quantity }) => {
    const original = line.quantity ?? "1";
    return (
      sum +
      proratedReturnUnits(toUnits(line.amount), original, quantity, decimals) +
      proratedReturnUnits(toUnits(line.tax), original, quantity, decimals)
    );
  }, 0n);
  const overLimit = (receipt?.lines ?? []).some((line) => {
    const raw = (quantities[line.lineNumber] ?? "").trim();
    return raw !== "" && /^\d{1,9}(\.\d{1,4})?$/.test(raw) && cmp(raw, line.refundableQuantity) > 0;
  });

  const noCharge = selected.length > 0 && estimate === 0n;

  async function submit() {
    if (!receipt || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const payment =
        tender === "cash"
          ? { kind: "cash" as const }
          : tender === "card"
            ? { kind: "card" as const, reference: reference.trim() || null }
            : tender === "stored_value"
              ? { kind: "stored_value" as const, code: code.trim() }
              : { kind: "other" as const };
      // A refund of lines sold at no charge pays nothing back, so it carries no tender.
      const payments = noCharge ? [] : [payment];
      const completion = await posRequest<PosCompletion>(
        "/api/pos/refunds",
        {
          method: "POST",
          idempotencyKey: requestKey,
          body: {
            sessionId: props.sessionId,
            originalDocumentId: receipt.documentId,
            lines: selected.map(({ line, quantity }) => ({
              lineNumber: line.lineNumber,
              quantity,
            })),
            payments,
            reason: reason.trim() || null,
          },
        },
        t("errors.refund"),
      );
      props.onRefunded(completion);
    } catch (cause) {
      if (!(cause instanceof PosRequestError && cause.retryable)) setRequestKey(newRequestKey());
      setError(
        cause instanceof PosRequestError
          ? [cause.message, cause.remedy].filter(Boolean).join(" ")
          : t("errors.refund"),
      );
    } finally {
      setBusy(false);
    }
  }

  const tenderLabel: Record<RefundTender, string> = {
    cash: t("tender.cash"),
    card: t("tender.card"),
    stored_value: t("tender.storedValue"),
    other: t("tender.other"),
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup();
        }}
      >
        <Input
          autoFocus
          className="h-12 text-lg"
          placeholder={t("refund.receiptNumber")}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
        <Button type="submit" size="lg" disabled={busy || number.trim() === ""}>
          {t("refund.find")}
        </Button>
      </form>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {receipt ? (
        <div className="flex-1 space-y-3 overflow-y-auto">
          <p className="font-semibold">
            {t("receipt.title")} {receipt.documentNumber} · {receipt.documentDate}
            {receipt.customerName ? ` · ${receipt.customerName}` : ""}
          </p>
          <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {receipt.lines.map((line) => (
              <li
                key={line.lineNumber}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div>
                  <p>{line.description}</p>
                  <p className="text-xs text-slate-500">
                    {t("refund.sold", {
                      quantity: line.quantity ?? "1",
                      amount: money(line.amount),
                    })}{" "}
                    · {t("refund.refundable", { quantity: line.refundableQuantity })}
                  </p>
                </div>
                <Input
                  aria-label={t("refund.quantityFor", { item: line.description ?? "" })}
                  inputMode="decimal"
                  className="h-11 w-24 text-right text-lg"
                  disabled={cmp(line.refundableQuantity, "0") <= 0}
                  value={quantities[line.lineNumber] ?? ""}
                  placeholder="0"
                  onChange={(event) =>
                    setQuantities((current) => ({
                      ...current,
                      [line.lineNumber]: event.target.value,
                    }))
                  }
                />
              </li>
            ))}
          </ul>
          {overLimit ? <p className="text-sm text-red-600">{t("refund.overLimit")}</p> : null}
          {noCharge ? (
            <p className="text-sm text-slate-600 dark:text-slate-300">{t("refund.noCharge")}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2" role="tablist">
                {accepted.map((kind) => (
                  <Button
                    key={kind}
                    role="tab"
                    aria-selected={tender === kind}
                    variant={tender === kind ? "default" : "outline"}
                    onClick={() => setTender(kind)}
                  >
                    {tenderLabel[kind]}
                  </Button>
                ))}
              </div>
              {tender === "card" ? (
                <Input
                  placeholder={t("payment.reference")}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              ) : null}
              {tender === "stored_value" ? (
                <Input
                  placeholder={t("payment.cardCode")}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              ) : null}
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="pos-refund-reason">{t("refund.reason")}</Label>
            <Input
              id="pos-refund-reason"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="lg"
          className="flex-1"
          disabled={busy}
          onClick={props.onCancel}
        >
          {t("actions.back")}
        </Button>
        <Button
          size="lg"
          className="flex-1"
          disabled={
            busy ||
            !receipt ||
            selected.length === 0 ||
            overLimit ||
            (!noCharge && tender === "stored_value" && code.trim() === "")
          }
          onClick={() => void submit()}
        >
          {noCharge
            ? t("refund.submitNoCharge")
            : t("refund.submit", { amount: money(fromUnits(estimate)) })}
        </Button>
      </div>
    </div>
  );
}
