import "server-only";
import { db } from "@openbooks/engine/platform/db";
import {
  AccountingContextError,
  BASE_CHART_CONTEXT,
  compareAccountLabels,
  listAccountingContexts,
  loadAccountLabels,
  resolveAccountingContext,
  type AccountLabel,
} from "@openbooks/engine/chart/accounting-contexts";

/**
 * Reports under an accounting context: the `ctx` request parameter names a
 * context, the base chart (`base`), or nothing (the reported subsidiary's
 * default context, else the base chart). Every renderer of a report — the
 * screen, PDF, spreadsheet and CSV exports and scheduled runs — relabels its
 * account rows through the same functions, so they always agree.
 *
 * Accounts with no localization in the context keep their base number and
 * name, explicitly marked with BASE_CHART_MARKER; the report states what the
 * marker means. A context whose localized numbers collide refuses instead
 * of merging or reordering rows silently.
 */

export const ACCOUNTING_CONTEXT_PARAM = "ctx";
/** Marks an account shown under its base chart label because the context has no localization for it. */
export const BASE_CHART_MARKER = "†";

export type AccountLabels = ReadonlyMap<string, AccountLabel>;

export interface ReportAccountingContext {
  /** The requested parameter value, echoed for the filter control. */
  requested: string;
  contextId: string | null;
  contextName: string | null;
  source: "requested" | "subsidiary" | "country" | "base";
  labels: AccountLabels | null;
  options: { id: string; code: string; name: string }[];
}

export { AccountingContextError };

/** Resolve the context and its account labels for one report run. */
export async function reportAccountingContext(
  orgId: string,
  requested: string | null | undefined,
  scope: { asOf: string; subsidiaryId?: string | null },
): Promise<ReportAccountingContext> {
  const value = requested?.trim() ?? "";
  const [options, resolved] = await Promise.all([
    listAccountingContexts(db, orgId),
    resolveAccountingContext(db, orgId, {
      requested: value || null,
      subsidiaryId: scope.subsidiaryId ?? null,
    }),
  ]);
  const labels = resolved.context
    ? await loadAccountLabels(db, orgId, resolved.context, {
        asOf: scope.asOf,
        subsidiaryId: scope.subsidiaryId ?? null,
      })
    : null;
  return {
    requested: value,
    contextId: resolved.context?.id ?? null,
    contextName: resolved.context?.name ?? null,
    source: resolved.source,
    labels,
    options: options.map((option) => ({ id: option.id, code: option.code, name: option.name })),
  };
}

/** One account row under the context's labels; rows the context does not know pass through. */
export function labelAccountRow<T extends { id: string; number: string | null; name: string }>(
  row: T,
  labels: AccountLabels | null | undefined,
): T {
  const label = labels?.get(row.id);
  if (!label) return row;
  const relabelled: T = {
    ...row,
    number: label.number,
    name: label.localized ? label.name : `${label.name} ${BASE_CHART_MARKER}`,
  };
  return relabelled;
}

/** Relabel account rows and order them by their labels (number, then name). */
export function localizeAccountRows<T extends { id: string; number: string | null; name: string }>(
  rows: readonly T[],
  labels: AccountLabels | null | undefined,
): T[] {
  if (!labels) return [...rows];
  return rows
    .map((row) => labelAccountRow(row, labels))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => compareAccountLabels(a.row, b.row) || a.index - b.index)
    .map(({ row }) => row);
}

type Translate = (key: string, values?: Record<string, string>) => string;

/** The filter-bar select for a report, or null while no context exists. */
export function accountingContextFilter(
  context: ReportAccountingContext,
  t: Translate,
): {
  paramKey: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
} | null {
  if (context.options.length === 0 && !context.requested) return null;
  return {
    paramKey: ACCOUNTING_CONTEXT_PARAM,
    label: t("accountingContext.label"),
    value: context.requested,
    options: [
      { value: "", label: t("accountingContext.default") },
      { value: BASE_CHART_CONTEXT, label: t("accountingContext.base") },
      ...context.options.map((option) => ({ value: option.id, label: option.name })),
    ],
  };
}

/** The sentence a report prints under its title while a context applies. */
export function accountingContextLegend(
  context: ReportAccountingContext,
  t: Translate,
): string | null {
  if (!context.contextName) return null;
  return t("accountingContext.legend", { context: context.contextName, marker: BASE_CHART_MARKER });
}
