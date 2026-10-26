"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Table, TableBody, TableCell, TableRow } from "@openbooks/ui";
import { cmp } from "@openbooks/engine/money/money";
import { useMoney } from "../money-provider";
import {
  encodeEscPos,
  printEscPosOverSerial,
  serialPrintingAvailable,
  type EscPosLine,
} from "../../lib/pos-escpos";
import { posRequest, PosRequestError, type PosReceipt } from "./pos-api";

/**
 * Print isolation: only the receipt prints, at receipt-printer width, when
 * the browser print dialog is used.
 */
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  #pos-receipt-print, #pos-receipt-print * { visibility: visible !important; }
  #pos-receipt-print { position: absolute; left: 0; top: 0; width: 72mm; padding: 0; margin: 0; font-size: 11px; color: #000; }
}`;

export function ReceiptDocument({ receipt }: { receipt: PosReceipt }) {
  const t = useTranslations("pos");
  const { money } = useMoney(receipt.currency);
  const refund = receipt.kind === "cash_refund";
  return (
    <div id="pos-receipt-print" className="mx-auto max-w-sm space-y-3 font-mono text-sm">
      {receipt.register?.receiptHeader ? (
        <p className="whitespace-pre-line text-center">{receipt.register.receiptHeader}</p>
      ) : null}
      <div className="text-center">
        <p className="font-semibold">
          {refund ? t("receipt.refundTitle") : t("receipt.title")} {receipt.documentNumber}
        </p>
        <p>
          {receipt.documentDate}
          {receipt.register ? ` · ${receipt.register.code}` : ""}
          {receipt.cashierName ? ` · ${receipt.cashierName}` : ""}
        </p>
        {receipt.customerName ? <p>{receipt.customerName}</p> : null}
        {receipt.refundOf ? (
          <p>{t("receipt.refundOf", { number: receipt.refundOf.documentNumber })}</p>
        ) : null}
      </div>
      <Table>
        <TableBody>
          {receipt.lines.map((line) => (
            <TableRow key={line.lineNumber}>
              <TableCell className="px-0 py-1">
                <div>{line.description}</div>
                <div className="text-xs text-slate-500">
                  {line.quantity} × {line.unitPrice ? money(line.unitPrice) : ""}
                  {cmp(line.discount, "0") !== 0
                    ? ` · ${t("receipt.discount")} ${money(line.discount)}`
                    : ""}
                </div>
              </TableCell>
              <TableCell className="px-0 py-1 text-right align-top">{money(line.amount)}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="px-0 py-1">{t("totals.subtotal")}</TableCell>
            <TableCell className="px-0 py-1 text-right">{money(receipt.subtotal)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="px-0 py-1">{t("totals.tax")}</TableCell>
            <TableCell className="px-0 py-1 text-right">{money(receipt.tax)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="px-0 py-1 font-semibold">{t("totals.total")}</TableCell>
            <TableCell className="px-0 py-1 text-right font-semibold">
              {money(receipt.total)}
            </TableCell>
          </TableRow>
          {receipt.tenders.map((tender, index) => (
            <TableRow key={`${tender.kind}-${index}`}>
              <TableCell className="px-0 py-1">
                {tender.methodLabel}
                {tender.reference ? ` (${tender.reference})` : ""}
              </TableCell>
              <TableCell className="px-0 py-1 text-right">{money(tender.amount)}</TableCell>
            </TableRow>
          ))}
          {receipt.tenders.length === 0 && cmp(receipt.total, "0") === 0 ? (
            <TableRow>
              <TableCell className="px-0 py-1" colSpan={2}>
                {t("receipt.noCharge")}
              </TableCell>
            </TableRow>
          ) : null}
          {!refund && cmp(receipt.cashTendered, "0") > 0 ? (
            <TableRow>
              <TableCell className="px-0 py-1">{t("receipt.cashTendered")}</TableCell>
              <TableCell className="px-0 py-1 text-right">{money(receipt.cashTendered)}</TableCell>
            </TableRow>
          ) : null}
          {!refund && cmp(receipt.change, "0") > 0 ? (
            <TableRow>
              <TableCell className="px-0 py-1 font-semibold">{t("receipt.change")}</TableCell>
              <TableCell className="px-0 py-1 text-right font-semibold">
                {money(receipt.change)}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      {receipt.register?.receiptFooter ? (
        <p className="whitespace-pre-line text-center">{receipt.register.receiptFooter}</p>
      ) : null}
    </div>
  );
}

function escPosLines(
  receipt: PosReceipt,
  money: (value: string) => string,
  t: ReturnType<typeof useTranslations>,
): EscPosLine[] {
  const refund = receipt.kind === "cash_refund";
  const lines: EscPosLine[] = [];
  if (receipt.register?.receiptHeader)
    lines.push({ kind: "text", text: receipt.register.receiptHeader, align: "center" });
  lines.push({
    kind: "text",
    text: `${refund ? t("receipt.refundTitle") : t("receipt.title")} ${receipt.documentNumber}`,
    align: "center",
    bold: true,
  });
  lines.push({
    kind: "text",
    text: `${receipt.documentDate}${receipt.register ? ` ${receipt.register.code}` : ""}`,
    align: "center",
  });
  lines.push({ kind: "rule" });
  for (const line of receipt.lines) {
    lines.push({
      kind: "pair",
      left: `${line.quantity} x ${line.description ?? ""}`,
      right: money(line.amount),
    });
  }
  lines.push({ kind: "rule" });
  lines.push({ kind: "pair", left: t("totals.subtotal"), right: money(receipt.subtotal) });
  lines.push({ kind: "pair", left: t("totals.tax"), right: money(receipt.tax) });
  lines.push({ kind: "pair", left: t("totals.total"), right: money(receipt.total), bold: true });
  for (const tender of receipt.tenders)
    lines.push({ kind: "pair", left: tender.methodLabel, right: money(tender.amount) });
  if (receipt.tenders.length === 0 && cmp(receipt.total, "0") === 0)
    lines.push({ kind: "text", text: t("receipt.noCharge"), align: "center" });
  if (!refund && cmp(receipt.change, "0") > 0)
    lines.push({
      kind: "pair",
      left: t("receipt.change"),
      right: money(receipt.change),
      bold: true,
    });
  if (receipt.register?.receiptFooter) {
    lines.push({ kind: "feed" });
    lines.push({ kind: "text", text: receipt.register.receiptFooter, align: "center" });
  }
  return lines;
}

/** The completed sale or refund: change due, the receipt, and print / email / next sale. */
export function ReceiptPanel(props: {
  documentId: string;
  change: string | null;
  onDone: () => void;
}) {
  const t = useTranslations("pos");
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { money } = useMoney(receipt?.currency);

  useEffect(() => {
    let cancelled = false;
    posRequest<{ receipt: PosReceipt }>(
      `/api/pos/receipts/${props.documentId}`,
      {},
      t("errors.receiptLoad"),
    )
      .then((body) => {
        if (!cancelled) setReceipt(body.receipt);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t("errors.receiptLoad"));
      });
    return () => {
      cancelled = true;
    };
  }, [props.documentId, t]);

  async function printThermal() {
    if (!receipt) return;
    setNotice(null);
    try {
      await printEscPosOverSerial(encodeEscPos(escPosLines(receipt, (value) => money(value), t)));
      setNotice(t("receipt.printed"));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : t("errors.print"));
    }
  }

  async function sendEmail() {
    if (!receipt) return;
    setBusy(true);
    setNotice(null);
    try {
      const sent = await posRequest<{ to: string }>(
        `/api/pos/receipts/${receipt.documentId}/email`,
        { method: "POST", body: { to: email.trim() || null } },
        t("errors.email"),
      );
      setNotice(t("receipt.emailed", { to: sent.to }));
    } catch (cause) {
      setNotice(
        cause instanceof PosRequestError
          ? [cause.message, cause.remedy].filter(Boolean).join(" ")
          : t("errors.email"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4">
      <style>{PRINT_CSS}</style>
      {props.change !== null && cmp(props.change, "0") > 0 && receipt ? (
        <div className="rounded-lg bg-teal-50 p-4 text-center dark:bg-teal-950">
          <p className="text-sm text-teal-800 dark:text-teal-200">{t("receipt.changeDue")}</p>
          <p className="text-4xl font-bold text-teal-900 dark:text-teal-100">
            {money(props.change)}
          </p>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
        {receipt ? (
          <ReceiptDocument receipt={receipt} />
        ) : (
          <p className="text-sm text-slate-500">{error ?? t("receipt.loading")}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="lg" disabled={!receipt} onClick={() => window.print()}>
          {t("receipt.print")}
        </Button>
        {serialPrintingAvailable() ? (
          <Button
            variant="outline"
            size="lg"
            disabled={!receipt}
            onClick={() => void printThermal()}
          >
            {t("receipt.printThermal")}
          </Button>
        ) : null}
        <Input
          className="h-11 min-w-48 flex-1"
          type="email"
          placeholder={t("receipt.emailPlaceholder")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button
          variant="outline"
          size="lg"
          disabled={!receipt || busy}
          onClick={() => void sendEmail()}
        >
          {t("receipt.email")}
        </Button>
        <Button size="lg" onClick={props.onDone}>
          {t("receipt.newSale")}
        </Button>
      </div>
      {notice ? <p className="text-sm text-slate-600 dark:text-slate-300">{notice}</p> : null}
    </div>
  );
}
