"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Label,
  Select,
  Textarea,
  UrlDrawer,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@openbooks/ui";
import { promptDialog } from "../../../../lib/prompt";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { DateField } from "../../../../components/date-field";

/**
 * One netting run drawer through its whole life: a new run is previewed,
 * then proposed (the stored proposal is what gets approved and posted); a
 * stored run shows its pairs and lines with the actions its status admits.
 * Every refusal the server answers is shown with its reason and remedy.
 */

type Subsidiary = { id: string; name: string; baseCurrency: string };
type Bank = { id: string; label: string; subsidiaryId: string | null; currency: string | null };

type PreviewPair = {
  pairId: string;
  currency: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  fromNet: string;
  toNet: string;
  unreconciled: string;
  fromNetted: string;
  cashToFrom: string;
};

type RunView = {
  id: string;
  runNumber: string;
  status: string;
  statusLabel: string;
  statusVariant: "success" | "warning" | "destructive" | "secondary" | "outline";
  asOfDate: string;
  entities: string;
  settleCash: boolean;
  reason: string;
  fingerprint: string;
  decisionNote: string | null;
  cancelReason: string | null;
  reverseReason: string | null;
  reversalDate: string | null;
  warnings: string[];
  pairs: {
    key: string;
    label: string;
    currency: string;
    fromNet: string;
    toNet: string;
    unreconciled: string;
    netted: string;
    cash: string;
  }[];
  lines: {
    key: string;
    component: string;
    entity: string;
    counterparty: string;
    reference: string;
    href: string | null;
    open: string;
    netted: string;
    cash: string;
    rate: string;
    realizedFx: string;
  }[];
  entryHrefs: string[];
};

export type NettingDrawerProps =
  | {
      mode: "new";
      closeHref: string;
      today: string;
      subsidiaries: Subsidiary[];
      banks: Bank[];
      currencies: string[];
      canManage: boolean;
      canSettle: boolean;
    }
  | {
      mode: "view";
      closeHref: string;
      today: string;
      run: RunView;
      canManage: boolean;
      canSettle: boolean;
    };

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

const CELL = "px-2 py-1.5 text-sm";
const NUM = `${CELL} text-right tabular-nums`;

export function NettingDrawer(props: NettingDrawerProps) {
  return props.mode === "new" ? <NewRun {...props} /> : <ExistingRun {...props} />;
}

function NewRun({
  closeHref,
  today,
  subsidiaries,
  banks,
  currencies,
}: Extract<NettingDrawerProps, { mode: "new" }>) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [asOfDate, setAsOfDate] = useState(today);
  const [selected, setSelected] = useState<string[]>([]);
  const [settleCash, setSettleCash] = useState(false);
  const [bankBySubsidiary, setBankBySubsidiary] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{
    pairs: PreviewPair[];
    warnings: string[];
    lineCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per opened form: a retried proposal returns the same run.
  const idempotencyKey = useRef(globalThis.crypto.randomUUID());
  const names = useMemo(
    () => new Map(subsidiaries.map((sub) => [sub.id, sub.name])),
    [subsidiaries],
  );

  function body() {
    const bankAccounts: Record<string, Record<string, string>> = {};
    if (settleCash) {
      for (const subsidiaryId of selected) {
        for (const currency of currencies) {
          const bankId = bankBySubsidiary[`${subsidiaryId}:${currency}`];
          const bank = banks.find((candidate) => candidate.id === bankId);
          if (!bank) continue;
          bankAccounts[subsidiaryId] ??= {};
          bankAccounts[subsidiaryId][currency] = bank.id;
        }
      }
    }
    return {
      asOfDate,
      subsidiaryIds: selected,
      settleCash,
      bankAccounts,
      reason,
      idempotencyKey: idempotencyKey.current,
    };
  }

  async function run(path: string): Promise<Response | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body()),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.nettingFailed")));
        return null;
      }
      return res;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.nettingFailed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doPreview() {
    const res = await run("/api/intercompany/netting/preview");
    if (!res) return;
    const payload = (await res.json()) as {
      computation: { pairs: PreviewPair[]; warnings: string[] };
      lines: unknown[];
    };
    setPreview({
      pairs: payload.computation.pairs,
      warnings: payload.computation.warnings,
      lineCount: payload.lines.length,
    });
  }

  async function propose() {
    const res = await run("/api/intercompany/netting");
    if (!res) return;
    const created = (await res.json()) as { id: string };
    router.push(`/intercompany/netting?run=${created.id}`);
  }

  return (
    <UrlDrawer
      open
      openKey="new"
      closeHref={closeHref}
      size="xl"
      title={t("netting.newTitle")}
      description={t("netting.newDescription")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy || selected.length < 2} onClick={doPreview}>
            {t("netting.preview")}
          </Button>
          <Button disabled={busy || selected.length < 2 || !reason.trim()} onClick={propose}>
            {t("netting.propose")}
          </Button>
        </div>
      }
    >
      <ErrorNote message={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="netting-as-of">{t("netting.asOf")}</Label>
          <DateField
            id="netting-as-of"
            value={asOfDate}
            onChange={(value) => {
              setAsOfDate(value);
              setPreview(null);
            }}
          />
        </div>
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={settleCash}
            onChange={(event) => {
              setSettleCash(event.target.checked);
              setPreview(null);
            }}
          />
          {t("netting.settleCash")}
        </label>
      </div>
      <fieldset className="mt-4 space-y-2">
        <legend className="text-sm font-medium">{t("netting.subsidiaries")}</legend>
        {subsidiaries.map((sub) => {
          const checked = selected.includes(sub.id);
          const choices = banks.filter(
            (bank) => bank.subsidiaryId === null || bank.subsidiaryId === sub.id,
          );
          return (
            <div key={sub.id} className="flex flex-wrap items-center gap-3">
              <label className="flex min-w-48 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, sub.id]
                        : current.filter((id) => id !== sub.id),
                    );
                    setPreview(null);
                  }}
                />
                {sub.name} <span className="text-xs text-slate-500">{sub.baseCurrency}</span>
              </label>
              {settleCash && checked ? (
                <div className="flex flex-wrap gap-2">
                  {currencies.map((currency) => {
                    const currencyBanks = choices.filter(
                      (bank) => bank.currency === null || bank.currency === currency,
                    );
                    if (currencyBanks.length === 0) return null;
                    const key = `${sub.id}:${currency}`;
                    return (
                      <label key={key} className="space-y-1 text-xs">
                        <span>{currency}</span>
                        <Select
                          aria-label={t("netting.bankFor", { entity: `${sub.name} · ${currency}` })}
                          value={bankBySubsidiary[key] ?? ""}
                          onChange={(event) => {
                            setBankBySubsidiary((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }));
                            setPreview(null);
                          }}
                        >
                          <option value="">{t("netting.chooseBank")}</option>
                          {currencyBanks.map((bank) => (
                            <option key={bank.id} value={bank.id}>
                              {bank.label}
                            </option>
                          ))}
                        </Select>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      <div className="mt-4 space-y-1">
        <Label htmlFor="netting-reason">{t("netting.reason")}</Label>
        <Textarea
          id="netting-reason"
          rows={2}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {preview ? (
        <section className="mt-6">
          <h3 className="mb-2 text-sm font-semibold">
            {t("netting.previewTitle", { lines: String(preview.lineCount) })}
          </h3>
          {preview.warnings.length > 0 ? (
            <ul className="mb-3 list-disc space-y-1 rounded-lg bg-amber-50 py-2 pl-6 pr-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <PairTable
            rows={preview.pairs.map((pair) => ({
              key: `${pair.pairId}:${pair.currency}`,
              label: `${names.get(pair.fromSubsidiaryId) ?? ""} ↔ ${names.get(pair.toSubsidiaryId) ?? ""}`,
              currency: pair.currency,
              fromNet: `${pair.fromNet} ${pair.currency}`,
              toNet: `${pair.toNet} ${pair.currency}`,
              unreconciled: `${pair.unreconciled} ${pair.currency}`,
              netted: `${pair.fromNetted} ${pair.currency}`,
              cash: `${pair.cashToFrom} ${pair.currency}`,
            }))}
          />
        </section>
      ) : null}
    </UrlDrawer>
  );
}

function PairTable({ rows }: { rows: RunView["pairs"] }) {
  const t = useTranslations("intercompany");
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
      <Table
        containerClassName="overflow-visible rounded-none border-0 bg-transparent shadow-none"
        className="w-full"
      >
        <TableHeader className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900">
          <TableRow noAnimate>
            <TableHead className={`${CELL} text-left`}>{t("netting.pairColumns.pair")}</TableHead>
            <TableHead className={`${CELL} text-left`}>
              {t("netting.pairColumns.currency")}
            </TableHead>
            <TableHead className={`${CELL} text-right`}>
              {t("netting.pairColumns.fromNet")}
            </TableHead>
            <TableHead className={`${CELL} text-right`}>{t("netting.pairColumns.toNet")}</TableHead>
            <TableHead className={`${CELL} text-right`}>
              {t("netting.pairColumns.unreconciled")}
            </TableHead>
            <TableHead className={`${CELL} text-right`}>
              {t("netting.pairColumns.netted")}
            </TableHead>
            <TableHead className={`${CELL} text-right`}>{t("netting.pairColumns.cash")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              noAnimate
              key={row.key}
              className="border-t border-slate-100 dark:border-slate-800"
            >
              <TableCell className={CELL}>{row.label}</TableCell>
              <TableCell className={CELL}>{row.currency}</TableCell>
              <TableCell className={NUM}>{row.fromNet}</TableCell>
              <TableCell className={NUM}>{row.toNet}</TableCell>
              <TableCell className={NUM}>{row.unreconciled}</TableCell>
              <TableCell className={NUM}>{row.netted}</TableCell>
              <TableCell className={NUM}>{row.cash}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ExistingRun({
  closeHref,
  today,
  run,
  canManage,
  canSettle,
}: Extract<NettingDrawerProps, { mode: "view" }>) {
  const t = useTranslations("intercompany");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reversalDate, setReversalDate] = useState(today);

  async function act(
    action: "submit" | "post" | "cancel" | "reverse",
    payload?: Record<string, unknown>,
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/intercompany/netting/${run.id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, t("errors.nettingFailed")));
        return;
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("errors.nettingFailed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    const reason = await promptDialog({
      title: t("netting.cancelTitle"),
      label: t("netting.cancelReason"),
    });
    if (reason) await act("cancel", { reason });
  }

  async function reverse() {
    const reason = await promptDialog({
      title: t("netting.reverseTitle"),
      label: t("netting.reverseReason"),
    });
    if (reason) await act("reverse", { reason, reversalDate });
  }

  const cancellable = ["proposed", "pending_approval", "approved"].includes(run.status);
  return (
    <UrlDrawer
      open
      openKey={run.id}
      closeHref={closeHref}
      size="xl"
      title={run.runNumber}
      description={`${run.asOfDate} · ${run.entities}`}
      headerActions={<Badge variant={run.statusVariant}>{run.statusLabel}</Badge>}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canManage && run.status === "proposed" ? (
            <Button disabled={busy} onClick={() => act("submit")}>
              {t("netting.submit")}
            </Button>
          ) : null}
          {canSettle && run.status === "approved" ? (
            <Button disabled={busy} onClick={() => act("post")}>
              {t("netting.post")}
            </Button>
          ) : null}
          {canSettle && run.status === "posted" ? (
            <>
              <DateField
                aria-label={t("netting.reversalDate")}
                className="w-40"
                value={reversalDate}
                onChange={(value) => setReversalDate(value)}
              />
              <Button variant="outline" disabled={busy} onClick={reverse}>
                {t("netting.reverse")}
              </Button>
            </>
          ) : null}
          {canManage && cancellable ? (
            <Button variant="ghost" disabled={busy} onClick={cancel}>
              {t("netting.cancel")}
            </Button>
          ) : null}
        </div>
      }
    >
      <ErrorNote message={error} />
      <dl className="mb-4 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("netting.settleCash")}</dt>
          <dd>{run.settleCash ? t("netting.cashYes") : t("netting.cashNo")}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500">{t("netting.reason")}</dt>
          <dd>{run.reason}</dd>
        </div>
        {run.decisionNote ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t("netting.decisionNote")}</dt>
            <dd>{run.decisionNote}</dd>
          </div>
        ) : null}
        {run.cancelReason ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t("netting.cancelReason")}</dt>
            <dd>{run.cancelReason}</dd>
          </div>
        ) : null}
        {run.reverseReason ? (
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">{t("netting.reverseReason")}</dt>
            <dd>
              {run.reversalDate} · {run.reverseReason}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3 sm:col-span-2">
          <dt className="text-slate-500">{t("netting.fingerprint")}</dt>
          <dd className="truncate font-mono text-xs">{run.fingerprint}</dd>
        </div>
      </dl>
      {run.warnings.length > 0 ? (
        <ul className="mb-4 list-disc space-y-1 rounded-lg bg-amber-50 py-2 pl-6 pr-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {run.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      <h3 className="mb-2 text-sm font-semibold">{t("netting.pairsTitle")}</h3>
      <PairTable rows={run.pairs} />
      <h3 className="mb-2 mt-6 text-sm font-semibold">{t("netting.linesTitle")}</h3>
      <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
        <Table
          containerClassName="overflow-visible rounded-none border-0 bg-transparent shadow-none"
          className="w-full"
        >
          <TableHeader className="bg-slate-50 text-xs text-slate-500 dark:bg-slate-900">
            <TableRow noAnimate>
              <TableHead className={`${CELL} text-left`}>
                {t("netting.lineColumns.component")}
              </TableHead>
              <TableHead className={`${CELL} text-left`}>
                {t("netting.lineColumns.entity")}
              </TableHead>
              <TableHead className={`${CELL} text-left`}>
                {t("netting.lineColumns.reference")}
              </TableHead>
              <TableHead className={`${CELL} text-right`}>
                {t("netting.lineColumns.open")}
              </TableHead>
              <TableHead className={`${CELL} text-right`}>
                {t("netting.lineColumns.netted")}
              </TableHead>
              <TableHead className={`${CELL} text-right`}>
                {t("netting.lineColumns.cash")}
              </TableHead>
              <TableHead className={`${CELL} text-right`}>
                {t("netting.lineColumns.rate")}
              </TableHead>
              <TableHead className={`${CELL} text-right`}>
                {t("netting.lineColumns.realizedFx")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.lines.map((line) => (
              <TableRow
                noAnimate
                key={line.key}
                className="border-t border-slate-100 dark:border-slate-800"
              >
                <TableCell className={CELL}>{line.component}</TableCell>
                <TableCell className={CELL}>
                  {line.entity} → {line.counterparty}
                </TableCell>
                <TableCell className={CELL}>
                  {line.href ? (
                    <Link className="underline-offset-2 hover:underline" href={line.href as never}>
                      {line.reference}
                    </Link>
                  ) : (
                    line.reference
                  )}
                </TableCell>
                <TableCell className={NUM}>{line.open}</TableCell>
                <TableCell className={NUM}>{line.netted}</TableCell>
                <TableCell className={NUM}>{line.cash}</TableCell>
                <TableCell className={NUM}>{line.rate}</TableCell>
                <TableCell className={NUM}>{line.realizedFx}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {run.entryHrefs.length > 0 ? (
        <p className="mt-4 flex flex-wrap gap-3 text-sm">
          {run.entryHrefs.map((href, index) => (
            <Link
              key={href}
              className="text-sky-700 underline-offset-2 hover:underline dark:text-sky-300"
              href={href as never}
            >
              {t("netting.entryLink", { number: String(index + 1) })}
            </Link>
          ))}
        </p>
      ) : null}
    </UrlDrawer>
  );
}
