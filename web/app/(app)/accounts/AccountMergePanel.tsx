"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Label,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@openbooks/ui";
import { ApiResponseError, apiJson } from "../../../lib/api-error";
import { DateField } from "../../../components/date-field";

type Option = { value: string; label: string };

/** The engine preview, as the merge route answers it. */
export interface AccountMergePreviewData {
  effectiveDate: string;
  balanceFrom: string | null;
  refusals: { code: string; message: string; remedy: string }[];
  balances: {
    bookName: string;
    subsidiaryName: string;
    currency: string;
    functionalCurrency: string;
    amount: string;
    txnAmount: string;
    fxRate: string | null;
    balanceFrom: string | null;
  }[];
  entries: {
    bookId: string;
    subsidiaryId: string;
    bookName: string;
    subsidiaryName: string;
    lines: number;
  }[];
  references: {
    key: string;
    label: string;
    redirect: number;
    history: number;
    blocked: number;
  }[];
  children: { id: string; number: string | null; name: string }[];
  draftJournalLines: number;
  controlRoles: { scope: string; role: string; label: string }[];
  pendingChangeId: string | null;
  digest: string;
}

type MergeOutcome =
  | {
      status: "completed";
      mergeId: string;
      replayed: boolean;
      entryIds: string[];
    }
  | { status: "pending_approval"; changeId: string; replayed: boolean };

const sectionTitle = "text-sm font-semibold text-slate-900 dark:text-slate-100";

/**
 * Merge this account into a surviving account: choose the survivor and the
 * effective date, review the preview (refusals first, then every
 * consequence), record a reason, and confirm exactly what was previewed.
 * Rendered inside the account drawer, which stays the one shell for the
 * whole flow.
 */
export function AccountMergePanel({
  accountId,
  accountLabel,
  targets,
  today,
  onDone,
}: {
  accountId: string;
  accountLabel: string;
  targets: Option[];
  today: string;
  onDone: () => void;
}) {
  const t = useTranslations("accounts");
  const tc = useTranslations("common");
  const router = useRouter();
  const fieldId = useId();
  const [target, setTarget] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<AccountMergePreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request key per confirmed merge: a retried click returns the same merge.
  const requestKey = useRef<string | null>(null);

  const targetLabel = targets.find((option) => option.value === target)?.label ?? "";

  async function runPreview() {
    if (!target || !effectiveDate) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    requestKey.current = null;
    try {
      const query = new URLSearchParams({ target, date: effectiveDate });
      setPreview(
        await apiJson<AccountMergePreviewData>(
          `/api/accounts/${accountId}/merge?${query.toString()}`,
          undefined,
          t("merge.failed"),
        ),
      );
    } catch (failure) {
      setError(failure instanceof ApiResponseError ? failure.message : t("merge.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview || preview.refusals.length > 0 || reason.trim().length < 8) return;
    setBusy(true);
    setError(null);
    requestKey.current ??= crypto.randomUUID();
    try {
      const outcome = await apiJson<MergeOutcome>(
        `/api/accounts/${accountId}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetAccountId: target,
            effectiveDate,
            reason: reason.trim(),
            expectedDigest: preview.digest,
            idempotencyKey: requestKey.current,
          }),
        },
        t("merge.failed"),
      );
      toast.success(outcome.status === "completed" ? t("merge.merged") : t("merge.submitted"));
      router.refresh();
      onDone();
    } catch (failure) {
      const message = failure instanceof ApiResponseError ? failure.message : t("merge.failed");
      setError(message);
      toast.error(message);
      // A changed preview is refreshed so the operator confirms current consequences.
      if (failure instanceof ApiResponseError && failure.code === "account_merge_preview_changed")
        void runPreview();
    } finally {
      setBusy(false);
    }
  }

  const blocked = Boolean(preview && preview.refusals.length > 0);

  return (
    <div className="space-y-6 p-1">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {t("merge.intro", { account: accountLabel })}
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
        >
          {error}
        </p>
      ) : null}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`${fieldId}-target`}>{t("merge.target")}</Label>
          <SearchSelect
            id={`${fieldId}-target`}
            value={target}
            onChange={(value) => {
              setTarget(value);
              setPreview(null);
            }}
            options={targets}
            ariaLabel={t("merge.target")}
            placeholder={t("merge.chooseTarget")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-date`}>{t("merge.effectiveDate")}</Label>
          <DateField
            id={`${fieldId}-date`}
            value={effectiveDate}
            max={today}
            onChange={(value) => {
              setEffectiveDate(value);
              setPreview(null);
            }}
          />
        </div>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={onDone}>
          {t("merge.back")}
        </Button>
        <Button disabled={busy || !target || !effectiveDate} onClick={() => void runPreview()}>
          {busy && !preview ? t("merge.previewing") : t("merge.preview")}
        </Button>
      </div>

      {preview ? (
        <div className="space-y-6">
          {preview.pendingChangeId ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
              {t("merge.pendingNotice")}
            </p>
          ) : null}
          {blocked ? (
            <section className="space-y-2" aria-live="polite">
              <h3 className={sectionTitle}>{t("merge.refusalsTitle")}</h3>
              <ul className="space-y-2">
                {preview.refusals.map((refusal, index) => (
                  <li
                    key={`${refusal.code}-${index}`}
                    className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm dark:border-red-900 dark:bg-red-950/40"
                  >
                    <p className="text-red-800 dark:text-red-300">{refusal.message}</p>
                    <p className="mt-1 text-red-700/80 dark:text-red-300/80">{refusal.remedy}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              {t("merge.noRefusals", { target: targetLabel })}
            </p>
          )}

          <section className="space-y-2">
            <h3 className={sectionTitle}>{t("merge.balancesTitle")}</h3>
            {preview.balanceFrom ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("merge.balanceFrom", { date: preview.balanceFrom })}
              </p>
            ) : null}
            {preview.balances.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("merge.balancesEmpty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("merge.columns.book")}</TableHead>
                    <TableHead>{tc("labels.subsidiary")}</TableHead>
                    <TableHead>{t("merge.columns.currency")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.transaction")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.functional")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.rate")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.balances.map((row, index) => (
                    <TableRow key={index}>
                      <TableCell>{row.bookName}</TableCell>
                      <TableCell>
                        <div>{row.subsidiaryName}</div>
                        {!preview.balanceFrom && row.balanceFrom ? (
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {t("merge.balanceFrom", { date: row.balanceFrom })}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>{row.currency}</TableCell>
                      <TableCell className="text-right font-mono">{row.txnAmount}</TableCell>
                      <TableCell className="text-right font-mono">
                        {row.amount} {row.functionalCurrency}
                      </TableCell>
                      <TableCell className="text-right font-mono">{row.fxRate ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {preview.entries.length > 0 ? (
              <ul className="text-xs text-slate-500 dark:text-slate-400">
                {preview.entries.map((entry) => (
                  <li key={`${entry.bookId}-${entry.subsidiaryId}`}>
                    {t("merge.entryLine", {
                      book: entry.bookName,
                      subsidiary: entry.subsidiaryName,
                      lines: entry.lines,
                      date: preview.effectiveDate,
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className={sectionTitle}>{t("merge.referencesTitle")}</h3>
            {preview.references.length === 0 && preview.draftJournalLines === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t("merge.referencesEmpty")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("merge.columns.reference")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.moves")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.stays")}</TableHead>
                    <TableHead className="text-right">{t("merge.columns.blocks")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.references.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>{row.label}</TableCell>
                      <TableCell className="text-right">{row.redirect}</TableCell>
                      <TableCell className="text-right">{row.history}</TableCell>
                      <TableCell className="text-right">
                        {row.blocked > 0 ? <Badge variant="destructive">{row.blocked}</Badge> : 0}
                      </TableCell>
                    </TableRow>
                  ))}
                  {preview.draftJournalLines > 0 ? (
                    <TableRow>
                      <TableCell>{t("merge.draftLines")}</TableCell>
                      <TableCell className="text-right">{preview.draftJournalLines}</TableCell>
                      <TableCell className="text-right">0</TableCell>
                      <TableCell className="text-right">0</TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            )}
          </section>

          {preview.children.length > 0 ? (
            <section className="space-y-2">
              <h3 className={sectionTitle}>{t("merge.childrenTitle")}</h3>
              <ul className="list-disc pl-5 text-sm">
                {preview.children.map((child) => (
                  <li key={child.id}>{`${child.number ?? ""} ${child.name}`.trim()}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {preview.controlRoles.length > 0 ? (
            <section className="space-y-2">
              <h3 className={sectionTitle}>{t("merge.controlRolesTitle")}</h3>
              <ul className="list-disc pl-5 text-sm">
                {preview.controlRoles.map((role) => (
                  <li key={`${role.scope}-${role.role}`}>{`${role.label} · ${role.scope}`}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {!blocked && !preview.pendingChangeId ? (
            <section className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-reason`}>
                  {t("merge.reason")}
                  <span className="text-red-500"> *</span>
                </Label>
                <Textarea
                  id={`${fieldId}-reason`}
                  rows={3}
                  value={reason}
                  maxLength={1000}
                  onChange={(event) => setReason(event.target.value)}
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t("merge.reasonHint")}
                </p>
              </div>
              <Button disabled={busy || reason.trim().length < 8} onClick={() => void confirm()}>
                {busy ? t("merge.merging") : t("merge.submit")}
              </Button>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
