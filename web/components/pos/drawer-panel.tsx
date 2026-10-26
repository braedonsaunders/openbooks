"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@openbooks/ui";
import { fromUnits } from "@openbooks/engine/money/money";
import { useMoney } from "../money-provider";
import { CountForm, type CountRow } from "./count-form";
import {
  newRequestKey,
  posRequest,
  PosRequestError,
  type PosRegisterContext,
  type PosSessionSummary,
} from "./pos-api";

const minor = (value: string | null | undefined) => fromUnits(BigInt(value ?? "0"));

function refusalText(cause: unknown, fallback: string): string {
  if (cause instanceof PosRequestError)
    return [cause.message, cause.remedy].filter(Boolean).join(" ");
  return fallback;
}

/** The session report body shared by the X report, the Z report and the session history. */
export function SessionReport({ summary }: { summary: PosSessionSummary }) {
  const t = useTranslations("pos");
  const { money } = useMoney(summary.session.currency);
  const closed = summary.session.status === "closed";
  const overShort = BigInt(summary.session.overShortMinor ?? "0");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label={t("report.sales", { count: summary.saleCount })}
          value={money(minor(summary.salesTotalMinor))}
        />
        <Stat
          label={t("report.refunds", { count: summary.refundCount })}
          value={money(minor(summary.refundsTotalMinor))}
        />
        {summary.noChargeSaleCount + summary.noChargeRefundCount > 0 ? (
          <Stat
            label={t("report.noCharge")}
            value={t("report.noChargeCount", {
              sales: summary.noChargeSaleCount,
              refunds: summary.noChargeRefundCount,
            })}
          />
        ) : null}
        <Stat label={t("report.float")} value={money(minor(summary.session.openingFloatMinor))} />
        <Stat label={t("report.expectedCash")} value={money(minor(summary.expectedCashMinor))} />
        {closed ? (
          <Stat
            label={t("report.countedCash")}
            value={money(minor(summary.session.countedCashMinor))}
          />
        ) : null}
        {closed ? (
          <Stat
            label={
              overShort === 0n
                ? t("report.balanced")
                : overShort > 0n
                  ? t("report.over")
                  : t("report.short")
            }
            value={money(fromUnits(overShort < 0n ? -overShort : overShort))}
            tone={overShort === 0n ? "ok" : "warn"}
          />
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("report.tender")}</TableHead>
            <TableHead className="text-right">{t("report.taken")}</TableHead>
            <TableHead className="text-right">{t("report.refunded")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.tenders.map((tender) => (
            <TableRow key={`${tender.kind}-${tender.methodLabel}`}>
              <TableCell>{tender.methodLabel}</TableCell>
              <TableCell className="text-right">{money(minor(tender.saleMinor))}</TableCell>
              <TableCell className="text-right">{money(minor(tender.refundMinor))}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>{t("report.payIns")}</TableCell>
            <TableCell className="text-right">{money(minor(summary.payInMinor))}</TableCell>
            <TableCell />
          </TableRow>
          <TableRow>
            <TableCell>{t("report.payOuts")}</TableCell>
            <TableCell />
            <TableCell className="text-right">{money(minor(summary.payOutMinor))}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {summary.movements.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {summary.movements.map((movement) => (
            <li key={movement.id} className="flex justify-between">
              <span>
                {movement.kind === "pay_in" ? t("movement.payIn") : t("movement.payOut")} ·{" "}
                {movement.reason}
                {movement.note ? ` · ${movement.note}` : ""}
              </span>
              <span>{money(minor(movement.amountMinor))}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {summary.session.closeNote ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{summary.session.closeNote}</p>
      ) : null}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div
      className={`rounded-lg p-3 ${tone === "warn" ? "bg-amber-50 dark:bg-amber-950" : tone === "ok" ? "bg-teal-50 dark:bg-teal-950" : "bg-slate-100 dark:bg-slate-800"}`}
    >
      <p className="text-xs text-slate-600 dark:text-slate-400">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

/** Open the drawer with its counted float. */
export function OpenSessionPanel(props: {
  context: PosRegisterContext;
  canManageDrawer: boolean;
  onOpened: () => void;
}) {
  const t = useTranslations("pos");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!props.canManageDrawer) {
    return (
      <p className="text-lg text-slate-600 dark:text-slate-300">
        {t("session.closedNoPermission")}
      </p>
    );
  }
  async function open(rows: CountRow[]) {
    setBusy(true);
    setError(null);
    try {
      await posRequest(
        "/api/pos/sessions",
        { method: "POST", body: { registerId: props.context.register.id, openingCount: rows } },
        t("errors.openSession"),
      );
      props.onOpened();
    } catch (cause) {
      setError(refusalText(cause, t("errors.openSession")));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{t("session.openTitle")}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t("session.openHelp")}</p>
      </div>
      <CountForm
        currency={props.context.register.currency}
        denominations={props.context.register.denominations}
        submitLabel={t("session.open")}
        busy={busy}
        onSubmit={(rows) => void open(rows)}
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}

/** The drawer during a shift: X report, pay-ins and pay-outs, and the blind close. */
export function DrawerPanel(props: {
  context: PosRegisterContext;
  onClosed: () => void;
  onBack: () => void;
}) {
  const t = useTranslations("pos");
  const session = props.context.session!;
  const [view, setView] = useState<"report" | "movement" | "close">("report");
  const [summary, setSummary] = useState<PosSessionSummary | null>(null);
  const [closedSummary, setClosedSummary] = useState<PosSessionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reasonId, setReasonId] = useState(props.context.cashReasons[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [movementKey, setMovementKey] = useState(newRequestKey);
  const [closeNote, setCloseNote] = useState("");

  const load = useCallback(async () => {
    try {
      const body = await posRequest<{ summary: PosSessionSummary }>(
        `/api/pos/sessions/${session.id}`,
        {},
        t("errors.report"),
      );
      setSummary(body.summary);
    } catch (cause) {
      setError(refusalText(cause, t("errors.report")));
    }
  }, [session.id, t]);

  useEffect(() => {
    let current = true;
    posRequest<{ summary: PosSessionSummary }>(
      `/api/pos/sessions/${session.id}`,
      {},
      t("errors.report"),
    ).then(
      (body) => {
        if (current) setSummary(body.summary);
      },
      (cause: unknown) => {
        if (current) setError(refusalText(cause, t("errors.report")));
      },
    );
    return () => {
      current = false;
    };
  }, [session.id, t]);

  async function recordMovement() {
    setBusy(true);
    setError(null);
    try {
      await posRequest(
        `/api/pos/sessions/${session.id}/movements`,
        {
          method: "POST",
          body: { reasonId, amount: amount.trim(), note: note.trim() || null },
          idempotencyKey: movementKey,
        },
        t("errors.movement"),
      );
      setAmount("");
      setNote("");
      setMovementKey(newRequestKey());
      setView("report");
      await load();
    } catch (cause) {
      // A refused movement is a new request next time; a lost connection retries with the same key.
      if (!(cause instanceof PosRequestError && cause.retryable)) setMovementKey(newRequestKey());
      setError(refusalText(cause, t("errors.movement")));
    } finally {
      setBusy(false);
    }
  }

  async function close(rows: CountRow[]) {
    setBusy(true);
    setError(null);
    try {
      const body = await posRequest<{ summary: PosSessionSummary }>(
        `/api/pos/sessions/${session.id}/close`,
        { method: "POST", body: { closingCount: rows, note: closeNote.trim() || null } },
        t("errors.close"),
      );
      setClosedSummary(body.summary);
    } catch (cause) {
      setError(refusalText(cause, t("errors.close")));
    } finally {
      setBusy(false);
    }
  }

  if (closedSummary) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">
          {t("session.zTitle", { number: closedSummary.session.sessionNumber })}
        </h2>
        <SessionReport summary={closedSummary} />
        <div className="flex gap-2">
          <Button size="lg" onClick={() => window.print()} variant="outline">
            {t("receipt.print")}
          </Button>
          <Button size="lg" onClick={props.onClosed}>
            {t("actions.done")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist">
        <Button
          role="tab"
          aria-selected={view === "report"}
          variant={view === "report" ? "default" : "outline"}
          onClick={() => setView("report")}
        >
          {t("session.xReport")}
        </Button>
        <Button
          role="tab"
          aria-selected={view === "movement"}
          variant={view === "movement" ? "default" : "outline"}
          disabled={props.context.cashReasons.length === 0}
          onClick={() => setView("movement")}
        >
          {t("session.payInOut")}
        </Button>
        <Button
          role="tab"
          aria-selected={view === "close"}
          variant={view === "close" ? "default" : "outline"}
          onClick={() => setView("close")}
        >
          {t("session.close")}
        </Button>
        <Button variant="ghost" className="ml-auto" onClick={props.onBack}>
          {t("actions.back")}
        </Button>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {view === "report" ? (
        summary ? (
          <SessionReport summary={summary} />
        ) : (
          <p className="text-sm text-slate-500">{t("report.loading")}</p>
        )
      ) : null}
      {view === "movement" ? (
        <form
          className="max-w-md space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void recordMovement();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="pos-reason">{t("movement.reason")}</Label>
            <Select
              id="pos-reason"
              value={reasonId}
              onChange={(event) => setReasonId(event.target.value)}
            >
              {props.context.cashReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.direction === "pay_in" ? t("movement.payIn") : t("movement.payOut")} ·{" "}
                  {reason.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="pos-movement-amount">{t("payment.amount")}</Label>
            <Input
              id="pos-movement-amount"
              inputMode="decimal"
              className="h-12 text-lg"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pos-movement-note">{t("movement.note")}</Label>
            <Input
              id="pos-movement-note"
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="lg"
            disabled={busy || reasonId === "" || amount.trim() === ""}
          >
            {t("movement.record")}
          </Button>
        </form>
      ) : null}
      {view === "close" ? (
        <div className="max-w-2xl space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">{t("session.closeHelp")}</p>
          <CountForm
            currency={props.context.register.currency}
            denominations={props.context.register.denominations}
            submitLabel={t("session.closeConfirm")}
            busy={busy}
            onSubmit={(rows) => void close(rows)}
          >
            <div className="space-y-1">
              <Label htmlFor="pos-close-note">{t("session.closeNote")}</Label>
              <Textarea
                id="pos-close-note"
                rows={2}
                maxLength={1000}
                value={closeNote}
                onChange={(event) => setCloseNote(event.target.value)}
              />
            </div>
          </CountForm>
        </div>
      ) : null}
    </div>
  );
}
