"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { promptDialog } from "../../../../lib/prompt";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { DateField } from "../../../../components/date-field";

/**
 * Records a bank transfer from one entity's bank account to another's, or
 * shows one with its reversal. The posting adds the pair's due-to/due-from
 * legs; a transfer inside one entity belongs in Banking instead.
 */

type Subsidiary = { id: string; name: string; baseCurrency: string };
type Bank = { id: string; label: string; subsidiaryId: string | null; currency: string | null };

type TransferView = {
  id: string;
  transferNumber: string;
  transferDate: string;
  status: "posted" | "reversed";
  statusLabel: string;
  from: string;
  to: string;
  amount: string;
  memo: string | null;
  reason: string;
  entryHref: string;
  reversalEntryHref: string | null;
  reversalDate: string | null;
  reverseReason: string | null;
};

export type TransferDrawerProps =
  | {
      mode: "new";
      closeHref: string;
      today: string;
      subsidiaries: Subsidiary[];
      banks: Bank[];
      canSettle: boolean;
    }
  | { mode: "view"; closeHref: string; today: string; transfer: TransferView; canSettle: boolean };

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
    >
      {message}
    </p>
  );
}

export function TransferDrawer(props: TransferDrawerProps) {
  return props.mode === "new" ? <NewTransfer {...props} /> : <ExistingTransfer {...props} />;
}

function NewTransfer({
  closeHref,
  today,
  subsidiaries,
  banks,
}: Extract<TransferDrawerProps, { mode: "new" }>) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [form, setForm] = useState({
    transferDate: today,
    fromSubsidiaryId: "",
    toSubsidiaryId: "",
    fromBankAccountId: "",
    toBankAccountId: "",
    amount: "",
    currency: "",
    memo: "",
    reason: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(globalThis.crypto.randomUUID());
  const banksFor = (subsidiaryId: string) =>
    banks.filter((bank) => bank.subsidiaryId === null || bank.subsidiaryId === subsidiaryId);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const fromBank = banks.find((bank) => bank.id === form.fromBankAccountId);
  const toBank = banks.find((bank) => bank.id === form.toBankAccountId);
  const needsCurrency = Boolean(fromBank && toBank && !fromBank.currency && !toBank.currency);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/intercompany/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          transferDate: form.transferDate,
          fromSubsidiaryId: form.fromSubsidiaryId,
          toSubsidiaryId: form.toSubsidiaryId,
          fromBankAccountId: form.fromBankAccountId,
          toBankAccountId: form.toBankAccountId,
          amount: form.amount.trim(),
          currency: form.currency.trim() ? form.currency.trim().toUpperCase() : null,
          memo: form.memo.trim() || null,
          reason: form.reason,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.transferFailed")));
        return;
      }
      const created = (await res.json()) as { id: string };
      router.push(`/intercompany/transfers?transfer=${created.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.transferFailed"));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    form.fromSubsidiaryId &&
    form.toSubsidiaryId &&
    form.fromBankAccountId &&
    form.toBankAccountId &&
    form.amount.trim() &&
    form.reason.trim() &&
    (!needsCurrency || form.currency.trim());
  return (
    <UrlDrawer
      open
      openKey="new"
      closeHref={closeHref}
      size="lg"
      title={t("transfers.newTitle")}
      description={t("transfers.newDescription")}
      footer={
        <div className="flex justify-end">
          <Button disabled={busy || !ready} onClick={submit}>
            {t("transfers.post")}
          </Button>
        </div>
      }
    >
      <ErrorNote message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        {(["from", "to"] as const).map((side) => {
          const subsidiaryKey = side === "from" ? "fromSubsidiaryId" : "toSubsidiaryId";
          const bankKey = side === "from" ? "fromBankAccountId" : "toBankAccountId";
          return (
            <fieldset
              key={side}
              className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
            >
              <legend className="px-1 text-sm font-medium">
                {t(side === "from" ? "transfers.fromLegend" : "transfers.toLegend")}
              </legend>
              <div className="space-y-1">
                <Label htmlFor={`transfer-${side}-subsidiary`}>{t("transfers.subsidiary")}</Label>
                <Select
                  id={`transfer-${side}-subsidiary`}
                  value={form[subsidiaryKey]}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      [subsidiaryKey]: event.target.value,
                      [bankKey]: "",
                    }))
                  }
                >
                  <option value="">{t("transfers.chooseSubsidiary")}</option>
                  {subsidiaries.map((sub) => (
                    <option key={sub.id} value={sub.id}>
                      {sub.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`transfer-${side}-bank`}>{t("transfers.bankAccount")}</Label>
                <Select
                  id={`transfer-${side}-bank`}
                  value={form[bankKey]}
                  onChange={(event) => set(bankKey)(event.target.value)}
                  disabled={!form[subsidiaryKey]}
                >
                  <option value="">{t("transfers.chooseBank")}</option>
                  {banksFor(form[subsidiaryKey]).map((bank) => (
                    <option key={bank.id} value={bank.id}>
                      {bank.label}
                      {bank.currency ? ` (${bank.currency})` : ""}
                    </option>
                  ))}
                </Select>
              </div>
            </fieldset>
          );
        })}
        <div className="space-y-1">
          <Label htmlFor="transfer-date">{t("transfers.date")}</Label>
          <DateField
            id="transfer-date"
            value={form.transferDate}
            onChange={(value) => set("transferDate")(value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="transfer-amount">{t("transfers.amount")}</Label>
          <Input
            id="transfer-amount"
            inputMode="decimal"
            value={form.amount}
            onChange={(event) => set("amount")(event.target.value)}
          />
        </div>
        {needsCurrency ? (
          <div className="space-y-1">
            <Label htmlFor="transfer-currency">{t("transfers.currency")}</Label>
            <Input
              id="transfer-currency"
              maxLength={3}
              value={form.currency}
              onChange={(event) => set("currency")(event.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="transfer-memo">{t("transfers.memo")}</Label>
          <Input
            id="transfer-memo"
            value={form.memo}
            onChange={(event) => set("memo")(event.target.value)}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="transfer-reason">{t("transfers.reason")}</Label>
          <Textarea
            id="transfer-reason"
            rows={2}
            value={form.reason}
            onChange={(event) => set("reason")(event.target.value)}
          />
        </div>
      </div>
    </UrlDrawer>
  );
}

function ExistingTransfer({
  closeHref,
  today,
  transfer,
  canSettle,
}: Extract<TransferDrawerProps, { mode: "view" }>) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reversalDate, setReversalDate] = useState(today);

  async function reverse() {
    const reason = await promptDialog({
      title: t("transfers.reverseTitle"),
      label: t("transfers.reverseReason"),
    });
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intercompany/transfers/${transfer.id}/reverse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reversalDate, reason }),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.transferFailed")));
        return;
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.transferFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <UrlDrawer
      open
      openKey={transfer.id}
      closeHref={closeHref}
      size="md"
      title={transfer.transferNumber}
      description={`${transfer.transferDate} · ${transfer.amount}`}
      headerActions={
        <Badge variant={transfer.status === "posted" ? "success" : "secondary"}>
          {transfer.statusLabel}
        </Badge>
      }
      footer={
        canSettle && transfer.status === "posted" ? (
          <div className="flex items-center justify-end gap-2">
            <DateField
              aria-label={t("transfers.reversalDate")}
              className="w-40"
              value={reversalDate}
              onChange={(value) => setReversalDate(value)}
            />
            <Button variant="outline" disabled={busy} onClick={reverse}>
              {t("transfers.reverse")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <ErrorNote message={error} />
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("transfers.fromLegend")}</dt>
          <dd>{transfer.from}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("transfers.toLegend")}</dt>
          <dd>{transfer.to}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("transfers.amount")}</dt>
          <dd className="tabular-nums">{transfer.amount}</dd>
        </div>
        {transfer.memo ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t("transfers.memo")}</dt>
            <dd>{transfer.memo}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("transfers.reason")}</dt>
          <dd>{transfer.reason}</dd>
        </div>
        {transfer.reverseReason ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t("transfers.reverseReason")}</dt>
            <dd>
              {transfer.reversalDate} · {transfer.reverseReason}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-4 flex flex-wrap gap-3 text-sm">
        <Link
          className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
          href={transfer.entryHref as never}
        >
          {t("transfers.entry")}
        </Link>
        {transfer.reversalEntryHref ? (
          <Link
            className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
            href={transfer.reversalEntryHref as never}
          >
            {t("transfers.reversalEntry")}
          </Link>
        ) : null}
      </p>
    </UrlDrawer>
  );
}
