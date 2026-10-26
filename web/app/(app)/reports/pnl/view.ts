import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams, reportPeriodLabel } from "../../../../lib/format";
import { ref, textBlock, widgetBlock, type PageSpec } from "@braedonsaunders/appkit-viewspec";
import { dimensionOptions } from "../../../../lib/reports";
import { orgInfo } from "../../../../lib/data";
import { resolveOrgId } from "../../../../lib/org-scope";
import { reportBookSelection } from "../../../../lib/report-books";
import {
  MissingRatesError,
  reportSubsidiaryView,
  historicalTranslationBlockedNotice,
  statementTranslationBlockedAction,
  type StatementTranslationBlockedNotice,
} from "../../../../lib/consolidation";
import { profitAndLossView } from "../../../../lib/statement-matrix";
import { resolvePeriod, type ResolvedPeriod } from "../../../../lib/periods";
import {
  IncompleteReportPeriodError,
  parseReportQuery,
  scaleFactor,
} from "../../../../lib/report-filters";
import { reportScheduleAnchor, scheduleParamsFrom } from "../../../../lib/report-schedule-anchor";
import { getAuthz } from "@/lib/authz";
import { dimensionOptionsScope } from "../../../../lib/reports/filters";
import { statementReportSpec, stringReportParams } from "@/lib/reports/statement-report-spec";
import {
  AccountingContextError,
  accountingContextFilter,
  accountingContextLegend,
  reportAccountingContext,
  type ReportAccountingContext,
} from "../../../../lib/reports/accounting-context";

/**
 * The profit-and-loss statement, split into a loader and a spec.
 *
 * The interesting part of this conversion is what does NOT get decomposed.
 * `StatementMatrixTable` owns variance percentages, scale divisors,
 * hierarchical line rendering and its own drill construction; expressing it as
 * generic `table` columns would reimplement it, badly. It stays whole and the
 * spec places it by name as a `widget` block. ViewSpec composes pages; it does
 * not re-derive components.
 *
 * Everything time-, permission- and money-dependent — period resolution, book
 * and subsidiary selection, the statement query, the composed description
 * string — stays in the loader below.
 */

type StatementView = Awaited<ReturnType<typeof profitAndLossView>>;
type DimensionOptions = Awaited<ReturnType<typeof dimensionOptions>>;
type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>["picker"];

export interface PnlData {
  title: string;
  description: string;
  backHref: string;
  backLabel: string;
  hubLabel: string;
  company: string;
  periodPhrase: string;
  note: string;
  wide: boolean;
  truncated: boolean;
  truncatedLabel: string;
  /** Set when translation prerequisites block the statement:
   * the native banner directs the operator to rates or retained source evidence. */
  ratesBlocked: StatementTranslationBlockedNotice | null;
  /** Set when the custom period has no valid From/To: the page names the
   * remedy in the filter bar instead of widening to another window. */
  periodRefusal: string | null;
  /** Title of the period refusal notice: the filter bar's own label. */
  filterPeriodLabel: string;
  /** False when ratesBlocked or periodRefusal is set; the paper hides with it. */
  ratesReady: boolean;
  /** Null when ratesBlocked or periodRefusal is set; never rendered then. */
  view: StatementView | null;
  scale: string;
  currency: string | undefined;
  drill: {
    dims: ReturnType<typeof parseReportQuery>["dims"];
    basis: ReturnType<typeof parseReportQuery>["basis"];
    subsidiaryId?: string;
    bookId?: string;
  };
  dimensions: DimensionOptions;
  subsidiaries: SubsidiaryPicker;
  /** Book (more than one book) and accounting context (when contexts exist). */
  primaryFilter:
    | {
        paramKey: string;
        label: string;
        value: string;
        options: { value: string; label: string }[];
      }[]
    | null;
  /** Set when the requested accounting context cannot label the accounts. */
  contextBlocked: { title: string; description: string } | null;
  scheduleDefId: string | null;
  scheduleParams: Record<string, string>;
  exportParams: Record<string, string>;
}

export async function loadPnl(sp: Record<string, string | undefined>): Promise<PnlData> {
  const t = await getTranslations("reports");
  const locale = await getLocale();
  // The book label reuses the budgets list's existing filter copy.
  const tb = await getTranslations("budgets");
  const scheduleDefId = await reportScheduleAnchor("pnl");
  const q = parseReportQuery(sp);
  let period: ResolvedPeriod | null = null;
  let periodRefusal: string | null = null;
  try {
    period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to });
  } catch (e) {
    if (!(e instanceof IncompleteReportPeriodError)) throw e;
    periodRefusal = e.message;
  }

  const labels = {
    revenue: t("pnl.revenue"),
    costOfGoodsSold: t("pnl.costOfGoodsSold"),
    grossProfit: t("pnl.grossProfit"),
    expenses: t("pnl.expenses"),
    netIncome: t("pnl.netIncome"),
    totalOf: (section: string) => t("statement.sectionTotal", { section }),
  };

  const orgId = await resolveOrgId();
  const { books, selectedBook } = await reportBookSelection(orgId, sp.book);
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined;
  let view: StatementView | null = null;
  let ratesBlocked: StatementTranslationBlockedNotice | null = null;
  let accountingContext: ReportAccountingContext | null = null;
  let contextBlocked: PnlData["contextBlocked"] = null;
  if (period) {
    try {
      accountingContext = await reportAccountingContext(orgId, sp.ctx, {
        asOf: period.to,
        subsidiaryId: q.subsidiaryId ?? null,
      });
    } catch (e) {
      if (!(e instanceof AccountingContextError)) throw e;
      contextBlocked = {
        title: t("accountingContext.blockedTitle"),
        description: `${e.message} ${e.remedy}`,
      };
    }
    try {
      subView = await reportSubsidiaryView(q.subsidiaryId, period.to, selectedBook.id);
      if (!contextBlocked)
        view = await profitAndLossView(
          { from: period.from, to: period.to },
          reportPeriodLabel(period, locale),
          labels,
          {
            accountLabels: accountingContext?.labels ?? null,
            locale,
            breakout: q.breakout,
            compare: q.compare,
            basis: q.basis,
            dims: q.dims,
            subsidiary: subView.subsidiary,
            showZero: q.showZero,
            bookId: selectedBook?.id,
          },
        );
    } catch (e) {
      // Underived consolidated rates must not throw out of SSR:
      // the page renders a typed banner with a derive link instead of any
      // numbers. Anything else is a real defect and still throws.
      const historicalNotice = historicalTranslationBlockedNotice(e, {
        title: t("statement.historicalEvidenceBlockedTitle"),
        actionLabel: t("statement.historicalEvidenceBlockedAction"),
      });
      if (historicalNotice) ratesBlocked = historicalNotice;
      else {
        if (!(e instanceof MissingRatesError)) throw e;
        ratesBlocked = {
          code: "rates-not-derived",
          title: t("statement.ratesBlockedTitle"),
          description: (e as Error).message,
          deriveLabel: t("statement.ratesBlockedAction"),
          deriveHref: "/close",
        };
      }
    }
  }
  const authz = await getAuthz();
  const optionScope = dimensionOptionsScope(subView?.subsidiary?.ids, authz?.allowedSubsidiaryIds);
  const [opts, org] = await Promise.all([
    dimensionOptions(undefined, undefined, optionScope),
    orgInfo(),
  ]);

  const scale = scaleFactor(q.scale);
  const title = t("pnl.title");

  return {
    title,
    description: `${selectedBook ? `${selectedBook.name} · ` : ""}${subView?.label ? `${subView.label} · ` : ""}${period ? reportPeriodLabel(period, locale) : ""}${scale.note ? ` · ${scale.note.toLowerCase()}` : ""}`,
    backHref: "/reports",
    backLabel: t("hub.title"),
    hubLabel: t("hub.title"),
    company: org?.name ?? "",
    periodPhrase: [
      selectedBook.name,
      period
        ? t("pnl.dateRange", civilDateParams({ from: period.from, to: period.to }, locale))
        : null,
      accountingContext ? accountingContextLegend(accountingContext, t) : null,
    ]
      .filter(Boolean)
      .join(" · "),
    note: scale.note || "",
    wide: view ? view.columns.length > 4 : false,
    truncated: view?.truncated ?? false,
    truncatedLabel: t("filterBar.truncated"),
    ratesBlocked,
    periodRefusal,
    filterPeriodLabel: t("filterBar.period"),
    ratesReady: ratesBlocked === null && periodRefusal === null && contextBlocked === null,
    contextBlocked,
    view,
    scale: q.scale,
    currency: subView?.currency ?? org?.base_currency,
    drill: {
      // The drill drawer must read the cell's exact entity set (a consolidated
      // subtree, not just the picker node) — the route re-validates every id.
      dims: { ...q.dims, subsidiaryIds: subView?.subsidiary?.ids },
      basis: q.basis,
      subsidiaryId: q.subsidiaryId,
      bookId: selectedBook.id,
    },
    dimensions: opts,
    subsidiaries: subView?.picker ?? [],
    primaryFilter: (() => {
      const filters = [
        books.length > 1
          ? {
              paramKey: "book",
              label: tb("list.bookFilter"),
              value: selectedBook?.id ?? "",
              options: books.map((b) => ({ value: b.id, label: b.name })),
            }
          : null,
        accountingContext ? accountingContextFilter(accountingContext, t) : null,
      ].filter((filter) => filter !== null);
      return filters.length > 0 ? filters : null;
    })(),
    scheduleDefId: scheduleDefId ?? null,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: stringReportParams(sp),
  };
}

const f = ref<PnlData>();

export function pnlSpec(data: PnlData): PageSpec {
  return statementReportSpec({
    route: "/reports/pnl",
    header: {
      title: f("title"),
      description: f("description"),
      back: { href: f("backHref"), label: f("backLabel") },
    },
    filters: [
      {
        controls: {
          period: true,
          breakout: true,
          compare: true,
          basis: true,
          dimensions: true,
          subsidiary: true,
          showZero: true,
          scale: true,
          sections: true,
        },
        options: {
          dimensions: f("dimensions"),
          subsidiaries: f("subsidiaries"),
          primaryFilter: f("primaryFilter"),
        },
      },
    ],
    schedule: {
      definitionId: data.scheduleDefId ?? "",
      statementParams: data.scheduleParams,
      when: f("scheduleDefId"),
    },
    exportMenu: { kind: "pnl", params: data.exportParams },
    headerAfterFilters: [
      // The native page renders this warning only when the statement was
      // truncated. `when` is how a spec expresses that without the language
      // acquiring a conditional operator.
      textBlock(f("truncatedLabel"), { tone: "warning", when: f("truncated") }),
    ],
    bodyBeforePaper: [
      {
        ...widgetBlock("empty-state", {
          title: data.ratesBlocked?.title ?? "",
          description: data.ratesBlocked?.description,
          action: "link-button",
          actionProps: {
            href: statementTranslationBlockedAction(data.ratesBlocked).href,
            label: statementTranslationBlockedAction(data.ratesBlocked).label,
          },
        }),
        when: f("ratesBlocked"),
      },
      {
        // The refusal sits under the filter bar so the operator can set the
        // dates in place; the report stays hidden until the range is complete.
        ...widgetBlock("empty-state", {
          title: data.filterPeriodLabel,
          description: data.periodRefusal ?? "",
        }),
        when: f("periodRefusal"),
      },
      ...(data.contextBlocked
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.contextBlocked.title,
                description: data.contextBlocked.description,
              }),
              when: f("contextBlocked"),
            },
          ]
        : []),
    ],
    paper: {
      company: f("company"),
      title: f("title"),
      periodPhrase: f("periodPhrase"),
      note: f("note"),
      wide: f("wide"),
      when: f("ratesReady"),
    },
    blocks: [
      widgetBlock("statement-matrix", {
        view: data.view,
        scale: data.scale,
        currency: data.currency,
        drill: data.drill,
      }),
    ],
  });
}
