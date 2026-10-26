import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "../../../../lib/format";
import { AS_OF_DEFAULT_PERIOD_PRESET, fiscalYearStartOn } from "@openbooks/reports";
import {
  filterBar,
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { resolveOrgId } from "../../../../lib/org-scope";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { dimensionOptions } from "../../../../lib/reports";
import { dimensionOptionsScope } from "../../../../lib/reports/filters";
import { orgInfo } from "../../../../lib/data";
import { resolvePeriod } from "../../../../lib/periods";
import { parseReportQuery } from "../../../../lib/report-filters";
import {
  MissingRatesError,
  reportSubsidiaryView,
  type CurrencyBasisNotice,
  type RatesBlockedNotice,
} from "../../../../lib/consolidation";
import { ReportCurrencyBasisError } from "../../../../lib/reports/currency-basis";
import { orgBranding } from "../../../../lib/report-pdf";
import { reportScheduleAnchor, scheduleParamsFrom } from "../../../../lib/report-schedule-anchor";
import { getAuthz } from "@/lib/authz";
import { COMPUTED_RETAINED_EARNINGS_PRIOR_ID } from "../../../../lib/computed-earnings";
import { PNL_TYPES } from "../../../../lib/account-types";
import { fiscalStartMonth } from "../../../../lib/fiscal";
import {
  BookDifferenceSelectionError,
  bookDifferenceRows,
  bookDifferenceSelection,
} from "../../../../lib/book-differences-report";
import type { ReportDrillTarget } from "../../../../lib/report-drill";
import type { PaperCell } from "../PaperView";

/**
 * Book differences: per account, the primary book's balance beside a
 * secondary book's, as of a date, with the difference. Both columns read
 * the trial balance engine of their own book and drill into that book's
 * ledger. Each book states the view in its own currency for the
 * subsidiaries in it; when those differ, no difference is computed.
 */

export interface BookDifferencesData {
  title: string;
  backHref: string;
  backLabel: string;
  dimensions: unknown;
  subsidiaries: unknown;
  primaryFilter: {
    paramKey: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
  } | null;
  scheduleDefId: string | null;
  scheduleParams: Record<string, string | undefined>;
  exportParams: Record<string, string | undefined>;
  company: string;
  currency: string | undefined;
  emptyLabel: string;
  /** Set when the comparison cannot run (no secondary book, stale choice). */
  selectionRefusal: { title: string; description: string; actionLabel: string } | null;
  ratesBlocked: RatesBlockedNotice | null;
  currencyBasisBlocked: CurrencyBasisNotice | null;
  ready: boolean;
  paper: unknown;
}

export async function loadBookDifferences(
  sp: Record<string, string | undefined>,
): Promise<BookDifferencesData> {
  const orgId = await resolveOrgId();
  await requireFeatureEnabled(orgId, "multiBookAccounting");
  const t = await getTranslations("reports");
  const locale = await getLocale();
  const tb = await getTranslations("reports.bookDifferences");
  const scheduleDefId = await reportScheduleAnchor("book-differences");
  const q = parseReportQuery(sp, { defaultPeriod: AS_OF_DEFAULT_PERIOD_PRESET });
  const period = await resolvePeriod(q.period, { customFrom: q.from, customTo: q.to });
  const date = period.to;
  const [org, branding] = await Promise.all([orgInfo(), orgBranding()]);
  const base: Omit<
    BookDifferencesData,
    | "selectionRefusal"
    | "ratesBlocked"
    | "currencyBasisBlocked"
    | "ready"
    | "paper"
    | "primaryFilter"
    | "subsidiaries"
    | "dimensions"
    | "currency"
  > = {
    title: tb("title"),
    backHref: "/reports",
    backLabel: t("hub.title"),
    scheduleDefId,
    scheduleParams: scheduleParamsFrom(sp),
    exportParams: sp,
    company: branding.orgName,
    emptyLabel: tb("empty"),
  };
  let selection: Awaited<ReturnType<typeof bookDifferenceSelection>>;
  try {
    selection = await bookDifferenceSelection(orgId, sp.compareBook);
  } catch (error) {
    if (!(error instanceof BookDifferenceSelectionError)) throw error;
    return {
      ...base,
      dimensions: null,
      subsidiaries: [],
      primaryFilter: null,
      currency: org?.base_currency,
      selectionRefusal: {
        title: tb("unavailableTitle"),
        description: error.message,
        actionLabel: tb("setupBooks"),
      },
      ratesBlocked: null,
      currencyBasisBlocked: null,
      ready: false,
      paper: null,
    };
  }
  const { primary, compare, options } = selection;
  const primaryFilter = {
    paramKey: "compareBook",
    label: tb("compareBook"),
    value: compare.id,
    options: options.map((book) => ({ value: book.id, label: `${book.name} (${book.code})` })),
  };

  let ratesBlocked: RatesBlockedNotice | null = null;
  let currencyBasisBlocked: CurrencyBasisNotice | null = null;
  let primaryView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined;
  let compareView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined;
  let rows: Awaited<ReturnType<typeof bookDifferenceRows>> = [];
  let sameCurrency = true;
  try {
    primaryView = await reportSubsidiaryView(q.subsidiaryId, date, primary.id);
    compareView = await reportSubsidiaryView(q.subsidiaryId, date, compare.id);
    const primaryCurrency = primaryView.currency ?? org?.base_currency;
    const compareCurrency = compareView.currency ?? org?.base_currency;
    sameCurrency = primaryCurrency === compareCurrency;
    rows = await bookDifferenceRows({
      orgId,
      asOf: date,
      dims: { ...q.dims, subsidiaryIds: primaryView.subsidiary?.ids },
      primaryBookId: primary.id,
      compareBookId: compare.id,
      sameCurrency,
    });
  } catch (e) {
    if (e instanceof ReportCurrencyBasisError) {
      currencyBasisBlocked = {
        code: "multi-currency-basis",
        title: t("statement.currencyBasisBlockedTitle"),
        description: e.message,
      };
    } else {
      if (!(e instanceof MissingRatesError)) throw e;
      ratesBlocked = {
        code: "rates-not-derived",
        title: t("statement.ratesBlockedTitle"),
        description: e.message,
        deriveLabel: t("statement.ratesBlockedAction"),
        deriveHref: "/close",
      };
    }
  }
  const dims = { ...q.dims, subsidiaryIds: primaryView?.subsidiary?.ids };
  const authz = await getAuthz();
  const optionScope = dimensionOptionsScope(dims.subsidiaryIds, authz?.allowedSubsidiaryIds);
  const [opts, startMonth] = await Promise.all([
    dimensionOptions(undefined, undefined, optionScope),
    fiscalStartMonth(),
  ]);
  const fyStart = fiscalYearStartOn(date, startMonth);
  const primaryCurrency = primaryView?.currency ?? org?.base_currency ?? "";
  const compareCurrency = compareView?.currency ?? org?.base_currency ?? "";

  const dataRows: PaperCell[][] = rows.map((row) => [
    row.number ?? "",
    row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID
      ? t("statement.retainedEarningsPrior")
      : row.name,
    sameCurrency ? row.primary : `${row.primary} ${primaryCurrency}`,
    sameCurrency ? row.compare : `${row.compare} ${compareCurrency}`,
    row.difference ?? "",
  ]);
  const drills: (ReportDrillTarget | null)[][] = rows.map((row) => {
    if (row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID) return [null, null, null, null, null];
    const pnl = PNL_TYPES.includes(row.type);
    const target = (bookId: string): ReportDrillTarget => ({
      kind: "ledger",
      bookId,
      label: `${row.number ?? ""} ${row.name}`.trim(),
      accountIds: [row.id],
      from: pnl ? fyStart : undefined,
      to: date,
      mode: pnl ? "flow" : "balance",
      dims,
      subsidiaryId: q.subsidiaryId,
    });
    return [null, null, target(primary.id), target(compare.id), null];
  });

  return {
    ...base,
    dimensions: opts,
    subsidiaries: primaryView?.picker ?? [],
    primaryFilter,
    currency: sameCurrency ? primaryCurrency : undefined,
    selectionRefusal: null,
    ratesBlocked,
    currencyBasisBlocked,
    ready: ratesBlocked === null && currencyBasisBlocked === null,
    paper: {
      title: tb("title"),
      periodPhrase: tb(
        "asOf",
        civilDateParams({ date, primary: primary.name, compare: compare.name }, locale),
      ),
      note: sameCurrency
        ? undefined
        : tb("currencyNote", { primary: primaryCurrency, compare: compareCurrency }),
      groups: [
        {
          columns: [
            tb("columns.accountNumber"),
            tb("columns.accountName"),
            tb("columns.primary", { book: primary.code, currency: primaryCurrency }),
            tb("columns.compare", { book: compare.code, currency: compareCurrency }),
            tb("columns.difference"),
          ],
          align: ["left", "left", "right", "right", "right"],
          money: [false, false, sameCurrency, sameCurrency, sameCurrency],
          rows: dataRows,
          drills,
        },
      ],
    },
  };
}

const f = ref<BookDifferencesData>();

export function bookDifferencesSpec(data: BookDifferencesData): PageSpec {
  return page({
    route: "/reports/book-differences",
    layout: "list",
    header: [
      pageHeader({ title: f("title"), back: { href: f("backHref"), label: f("backLabel") } }),
      filterBar(
        { period: true, asOf: true, dimensions: true, subsidiary: true },
        {
          dimensions: f("dimensions"),
          subsidiaries: f("subsidiaries"),
          primaryFilter: f("primaryFilter"),
          defaultPeriod: AS_OF_DEFAULT_PERIOD_PRESET,
          actions: [
            widget(
              "schedule-report",
              { definitionId: data.scheduleDefId ?? "", statementParams: data.scheduleParams },
              f("scheduleDefId"),
            ),
            widget("save-view"),
            widget("export-menu", { kind: "book-differences", params: data.exportParams }),
          ],
        },
      ),
    ],
    body: [
      ...(data.selectionRefusal
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.selectionRefusal?.title ?? "",
                description: data.selectionRefusal?.description,
                action: "link-button",
                actionProps: {
                  href: "/admin/setup/accounting-books",
                  label: data.selectionRefusal?.actionLabel ?? "",
                },
              }),
              when: f("selectionRefusal"),
            },
          ]
        : []),
      ...(data.ratesBlocked
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.ratesBlocked?.title ?? "",
                description: data.ratesBlocked?.description,
                action: "link-button",
                actionProps: {
                  href: data.ratesBlocked?.deriveHref ?? "/close",
                  label: data.ratesBlocked?.deriveLabel ?? "",
                },
              }),
              when: f("ratesBlocked"),
            },
          ]
        : []),
      ...(data.currencyBasisBlocked
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.currencyBasisBlocked?.title ?? "",
                description: data.currencyBasisBlocked?.description,
              }),
              when: f("currencyBasisBlocked"),
            },
          ]
        : []),
      {
        ...widgetBlock("paper-view", {
          company: data.company,
          currency: data.currency,
          emptyLabel: data.emptyLabel,
          data: data.paper,
        }),
        when: f("ready"),
      },
    ],
  });
}
