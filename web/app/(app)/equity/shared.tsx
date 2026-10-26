"use client";

import { useCallback, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Button, EmptyState } from "@openbooks/ui";
import type { PendingRequest } from "@openbooks/engine/equity";
import {
  APPROVALS_HOME_HREF,
  APPROVALS_SUBMITTED_HREF,
} from "@openbooks/engine/navigation/approvals-home";
import { normalizeDecimal, roundMoney } from "@openbooks/engine/money";
import { fetchAppAction } from "@/lib/api-error";
import { formatCivilDate, formatExactPercent } from "@/lib/format";
import { formatDecimal } from "@/lib/money-format";
import { promptDialog } from "@/lib/prompt";
import { useAppAction } from "@/lib/use-app-action";
import { useMoney } from "@/components/money-provider";
import { equityHref, type EquityListSort } from "@/lib/equity-url";
import { perShareFormatOptions } from "@/lib/equity-price";

export const CELL = "px-4 py-2.5";
export const HEAD = "px-4 py-2 font-medium whitespace-nowrap";
export const NUM_HEAD = `${HEAD} text-right`;
/** Numbers never wrap inside a narrow column. */
export const NUM_CELL = `${CELL} text-right tabular-nums whitespace-nowrap`;
/** Dates never wrap inside a narrow column. */
export const DATE_CELL = `${CELL} tabular-nums whitespace-nowrap`;
export const LINK = "font-medium text-teal-700 hover:underline dark:text-teal-300";
/** A totals row after a table's records, the house totals composition. */
export const TOTAL_ROW =
  "border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-950/40";

export const STATUS_VARIANT: Record<
  string,
  "success" | "secondary" | "warning" | "outline" | "destructive"
> = {
  outstanding: "success",
  exercised: "secondary",
  settled: "secondary",
  converted: "secondary",
  transferred: "secondary",
  forfeited: "warning",
  expired: "warning",
  cancelled: "warning",
  repurchased: "outline",
  repaid: "secondary",
  void: "destructive",
  not_issued: "outline",
};

/** Whole-share counts are bigint strings; they are formatted without crossing a float. */
export function useShares(): (value: string | null | undefined) => string {
  const locale = useLocale();
  return (value) => {
    if (value === null || value === undefined || !/^-?\d+$/.test(value)) return "—";
    return new Intl.NumberFormat(locale).format(BigInt(value));
  };
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** A per-share value in a currency, under the one per-share precision rule. */
export function usePrice(): (value: string | null | undefined, currency?: string) => string {
  const { money } = useMoney();
  return (value, currency) => {
    if (!value || !DECIMAL.test(value)) return "—";
    return money(value, { currency, ...perShareFormatOptions(value) });
  };
}

/** A multiple or other plain decimal (1×, 1.5×), trimmed for reading. */
export function useDecimal(): (value: string | null | undefined) => string {
  const locale = useLocale();
  return (value) =>
    value && DECIMAL.test(value)
      ? formatDecimal(locale, value, { minimumFractionDigits: 0, maximumFractionDigits: 4 })
      : "—";
}

/** A stored percentage (`53.6481` for 53.6481%) in the viewer's locale, to two places. */
export function usePercent(): (
  value: string | null | undefined,
  fractionDigits?: number,
) => string {
  const locale = useLocale();
  return (value, fractionDigits = 2) => {
    if (!value || !DECIMAL.test(value)) return "—";
    return formatExactPercent(
      normalizeDecimal(roundMoney(value, fractionDigits), fractionDigits),
      locale,
      fractionDigits,
    );
  };
}

/** A civil date (YYYY-MM-DD) as the native medium date in the viewer's locale. */
export function useCivilDate(): (value: string | null | undefined) => string {
  const locale = useLocale();
  return (value) =>
    value && /^\d{4}-\d{2}-\d{2}/.test(value) ? formatCivilDate(value, locale) : "—";
}

export function searchText(row: object): string {
  return Object.values(row)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
}

/**
 * POST a command as JSON through the app's action read: never throws, and a
 * refusal keeps the server's message, remedy and code for the pinned alert.
 */
export function postCommand<T>(
  url: string,
  body: unknown,
  fallback: string,
): Promise<ActionResult<T>> {
  return fetchAppAction<T>(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    { fallback },
  );
}

/** A refusal pinned beside the form it blocks until the next attempt (the house action-error path). */
export function CommandRefusal({
  refusal,
  fallback,
}: {
  refusal: Parameters<typeof ActionAlert>[0]["error"];
  fallback: string;
}) {
  return <ActionAlert error={refusal} fallbackMessage={fallback} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** A form's alternative modes inside a drawer: buttons that switch which fields show. */
export function SegmentTabs<T extends string>({
  value,
  onChange,
  tabs,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: { key: T; label: string }[];
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={
            value === tab.key
              ? "rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900"
              : "rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** A link within the workspace: the current parameters with the overrides, less the list state of another view. */
export function withParams(
  base: string,
  params: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  return equityHref(base, params, overrides);
}

/** The sortable headers of a view's list: the URL's sort, or the list's natural order. */
export function listSort(context: {
  params: Record<string, string | string[] | undefined>;
  list: EquityListSort;
}) {
  return {
    basePath: "/equity",
    currentParams: context.params,
    sort: context.list.sort,
    dir: context.list.dir,
  };
}

/** A governed command's answer: applied now, or held by an Equity action Flow for approval. */
export function isPendingApproval(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "pending_approval"
  );
}

/**
 * Governed actions held by an Equity action Flow for a decision, shown where
 * they apply until an approver decides them in the Inbox. The requester can
 * withdraw their own request here, with a reason. Nothing renders when none
 * is pending.
 */
export function PendingActions({
  context,
  filter,
}: {
  context: { pending: readonly PendingRequest[]; actorId: string };
  filter?: (request: PendingRequest) => boolean;
}) {
  const t = useTranslations("equity");
  const tc = useTranslations("common");
  const date = useCivilDate();
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  const rows = filter ? context.pending.filter(filter) : context.pending;
  const withdraw = useCallback(
    async (request: PendingRequest) => {
      const reason = await promptDialog({
        title: tc("approvalFlow.withdrawTitle"),
        label: tc("approvalFlow.withdrawReasonLabel"),
        confirmLabel: tc("actions.withdrawSubmission"),
      });
      if (!reason) return;
      await execute(
        () =>
          postCommand(
            `/api/equity/requests/${request.id}/withdraw`,
            { reason },
            t("approval.withdrawFailed"),
          ),
        {
          fallbackMessage: t("approval.withdrawFailed"),
          successMessage: t("approval.withdrawn"),
          onOk: () => router.refresh(),
        },
      );
    },
    [execute, router, t, tc],
  );
  if (rows.length === 0) return null;
  const own = rows.some((row) => row.requestedBy === context.actorId);
  return (
    <section
      className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"
      aria-label={t("approval.pendingTitle")}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-semibold text-amber-900 dark:text-amber-200">
          {t("approval.pendingTitle")}
        </h3>
        <Link className={LINK} href={own ? APPROVALS_SUBMITTED_HREF : APPROVALS_HOME_HREF}>
          {t("approval.openApprovals")}
        </Link>
      </div>
      <ul className="space-y-1 text-amber-900 dark:text-amber-100">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t("approval.pendingItem", {
                action: t(`approval.action.${row.action}`),
                subject: row.subjectLabel,
                date: date(row.effectiveOn),
                requester: row.requestedByName ?? t("approval.unknownRequester"),
              })}
            </span>
            {row.requestedBy === context.actorId && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void withdraw(row)}
              >
                {tc("actions.withdrawSubmission")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ActionAlert error={refusal} fallbackMessage={t("approval.withdrawFailed")} />
    </section>
  );
}

/** A governed command's success: applied now, or submitted to its Flow for a decision. */
export function toastGoverned(result: unknown, applied: string, submitted: string): void {
  toast.success(isPendingApproval(result) ? submitted : applied);
}

/** A named refusal in place of the body it blocks: the message, its remedy and, when one exists, the place to fix it. */
export function Refusal({
  refusal,
  action,
}: {
  refusal: { message: string; remedy: string };
  action?: { href: string; label: string } | null;
}) {
  return (
    <EmptyState
      icon={<AlertTriangle />}
      title={refusal.message}
      description={refusal.remedy}
      action={
        action ? (
          <Button asChild variant="outline">
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : undefined
      }
    />
  );
}

/** The legal entity has no equity account policy in force, so nothing posts until one is set up. */
export function PolicyBanner({ href }: { href: string }) {
  const t = useTranslations("equity");
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      {t("policy.missing")}{" "}
      <Link href={href} className="font-medium underline">
        {t("policy.setup")}
      </Link>
    </div>
  );
}

/** A report a view links to, in the toolbar's trailing actions. */
export function OpenReport({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{label}</Link>
    </Button>
  );
}
