"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useViewerFormat } from "../../../../../lib/viewer-format";
import { Badge, Button, Input, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { mergeHref } from "../../../../../lib/list-params";
import { usePeriodDrawerState } from "./close-setup-period-drawer-state";
import { BASE, Check, Field, MODULES, dataText, drawerHref } from "./close-setup-shared";
import type { BankingReconAccount, PeriodRow, Props } from "./close-setup-types";

/**
 * Each bank account's reconciliation status for the period being closed,
 * with the acknowledgement the close requires when any account is
 * unsigned or stale. Read-only: the server re-derives the same statuses
 * when the close posts.
 */
export function BankingReconPanel({
  accounts,
  unavailable,
  ack,
  onAck,
}: {
  accounts: BankingReconAccount[] | null;
  unavailable: boolean;
  ack: string;
  onAck: (value: string) => void;
}) {
  const t = useTranslations("close.setup");
  const issues = (accounts ?? []).filter(
    (account) => account.status !== "signed_off" || account.stale,
  );
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <h4 className="font-medium">{t("periods.bankingReconTitle")}</h4>
      {unavailable ? (
        <p className="text-sm text-slate-500">{t("periods.bankingReconUnavailable")}</p>
      ) : accounts === null ? (
        <p className="text-sm text-slate-500">…</p>
      ) : accounts.length === 0 ? (
        <p className="text-sm text-slate-500">{t("periods.bankingReconEmpty")}</p>
      ) : (
        <ul className="space-y-1">
          {accounts.map((account) => (
            <li key={account.accountId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">
                {[account.number, account.name].filter(Boolean).join(" ")}
              </span>
              <Badge
                variant={account.status === "signed_off" && !account.stale ? "success" : "warning"}
              >
                {account.status === "signed_off"
                  ? t("periods.bankingReconSignedOff")
                  : account.status === "in_progress"
                    ? t("periods.bankingReconInProgress")
                    : t("periods.bankingReconNone")}
              </Badge>
              {account.throughDate ? (
                <span className="text-xs text-slate-500">
                  {t("periods.bankingReconThrough", { date: account.throughDate })}
                </span>
              ) : null}
              {account.status === "in_progress" && account.difference ? (
                <span className="text-xs text-slate-500">
                  {t("periods.bankingReconDifference", { difference: account.difference })}
                </span>
              ) : null}
              {account.stale ? (
                <span className="text-xs text-amber-700 dark:text-amber-300">
                  {t("periods.bankingReconStale", {
                    date: account.staleSince ?? "",
                    effect: account.clearedEffect ?? "",
                  })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {issues.length > 0 ? (
        <Field label={t("periods.bankingReconAckLabel")}>
          <Textarea value={ack} onChange={(e) => onAck(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t("periods.bankingReconAckHint")}
          </p>
        </Field>
      ) : null}
    </div>
  );
}

export function PeriodDrawer({ row, props }: { row?: PeriodRow; props: Props }) {
  const viewerFormat = useViewerFormat();
  const {
    date,
    civilDate,
    t,
    td,
    router,
    closeHref,
    creating,
    selectedBook,
    calendarId,
    setCalendarId,
    year,
    setYear,
    action,
    setAction,
    reason,
    setReason,
    clearReason,
    includeGl,
    setIncludeGl,
    busy,
    actionError,
    generateError,
    closeAll,
    setCloseAll,
    closeAllReason,
    setCloseAllReason,
    bankingAck,
    setBankingAck,
    bankingStatus,
    closeArmed,
    setCloseArmed,
    bankingUnavailable,
    reopenPrefillEntity,
    reopenPrefillEntityName,
    closeAllOverrides,
    setCloseAllOverrides,
    closeAllResults,
    setCloseAllResults,
    endReasons,
    setEndReasons,
    generate,
    offerIncludeGl,
    bankingConfirmDetail,
    earlierOpenPeriods,
    actionCloses,
    confirmAction,
    applyCloseAll,
    endActiveWindow,
  } = usePeriodDrawerState(row, props);
  if (creating)
    return (
      <UrlDrawer
        open
        closeHref={closeHref}
        size="md"
        title={t("periods.generateTitle")}
        description={t("periods.generateDescription")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={() => router.push(closeHref)}>
              {t("actions.cancel")}
            </Button>
            <Button disabled={busy || !calendarId} onClick={generate}>
              {busy ? t("actions.saving") : t("actions.generate")}
            </Button>
          </div>
        }
      >
        <div className="space-y-4 p-1">
          {generateError ? (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            >
              {generateError}
            </p>
          ) : null}
          <Field label={t("fields.calendar")}>
            <Select value={calendarId} onChange={(e) => setCalendarId(e.target.value)}>
              {props.calendarOptions
                .filter((item) => item.is_active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {dataText(td, item.name)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t("fields.fiscalYear")}>
            <Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} />
          </Field>
        </div>
      </UrlDrawer>
    );
  if (!row) return null;
  // Pending reopen requests for this period+book, from the already-loaded
  // setup-page list: without them the drawer invites blind
  // duplicate requests and the requester sees no pending state.
  const pendingReopen = (props.liveReopenRequests ?? props.reopenRequests ?? []).filter(
    (item) =>
      item.period_id === row.id &&
      item.book_id === (selectedBook?.id ?? null) &&
      item.status === "requested",
  );
  // Approved windows still open on this period+book, from the same
  // already-loaded setup-page list: a stale window whose modules were all
  // re-closed reads approved here with no other user path to end it
  // (a closed module row offers only Reopen), so the row offers End
  // directly beside the pending requests.
  const activeReopen = (props.liveReopenRequests ?? props.reopenRequests ?? []).filter(
    (item) =>
      item.period_id === row.id &&
      item.book_id === (selectedBook?.id ?? null) &&
      item.status === "approved",
  );
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="lg"
      title={row.name}
      description={`${civilDate(row.starts_on)} → ${civilDate(row.ends_on)} · ${selectedBook?.name ?? ""}`}
    >
      <div className="space-y-5 p-1">
        {actionError ? (
          <p role="alert" className="text-sm text-red-600">
            {actionError}
          </p>
        ) : null}
        {MODULES.some((module) => (row.locks?.[module]?.state ?? "open") !== "closed") ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setCloseAll(true);
                setCloseAllResults(null);
              }}
            >
              {t("actions.closeAll")}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2">
          {MODULES.map((module) => {
            const lock = row.locks?.[module];
            const state = lock?.state ?? "open";
            return (
              <div
                key={module}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t(`modules.${module}`)}</span>
                    <Badge
                      variant={
                        state === "closed"
                          ? "success"
                          : state === "soft_closed"
                            ? "warning"
                            : "outline"
                      }
                    >
                      {t(`states.${state}`)}
                    </Badge>
                  </div>
                  {lock?.lockedAt ? (
                    <p className="mt-1 text-xs text-slate-500">
                      {t("periods.lockedOn", {
                        date: date(new Date(lock.lockedAt)),
                      })}
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-1">
                  {state === "open" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAction({ module, state: "soft_closed" })}
                    >
                      {t("actions.softClose")}
                    </Button>
                  ) : null}
                  {state === "soft_closed" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAction({ module, state: "open" })}
                    >
                      {t("actions.unlock")}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={state === "closed" ? "outline" : "default"}
                    disabled={state === "closed" && !props.canReopen}
                    onClick={() =>
                      setAction({
                        module,
                        state: state === "closed" ? "reopen" : "closed",
                      })
                    }
                  >
                    {state === "closed" ? t("actions.reopen") : t("actions.close")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {closeAll ? (
          <div className="space-y-3 rounded-lg border border-teal-300 bg-teal-50/50 p-4 dark:border-teal-800 dark:bg-teal-950/20">
            <div>
              <h4 className="font-medium">{t("periods.closeAllTitle")}</h4>
              <p className="text-sm text-slate-500">
                {t("periods.closeAllDescription", { period: row.name })}
              </p>
            </div>
            <Field label={t("fields.reason")}>
              <Textarea
                value={closeAllReason}
                onChange={(e) => setCloseAllReason(e.target.value)}
              />
            </Field>
            <div className="space-y-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("periods.closeAllOverrideHint")}
              </p>
              {MODULES.map((module) => (
                <Field key={module} label={t(`modules.${module}`)}>
                  <Input
                    value={closeAllOverrides[module] ?? ""}
                    onChange={(e) =>
                      setCloseAllOverrides((prev) => ({ ...prev, [module]: e.target.value }))
                    }
                  />
                </Field>
              ))}
            </div>
            <BankingReconPanel
              accounts={bankingStatus?.accounts ?? null}
              unavailable={bankingUnavailable}
              ack={bankingAck}
              onAck={setBankingAck}
            />
            {closeAllResults ? (
              <ul className="space-y-1">
                {closeAllResults.map((result) => (
                  <li key={result.module} className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={result.ok ? "success" : "outline"}>
                      {t(`modules.${result.module}`)}
                    </Badge>
                    {!result.ok && result.error ? (
                      <span className="text-red-600 dark:text-red-400">{result.error}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setCloseAll(false);
                  setCloseAllReason("");
                  setCloseAllOverrides({});
                  setCloseAllResults(null);
                  setBankingAck("");
                }}
              >
                {t("actions.cancel")}
              </Button>
              <Button disabled={busy || !closeAllReason.trim()} onClick={applyCloseAll}>
                {t("actions.confirmClose")}
              </Button>
            </div>
          </div>
        ) : null}
        {pendingReopen.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t("periods.reopenRequests")}
            </h4>
            {pendingReopen.map((item) => (
              <Link
                key={item.id}
                href={mergeHref(BASE, props.currentParams, {
                  tab: "periods",
                  period: null,
                  reopen: item.id,
                })}
                className="block rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-800 dark:bg-amber-950/20"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="warning">{t("reopenStates.requested")}</Badge>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {(item.modules ?? [])
                      .map((module) => t(`modules.${String(module)}`))
                      .join(", ")}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{item.reason}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {t("periods.requestedBy", { name: item.requester_name })}
                </p>
              </Link>
            ))}
          </div>
        ) : null}
        {activeReopen.length > 0 && props.canReopen ? (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t("periods.activeReopenWindows")}
            </h4>
            {activeReopen.map((item) => {
              const windowReason = endReasons[item.id] ?? "";
              return (
                <div
                  key={item.id}
                  className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="success">{t("reopenStates.approved")}</Badge>
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {(item.modules ?? [])
                        .map((module) => t(`modules.${String(module)}`))
                        .join(", ")}
                    </span>
                  </div>
                  {typeof item.expires_at === "string" ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {t("periods.reopenActiveUntil", {
                        date: viewerFormat.dateTime(new Date(item.expires_at)),
                      })}
                    </p>
                  ) : null}
                  <Field label={t("fields.reason")}>
                    <Textarea
                      value={windowReason}
                      onChange={(e) =>
                        setEndReasons((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                    />
                  </Field>
                  <div className="flex justify-end gap-2">
                    {/* The window drawer creates a request for an approver to decide. */}
                    <Link
                      href={drawerHref(props.currentParams, "periods", "reopen", item.id)}
                      className="inline-flex h-8 items-center rounded-md border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                      {t("periods.extendReopenTitle")}
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || windowReason.trim().length < 10}
                      onClick={() => endActiveWindow(item.id)}
                    >
                      {t("actions.endReopen")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {action ? (
          <div className="space-y-3 rounded-lg border border-teal-300 bg-teal-50/50 p-4 dark:border-teal-800 dark:bg-teal-950/20">
            <div>
              <h4 className="font-medium">
                {action.state === "reopen"
                  ? t("periods.reopenTitle")
                  : action.state === "open"
                    ? t("periods.unlockTitle")
                    : t("periods.lockTitle")}
              </h4>
              <p className="text-sm text-slate-500">
                {t("periods.lockDescription", {
                  period: row.name,
                  module: t(`modules.${action.module}`),
                })}
              </p>
              {action.state === "reopen" && reopenPrefillEntity ? (
                <p className="mt-1 text-sm text-slate-500">
                  {t("periods.reopenEntity", {
                    name: reopenPrefillEntityName ?? reopenPrefillEntity,
                  })}
                </p>
              ) : null}
            </div>
            <Field label={t("fields.reason")}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            {action.module === "banking" &&
            (action.state === "closed" || action.state === "soft_closed") ? (
              <BankingReconPanel
                accounts={bankingStatus?.accounts ?? null}
                unavailable={bankingUnavailable}
                ack={bankingAck}
                onAck={setBankingAck}
              />
            ) : null}
            {offerIncludeGl ? (
              <Check checked={includeGl} onChange={(value) => setIncludeGl(value)}>
                {t("periods.reopenIncludeGl")}
              </Check>
            ) : null}
            {actionCloses && closeArmed ? (
              <div
                role="alertdialog"
                aria-label={t("periods.closeConfirmTitle", {
                  module: t(`modules.${action.module}`),
                  period: row.name,
                })}
                className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40"
              >
                <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  {t("periods.closeConfirmTitle", {
                    module: t(`modules.${action.module}`),
                    period: row.name,
                  })}
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  {t("periods.closeConfirmBody", {
                    module: t(`modules.${action.module}`),
                  })}
                </p>
                {bankingConfirmDetail ? (
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    {bankingConfirmDetail}
                  </p>
                ) : null}
                {earlierOpenPeriods.length > 0 ? (
                  <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                    {t("periods.earlierOpenWarning", {
                      module: t(`modules.${action.module}`),
                      count: earlierOpenPeriods.length,
                      periods:
                        earlierOpenPeriods.slice(0, 4).join(", ") +
                        (earlierOpenPeriods.length > 4 ? ", …" : ""),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  if (closeArmed) {
                    setCloseArmed(false);
                    return;
                  }
                  const cancelledModule = action?.module;
                  setAction(null);
                  if (cancelledModule) clearReason(cancelledModule);
                  setIncludeGl(true);
                  setBankingAck("");
                }}
              >
                {closeArmed ? t("actions.back") : t("actions.cancel")}
              </Button>
              <Button disabled={busy || !reason.trim()} onClick={confirmAction}>
                {action.state === "reopen"
                  ? t("actions.requestReopen")
                  : action.state === "open"
                    ? t("actions.unlock")
                    : closeArmed
                      ? t("actions.confirmClose")
                      : t("actions.reviewClose")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
