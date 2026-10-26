import "server-only";
import { getTranslations } from "next-intl/server";
import { abs, cmp, div, neg } from "@openbooks/engine/money";
import { getMoneyFormatter } from "../money-server";
import { formatDecimal } from "../money-format";
import { toChartNumber } from "../chart-number";
import { presentationCurrency } from "../fx-presentation";
import { ForbiddenError, requirePermission } from "../authz";
import { analyticsDashboardAvailable } from "./dashboard-access";
import { readAnalyticsDashboard } from "./dashboard-reader";
import { requestAuthzContext, withAuthzContext } from "../authz-context";
import { analyticsCacheIdentity, cachedAnalyticsRead } from "./preview-cache";
import { withAnalyticsRead } from "./read-context";
import { ANALYTICS_TABS, type AnalyticsSlug } from "./dashboard-tabs";
import { analyticsSourceQuery } from "./query-params";
import { RISK_SCORE_BANDS } from "./sentinel-scoring";
import type {
  AnalyticsDashboardDefinition,
  AnalyticsSpotlight,
  SpotlightPanel,
  SpotlightRankRow,
  SpotlightTone,
} from "./dashboard-catalog";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/** Rows a ranking panel shows: enough to read a distribution, few enough to scan. */
const RANK_ROWS = 6;

/**
 * The home-dashboard spotlight for one Analytics dashboard: the dashboard's
 * own default-view read (same loader, cache entry, grants, scope and Company
 * Features gate as opening the dashboard), projected onto the headline
 * figures, feature chart and supporting panels the widget draws. The
 * projection only selects and formats what the dashboard already computed.
 */
export async function analyticsDashboardSpotlight(
  dashboard: AnalyticsDashboardDefinition,
  sp: Record<string, string | undefined>,
  orgId: string,
): Promise<AnalyticsSpotlight> {
  const authz = await requirePermission("reports.read");
  if (authz.user.orgId !== orgId || !(await analyticsDashboardAvailable(authz, dashboard)))
    throw new ForbiddenError(dashboard.permission ?? dashboard.feature ?? "reports.read");
  const slug = dashboard.slug as AnalyticsSlug;
  const query = { ...analyticsSourceQuery(sp, slug), tab: ANALYTICS_TABS[slug][0] };
  const t = await getTranslations("analytics");
  switch (slug) {
    case "cashflow":
      return cashflowSpotlight(t, orgId, await readAnalyticsDashboard("cashflow", query));
    case "receivables-intelligence":
      return receivablesSpotlight(
        t,
        orgId,
        await readAnalyticsDashboard("receivables-intelligence", query),
      );
    case "financial-health":
      return financialHealthSpotlight(t, orgId, await readFinancialHealthSummary(query));
    case "customer-intelligence":
      return customerSpotlight(
        t,
        orgId,
        await readAnalyticsDashboard("customer-intelligence", query),
      );
    case "vendor-performance":
      return vendorSpotlight(t, orgId, await readAnalyticsDashboard("vendor-performance", query));
    case "spend-velocity":
      return spendVelocitySpotlight(
        t,
        orgId,
        await readAnalyticsDashboard("spend-velocity", query),
      );
    case "true-cost":
      return trueCostSpotlight(t, orgId, await readAnalyticsDashboard("true-cost", query));
    case "utilization":
      return utilizationSpotlight(t, orgId, await readAnalyticsDashboard("utilization", query));
    case "sentinel":
      return sentinelSpotlight(t, orgId, await readAnalyticsDashboard("sentinel", query));
  }
  throw new Error(t("preview.unavailable"));
}

/** Locale formatters bound to the payload's currency. */
async function formatters(orgId: string, currency: string) {
  const fmt = await getMoneyFormatter(orgId, currency);
  const percentFormat = (signed: boolean) =>
    new Intl.NumberFormat(fmt.locale, {
      style: "percent",
      maximumFractionDigits: 1,
      ...(signed ? { signDisplay: "exceptZero" as const } : {}),
    });
  return {
    locale: fmt.locale,
    /** Whole-unit money for headline figures. */
    money: (value: string | number) => fmt.money(value, { maximumFractionDigits: 0 }),
    /** Compact money for figure chips and ranked rows. */
    compact: (value: string | number) =>
      fmt.money(value, { notation: "compact", maximumFractionDigits: 1 }),
    count: (value: number | string) =>
      formatDecimal(fmt.locale, value, { maximumFractionDigits: 1 }),
    signedCount: (value: number) =>
      formatDecimal(fmt.locale, value, { maximumFractionDigits: 1, signDisplay: "exceptZero" }),
    /** A 0–1 fraction (exact decimal strings format without a float hop). */
    fraction: (value: number | string, signed = false) =>
      percentFormat(signed).format(value as number),
    /** A figure already on the 0–100 scale. */
    points: (value: number, signed = false) => percentFormat(signed).format(value / 100),
  };
}

const observedOf = (read: { observedAt: string }) => read.observedAt;
/** Score figures read as a share of the 0–100 scale, as on the dashboards. */
const outOf100 = (f: { count: (value: number) => string }, score: number) =>
  `${f.count(score)}/100`;
const moneyTone = (value: string): SpotlightTone => (cmp(value, "0") < 0 ? "negative" : "neutral");
const chartOf = (value: string) => toChartNumber(value);

/** Bar lengths relative to the panel's largest magnitude. */
function ranked<T>(
  items: readonly T[],
  magnitude: (item: T) => number,
  row: (item: T) => Omit<SpotlightRankRow, "share">,
): SpotlightRankRow[] {
  const top = items.slice(0, RANK_ROWS);
  const max = Math.max(0, ...top.map((item) => Math.abs(magnitude(item))));
  return top.map((item) => ({
    ...row(item),
    share: max > 0 ? Math.abs(magnitude(item)) / max : 0,
  }));
}

/** Bar lengths relative to the largest exact amount, divided exactly. */
function rankedMoney<T>(
  items: readonly T[],
  amount: (item: T) => string,
  row: (item: T) => Omit<SpotlightRankRow, "share">,
): SpotlightRankRow[] {
  const top = items.slice(0, RANK_ROWS);
  const max = top.reduce((best, item) => {
    const value = abs(amount(item));
    return cmp(value, best) > 0 ? value : best;
  }, "0");
  return top.map((item) => ({
    ...row(item),
    share: cmp(max, "0") > 0 ? chartOf(div(abs(amount(item)), max)) : 0,
  }));
}

const sortedMoney = <T>(items: readonly T[], amount: (item: T) => string) =>
  [...items].sort((a, b) => cmp(amount(b), amount(a)));

type CashflowRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"cashflow">>>;
async function cashflowSpotlight(
  t: Translate,
  orgId: string,
  read: CashflowRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const f = await formatters(orgId, currency);
  const { data, horizon, periodLabel } = read;
  const s = data.summary;
  const runwayTone: SpotlightTone =
    s.runwayStatus === "critical"
      ? "negative"
      : s.runwayStatus === "caution"
        ? "caution"
        : "positive";
  const runwayLabel =
    s.runwayStatus === "critical"
      ? t("cashflow.vitals.runwayCritical")
      : s.runwayStatus === "caution"
        ? t("cashflow.vitals.runwayCaution")
        : t("cashflow.vitals.runwayHealthy");
  const agingDonut = (title: string, side: typeof data.ar): SpotlightPanel => ({
    kind: "donut",
    title,
    format: "money",
    slices: [...side.buckets]
      .sort((a, b) => a.index - b.index)
      .filter((bucket) => cmp(bucket.amount, "0") > 0)
      .map((bucket) => ({
        name: bucket.label,
        value: chartOf(bucket.amount),
        display: f.compact(bucket.amount),
        tone:
          bucket.index === 0
            ? ("positive" as const)
            : bucket.index >= 3
              ? ("negative" as const)
              : ("caution" as const),
      })),
    center: { label: t("spotlight.outstanding"), value: f.compact(side.outstanding) },
  });
  const categories = [...data.categories].sort((a, b) => cmp(abs(b.total), abs(a.total)));
  return {
    slug: "cashflow",
    periodLabel: `${periodLabel} · ${t("hub.forecastWeeks", { weeks: horizon })}`,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("cashflow.kpi.projectedEnd"),
      value: f.money(s.projectedEnd),
      detail: t("cashflow.kpi.netSub", { change: f.compact(s.netChange) }),
      tone: cmp(s.projectedEnd, "0") < 0 ? "negative" : runwayTone,
    },
    figures: [
      { label: t("cashflow.kpi.currentCash"), value: f.compact(s.startingCash) },
      {
        label: t("cashflow.kpi.lowestPoint"),
        value: f.compact(s.lowestCash),
        tone: cmp(s.lowestCash, "0") < 0 ? "negative" : runwayTone,
      },
      {
        label: t("cashflow.vitals.runway"),
        value:
          s.runwayWeeks === null
            ? runwayLabel
            : t("spotlight.weeks", { weeks: f.count(s.runwayWeeks) }),
        detail: runwayLabel,
        tone: runwayTone,
      },
      { label: t("cashflow.kpi.inflows"), value: f.compact(s.totalInflows), tone: "positive" },
      { label: t("cashflow.kpi.outflows"), value: f.compact(s.totalOutflows), tone: "caution" },
      {
        label: t("cashflow.vitals.burnRate"),
        value: f.compact(s.burnRate),
        detail: t("cashflow.vitals.burnHint"),
      },
    ],
    feature: {
      kind: "trend",
      title: t("cashflow.panels.forecast"),
      labels: data.weeks.map((week) => week.label),
      format: "money",
      series: [
        {
          name: t("charts.weekly.endingCash"),
          values: data.weeks.map((week) => chartOf(week.endingCash)),
          style: "area",
          role: "primary",
        },
        {
          name: t("charts.weekly.net"),
          values: data.weeks.map((week) => chartOf(week.net)),
          style: "bar",
          role: "signed",
        },
      ],
    },
    panels: [
      {
        kind: "bridge",
        title: t("cashflow.panels.bridge"),
        steps: [
          { label: t("charts.bridge.start"), amount: s.startingCash, kind: "start" },
          {
            label: t("charts.bridge.inflows"),
            amount: abs(s.totalInflows),
            kind: "deduct",
            tone: "positive",
          },
          {
            label: t("charts.bridge.outflows"),
            amount: neg(abs(s.totalOutflows)),
            kind: "deduct",
            tone: "negative",
          },
          { label: t("charts.bridge.projectedEnd"), amount: s.projectedEnd, kind: "total" },
        ],
      },
      agingDonut(t("cashflow.panels.ar"), data.ar),
      agingDonut(t("cashflow.panels.ap"), data.ap),
      {
        kind: "ranking",
        title: t("cashflow.panels.forecastCategories"),
        empty: t("spotlight.empty"),
        rows: rankedMoney(
          categories,
          (category) => category.total,
          (category) => ({
            name: category.name,
            value: f.compact(category.total),
            detail: category.meta.method,
            tone: category.direction === "inflow" ? "positive" : "caution",
          }),
        ),
      },
    ],
  };
}

type ReceivablesRead = Awaited<
  ReturnType<typeof readAnalyticsDashboard<"receivables-intelligence">>
>;
async function receivablesSpotlight(
  t: Translate,
  orgId: string,
  read: ReceivablesRead,
): Promise<AnalyticsSpotlight> {
  const { data, periodLabel } = read;
  const currency = data.currency;
  const f = await formatters(orgId, currency);
  const s = data.summary;
  const share = (value: string | null) => (value === null ? "—" : f.fraction(value));
  const behaviorTones: SpotlightTone[] = ["positive", "caution", "caution", "negative"];
  const bridge: Extract<SpotlightPanel, { kind: "bridge" }>["steps"] = [
    { label: t("spotlight.openingOverdue"), amount: s.opening, kind: "start" },
    { label: t("spotlight.recovered"), amount: neg(s.recovered), kind: "deduct", tone: "positive" },
    ...(cmp(s.otherChange, "0") === 0
      ? []
      : [
          {
            label: t("spotlight.otherChanges"),
            amount: neg(s.otherChange),
            kind: "deduct" as const,
            tone: "neutral" as const,
          },
        ]),
    { label: t("spotlight.stillOverdue"), amount: s.remaining, kind: "total", tone: "caution" },
  ];
  return {
    slug: "receivables-intelligence",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("receivables.kpi.attention"),
      value: f.money(s.attention),
      detail: t("spotlight.customersOverdue", { count: s.attentionCustomers }),
      tone: cmp(s.attention, "0") > 0 ? "caution" : "positive",
    },
    figures: [
      {
        label: t("receivables.kpi.overdue"),
        value: f.compact(s.overdue),
        tone: cmp(s.overdue, "0") > 0 ? "caution" : "positive",
      },
      { label: t("receivables.kpi.onTime"), value: share(s.onTimeShare) },
      {
        label: t("receivables.kpi.deteriorating"),
        value: f.count(s.deterioratingCustomers),
        detail: f.compact(s.deterioratingExposure),
        tone: s.deterioratingCustomers > 0 ? "negative" : "positive",
      },
      { label: t("receivables.kpi.recovery"), value: share(s.recoveryShare) },
      { label: t("receivables.kpi.customers"), value: f.count(s.customers) },
      { label: t("receivables.kpi.credits"), value: f.compact(s.credits) },
    ],
    feature: {
      kind: "donut",
      title: t("receivables.panels.behavior"),
      format: "money",
      slices: s.behavior
        .filter((row) => cmp(row.amount, "0") > 0)
        .map((row) => ({
          name: t(`receivables.behavior.${row.index}`),
          value: chartOf(row.amount),
          display: f.compact(row.amount),
          tone: behaviorTones[row.index] ?? "neutral",
        })),
      center: { label: t("receivables.kpi.onTime"), value: share(s.onTimeShare) },
    },
    panels: [
      { kind: "bridge", title: t("receivables.panels.recoveryBridge"), steps: bridge },
      {
        kind: "ranking",
        title: t("receivables.panels.customerExposure"),
        empty: t("receivables.noCustomers"),
        rows: rankedMoney(
          data.customers,
          (customer) => customer.overdue,
          (customer) => ({
            name: customer.name,
            value: f.compact(customer.overdue),
            detail: t("spotlight.oldestDays", { days: customer.oldestDays }),
            tone: customer.deteriorating
              ? "negative"
              : cmp(customer.severe, "0") > 0
                ? "caution"
                : "neutral",
          }),
        ),
      },
    ],
  };
}

/**
 * Financial Health's summary projection: the health evaluation, monthly
 * series and findings the spotlight draws, without the per-tab sections
 * (segments, drivers, items, budget, forecast) the dashboard reads for its
 * own tabs. Same loader, grants, scope and shared cache as the Analytics hub
 * card for the dashboard.
 */
async function readFinancialHealthSummary(query: Record<string, string | undefined>) {
  const authz = await requirePermission("reports.read");
  const source = analyticsSourceQuery(query, "financial-health");
  return withAuthzContext(authz, async () => {
    const authority = requestAuthzContext()!;
    const identity = await analyticsCacheIdentity(authority.user.orgId);
    const read = {
      authz: authority,
      slug: "financial-health",
      tab: "",
      projection: "summary" as const,
      ...identity,
      observedAt: Date.now(),
    };
    return withAnalyticsRead(read, async () => {
      const result = await cachedAnalyticsRead(
        authority,
        "summary:financial-health",
        source,
        async () =>
          (
            await import("../../app/(app)/analytics/financial-health/view")
          ).loadFinancialHealthPreview(source),
        { identity },
      );
      return { ...result, observedAt: new Date(read.observedAt).toISOString() };
    });
  });
}

type HealthRead = Awaited<ReturnType<typeof readFinancialHealthSummary>>;
async function financialHealthSpotlight(
  t: Translate,
  orgId: string,
  read: HealthRead,
): Promise<AnalyticsSpotlight> {
  const { data, periodLabel } = read;
  const currency = data.currency;
  const f = await formatters(orgId, currency);
  const fig = data.figures;
  const bands = data.benchmarks.labels;
  const margin = data.ratios.profitability.find((ratio) => ratio.id === "gross_margin");
  const scoreTone: SpotlightTone =
    data.overallScore === null
      ? "neutral"
      : data.overallScore >= bands.good
        ? "positive"
        : data.overallScore >= bands.average
          ? "caution"
          : "negative";
  const severityTone: Record<string, SpotlightTone> = {
    issue: "negative",
    anomaly: "caution",
    rec: "positive",
  };
  return {
    slug: "financial-health",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("financialHealth.kpi.revenue"),
      value: f.money(fig.revenue),
      detail:
        fig.revenueGrowth === null
          ? t("financialHealth.kpiSub.noPriorYear")
          : t("financialHealth.kpiSub.growth", { pct: f.fraction(fig.revenueGrowth, true) }),
      tone:
        fig.revenueGrowth === null
          ? "neutral"
          : cmp(fig.revenueGrowth, "0") < 0
            ? "negative"
            : "positive",
    },
    figures: [
      {
        label: t("financialHealth.kpi.grossMargin"),
        value: margin?.value == null ? "—" : f.fraction(margin.value),
      },
      {
        label: t("financialHealth.kpi.operatingIncome"),
        value: f.compact(fig.operatingIncome),
        tone: moneyTone(fig.operatingIncome),
      },
      {
        label: t("financialHealth.score.overall"),
        value:
          data.overallScore === null
            ? t("financialHealth.score.unscored")
            : outOf100(f, data.overallScore),
        detail: data.scoreLabel ? t(`financialHealth.score.${data.scoreLabel}`) : undefined,
        tone: scoreTone,
      },
      {
        label: t("financialHealth.kpi.grossProfit"),
        value: f.compact(fig.grossProfit),
        tone: moneyTone(fig.grossProfit),
      },
      {
        label: t("financialHealth.pnl.netIncome"),
        value: f.compact(fig.netIncome),
        tone: moneyTone(fig.netIncome),
      },
      {
        label: t("financialHealth.kpi.breakeven"),
        value: fig.breakevenRevenue === null ? "—" : f.compact(fig.breakevenRevenue),
      },
    ],
    feature: {
      kind: "trend",
      title: t("spotlight.revenueAndOperatingIncome"),
      labels: data.monthly.map((month) => month.label),
      format: "money",
      series: [
        {
          name: t("financialHealth.kpi.revenue"),
          values: data.monthly.map((month) => chartOf(month.revenue)),
          style: "bar",
          role: "primary",
        },
        {
          name: t("financialHealth.kpi.operatingIncome"),
          values: data.monthly.map((month) => chartOf(month.operatingIncome)),
          style: "line",
          role: "secondary",
        },
      ],
    },
    panels: [
      {
        kind: "gauge",
        title: t("financialHealth.score.title"),
        score: data.overallScore ?? 0,
        display: data.overallScore === null ? "—" : outOf100(f, data.overallScore),
        caption: data.scoreLabel
          ? t(`financialHealth.score.${data.scoreLabel}`)
          : t("financialHealth.score.unscored"),
        goodWhenHigh: true,
        // No score is no verdict: the ring renders untoned rather than
        // grading a stand-in zero against the configured scale.
        bands: data.overallScore === null ? null : bands,
        breakdown: data.categoryScores.map((category) => ({
          label: t(`financialHealth.categories.${category.key}`),
          score: category.score,
        })),
      },
      {
        kind: "bridge",
        title: t("financialHealth.pnl.title"),
        steps: [
          { label: t("financialHealth.pnl.revenue"), amount: fig.revenue, kind: "start" },
          { label: t("financialHealth.pnl.cogs"), amount: neg(fig.cogs), kind: "deduct" },
          {
            label: t("financialHealth.pnl.grossProfit"),
            amount: fig.grossProfit,
            kind: "subtotal",
          },
          { label: t("financialHealth.pnl.opex"), amount: neg(fig.opex), kind: "deduct" },
          {
            label: t("financialHealth.pnl.operatingIncome"),
            amount: fig.operatingIncome,
            kind: "total",
          },
        ],
      },
      {
        kind: "trend",
        title: t("spotlight.grossMarginTrend"),
        labels: data.monthly.map((month) => month.label),
        format: "percent",
        series: [
          {
            name: t("financialHealth.kpi.grossMargin"),
            values: data.monthly.map((month) =>
              month.grossMarginPct === null ? null : month.grossMarginPct * 100,
            ),
            style: "area",
            role: "positive",
          },
        ],
      },
      {
        kind: "insights",
        title: t("spotlight.findings"),
        empty: t("spotlight.noFindings"),
        items: data.insights.slice(0, RANK_ROWS).map((insight) => ({
          tone: severityTone[insight.severity] ?? "neutral",
          title: insight.title,
          detail: insight.detail,
        })),
      },
    ],
  };
}

type CustomerRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"customer-intelligence">>>;
async function customerSpotlight(
  t: Translate,
  orgId: string,
  read: CustomerRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const { data, periodLabel } = read;
  if (data.weightsError)
    return {
      slug: "customer-intelligence",
      periodLabel,
      observedAt: observedOf(read),
      currency,
      figures: [],
      panels: [],
      notice: data.weightsError,
    };
  const f = await formatters(orgId, currency);
  const k = data.kpis;
  const insightTone: Record<string, SpotlightTone> = {
    alert: "negative",
    warning: "caution",
    success: "positive",
    info: "neutral",
  };
  return {
    slug: "customer-intelligence",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("customer.kpi.periodRevenue"),
      value: f.money(k.totalRevenue),
      detail:
        k.yoyGrowth === null
          ? t("customer.sub.newInPeriod", { count: k.newCustomers })
          : t("spotlight.yoy", { pct: f.points(k.yoyGrowth, true) }),
      tone: k.yoyGrowth === null ? "neutral" : k.yoyGrowth < 0 ? "negative" : "positive",
    },
    figures: [
      {
        label: t("customer.kpi.totalCustomers"),
        value: f.count(k.totalCustomers),
        detail: t("customer.sub.newInPeriod", { count: k.newCustomers }),
      },
      {
        label: t("customer.kpi.atRisk"),
        value: f.count(k.atRiskCount),
        detail: f.compact(k.atRiskRevenue),
        tone: k.atRiskCount > 0 ? "caution" : "positive",
      },
      {
        label: t("customer.kpi.retentionRate"),
        value: k.retentionRate === null ? "—" : f.points(k.retentionRate),
      },
      { label: t("customer.kpi.champions"), value: f.count(k.champions), tone: "positive" },
      { label: t("customer.kpi.projectedClv"), value: f.compact(k.projectedClv) },
      { label: t("customer.kpi.totalInvoiced"), value: f.compact(k.totalInvoiced) },
    ],
    feature: {
      kind: "trend",
      title: t("spotlight.revenueTrend"),
      labels: data.growth.monthly.map((month) => month.label),
      format: "money",
      series: [
        {
          name: t("customer.kpi.periodRevenue"),
          values: data.growth.monthly.map((month) => chartOf(month.revenue)),
          style: "area",
          role: "primary",
        },
        {
          name: t("customer.kpi.totalInvoiced"),
          values: data.growth.monthly.map((month) => chartOf(month.invoiced)),
          style: "dashed",
          role: "muted",
        },
      ],
    },
    panels: [
      {
        kind: "donut",
        title: t("customer.panels.segmentMix"),
        format: "count",
        slices: data.segments
          .filter((segment) => segment.count > 0)
          .map((segment) => ({
            name: t(`customer.segment.${segment.segment}`),
            value: segment.count,
            display: f.count(segment.count),
          })),
        center: { label: t("customer.kpi.totalCustomers"), value: f.count(k.totalCustomers) },
      },
      {
        kind: "ranking",
        title: t("customer.panels.topByRevenue"),
        empty: t("spotlight.empty"),
        rows: rankedMoney(
          sortedMoney(data.rows, (row) => row.revenue),
          (row) => row.revenue,
          (row) => ({
            name: row.name,
            value: f.compact(row.revenue),
            detail: t(`customer.segment.${row.segment}`),
            tone:
              row.churnLevel === "critical" || row.churnLevel === "high" ? "caution" : "neutral",
          }),
        ),
      },
      {
        kind: "donut",
        title: t("customer.panels.revenueByTier"),
        format: "money",
        slices: data.tierBreakdown
          .filter((tier) => cmp(tier.revenue, "0") > 0)
          .map((tier) => ({
            name: t(`customer.tier.${tier.tier}`),
            value: chartOf(tier.revenue),
            display: f.compact(tier.revenue),
          })),
      },
      {
        kind: "insights",
        title: t("customer.panels.insights"),
        empty: t("spotlight.noFindings"),
        items: data.insights.slice(0, RANK_ROWS).map((insight) => ({
          tone: insightTone[insight.type] ?? "neutral",
          title: insight.title,
          detail: insight.message,
        })),
      },
    ],
  };
}

type VendorRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"vendor-performance">>>;
async function vendorSpotlight(
  t: Translate,
  orgId: string,
  read: VendorRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const f = await formatters(orgId, currency);
  const { data, periodLabel } = read;
  const totals = data.totals;
  const gradeTone: Record<string, SpotlightTone> = {
    A: "positive",
    B: "positive",
    C: "caution",
    D: "negative",
    F: "negative",
  };
  return {
    slug: "vendor-performance",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("vendor.kpi.totalSpend"),
      value: f.money(totals.spend),
      detail:
        totals.yoyPct === null
          ? t("vendor.sub.billsCount", { count: totals.bills })
          : t("vendor.sub.yoy", { pct: f.fraction(totals.yoyPct, true) }),
    },
    figures: [
      { label: t("vendor.kpi.activeVendors"), value: f.count(totals.vendors) },
      {
        label: t("vendor.kpi.onTimeRate"),
        value: totals.onTimePct === null ? "—" : f.fraction(totals.onTimePct),
        tone:
          totals.onTimePct === null
            ? "neutral"
            : totals.onTimePct * 100 >= data.config.onTimeGoodRate
              ? "positive"
              : "caution",
      },
      {
        label: t("vendor.kpi.top5Share"),
        value: f.fraction(totals.top5SharePct),
        detail: t("vendor.sub.top5Concentration"),
      },
      {
        label: t("vendor.kpi.avgDaysToPay"),
        value:
          totals.avgDaysToPay === null
            ? "—"
            : t("spotlight.days", { days: f.count(totals.avgDaysToPay) }),
      },
      {
        label: t("vendor.kpi.latePaidSpend"),
        value: f.compact(totals.lateSpend),
        tone: cmp(totals.lateSpend, "0") > 0 ? "caution" : "positive",
      },
      { label: t("vendor.kpi.avgBill"), value: f.compact(totals.avgBill) },
    ],
    feature: {
      kind: "trend",
      title: t("vendor.panels.spendTrend12mo"),
      labels: data.monthly.map((month) => month.label),
      format: "money",
      series: [
        {
          name: t("vendor.chart.spend"),
          values: data.monthly.map((month) => chartOf(month.spend)),
          style: "bar",
          role: "primary",
        },
      ],
    },
    panels: [
      {
        kind: "ranking",
        title: t("vendor.panels.topBySpend"),
        empty: t("spotlight.empty"),
        rows: rankedMoney(
          sortedMoney(data.rows, (row) => row.spend),
          (row) => row.spend,
          (row) => ({
            name: row.name,
            value: f.compact(row.spend),
            detail: `${t(`vendor.tier.${row.tier}`)} · ${f.fraction(row.sharePct)}`,
            tone: gradeTone[row.grade] ?? "neutral",
          }),
        ),
      },
      {
        kind: "donut",
        title: t("vendor.panels.spendByTier"),
        format: "money",
        slices: data.tierBreakdown
          .filter((tier) => cmp(tier.spend, "0") > 0)
          .map((tier) => ({
            name: t(`vendor.tier.${tier.tier}`),
            value: chartOf(tier.spend),
            display: f.compact(tier.spend),
          })),
      },
      {
        kind: "donut",
        title: t("spotlight.spendByGrade"),
        format: "money",
        slices: data.gradeBreakdown
          .filter((grade) => cmp(grade.spend, "0") > 0)
          .map((grade) => ({
            name: t("spotlight.grade", { grade: grade.grade }),
            value: chartOf(grade.spend),
            display: f.compact(grade.spend),
            tone: gradeTone[grade.grade] ?? "neutral",
          })),
      },
    ],
  };
}

type SpendRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"spend-velocity">>>;
async function spendVelocitySpotlight(
  t: Translate,
  orgId: string,
  read: SpendRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const f = await formatters(orgId, currency);
  const { data, periodLabel } = read;
  const s = data.summary;
  const cfg = data.config;
  const velocityTone = (velocity: number | null): SpotlightTone =>
    velocity === null
      ? "neutral"
      : velocity > cfg.velocityMediumThreshold
        ? "negative"
        : velocity < -cfg.velocityMediumThreshold
          ? "positive"
          : "neutral";
  const healthLabel =
    s.healthScore >= cfg.healthGradeB
      ? t("spendVelocity.health.healthy")
      : s.healthScore >= cfg.healthGradeC
        ? t("spendVelocity.health.watch")
        : s.healthScore >= cfg.healthGradeD
          ? t("spendVelocity.health.elevated")
          : t("spendVelocity.health.atRisk");
  const insightTone: Record<string, SpotlightTone> = {
    alert: "negative",
    warning: "caution",
    info: "neutral",
  };
  const withVelocity = data.accountVelocity
    .filter((row) => row.velocity !== null)
    .sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
  return {
    slug: "spend-velocity",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("spendVelocity.kpi.totalSpend"),
      value: f.money(s.totalSpend),
      detail: t("spendVelocity.sub.accountsCount", { count: s.accountCount }),
    },
    figures: [
      {
        label: t("spendVelocity.kpi.avgVelocity"),
        value: s.avgVelocity === null ? "—" : f.points(s.avgVelocity, true),
        detail: t("spendVelocity.sub.acceleratingCount", { count: s.acceleratingCount }),
        tone: velocityTone(s.avgVelocity),
      },
      {
        label: t("spendVelocity.kpi.alerts"),
        value: f.count(s.totalAlerts),
        tone: s.totalAlerts > 0 ? "caution" : "positive",
      },
      {
        label: t("spendVelocity.kpi.savingsPotential"),
        value: s.savingsPotential === null ? "—" : f.compact(s.savingsPotential),
        tone: "positive",
      },
      { label: t("spotlight.spendHealth"), value: outOf100(f, s.healthScore), detail: healthLabel },
    ],
    feature: {
      kind: "trend",
      title: t("spendVelocity.panels.monthlySpendVelocity"),
      labels: data.monthlyTrends.map((month) => month.label),
      format: "money",
      series: [
        {
          name: t("spendVelocity.chart.spend"),
          values: data.monthlyTrends.map((month) => chartOf(month.totalAmount)),
          style: "bar",
          role: "primary",
        },
        {
          name: t("spendVelocity.chart.priorYear"),
          values: data.monthlyTrends.map((month) => chartOf(month.priorYearAmount)),
          style: "dashed",
          role: "muted",
        },
      ],
    },
    panels: [
      {
        kind: "gauge",
        title: t("spotlight.spendHealth"),
        score: s.healthScore,
        display: outOf100(f, s.healthScore),
        caption: healthLabel,
        goodWhenHigh: true,
        // Omitted detectors caveat the score: the ring stays untoned.
        bands:
          s.unconfiguredDetectors.length > 0
            ? null
            : { excellent: cfg.healthGradeB, good: cfg.healthGradeC, average: cfg.healthGradeD },
      },
      {
        kind: "ranking",
        title: t("spendVelocity.panels.highestVelocity"),
        empty: t("spotlight.empty"),
        rows: ranked(
          withVelocity,
          (row) => row.velocity ?? 0,
          (row) => ({
            name: row.name,
            value: f.points(row.velocity ?? 0, true),
            detail: f.compact(row.totalSpend),
            tone: velocityTone(row.velocity),
          }),
        ),
      },
      {
        kind: "ranking",
        title: t("spendVelocity.panels.top10BySpend"),
        empty: t("spotlight.empty"),
        rows: rankedMoney(
          sortedMoney(data.accountVelocity, (row) => row.totalSpend),
          (row) => row.totalSpend,
          (row) => ({
            name: row.name,
            value: f.compact(row.totalSpend),
            detail: row.velocity === null ? undefined : f.points(row.velocity, true),
            tone: velocityTone(row.velocity),
          }),
        ),
      },
      {
        kind: "insights",
        title: t("spendVelocity.panels.insights"),
        empty: t("spotlight.noFindings"),
        items: data.insights.slice(0, RANK_ROWS).map((insight) => ({
          tone: insightTone[insight.type] ?? "neutral",
          title: insight.title,
          detail: insight.message,
        })),
      },
    ],
  };
}

type TrueCostRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"true-cost">>>;
async function trueCostSpotlight(
  t: Translate,
  orgId: string,
  read: TrueCostRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const { data, periodLabel, refusal } = read;
  if (!data)
    return {
      slug: "true-cost",
      periodLabel,
      observedAt: observedOf(read),
      currency,
      figures: [],
      panels: [],
      notice: refusal ?? t("hub.loadError"),
    };
  const f = await formatters(orgId, currency);
  const k = data.kpis;
  // A rate in the composite's own format — never $/hr for every format.
  const rate = (value: number | null) => {
    if (value === null) return "—";
    switch (k.compositeFormat ?? "per_hour") {
      case "percent_labor":
      case "percent_cost":
        return f.points(value);
      case "per_fte":
        return t("trueCost.formats.perFte", { amount: f.compact(value) });
      case "per_unit":
        return t("trueCost.formats.perUnit", { amount: f.compact(value) });
      default:
        return t("trueCost.formats.perHour", { amount: f.compact(value) });
    }
  };
  const absorptionTone: SpotlightTone =
    k.absorptionPct === null ? "neutral" : k.absorptionPct >= 100 ? "positive" : "caution";
  const rateIsMoney = k.compositeFormat === null || k.compositeFormat === "per_hour";
  const ratePercent = k.compositeFormat === "percent_labor" || k.compositeFormat === "percent_cost";
  const departments = data.departments
    .flatMap((dept) => {
      const value = data.totals.byDept[dept.id];
      return value == null ? [] : [{ dept, value }];
    })
    .sort((a, b) => b.value - a.value);
  return {
    slug: "true-cost",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("trueCost.hero.compositeRate"),
      value: k.compositeRate === null ? t("trueCost.hero.notAvailable") : rate(k.compositeRate),
      detail:
        k.compositeRateChangePct === null
          ? t("trueCost.hero.compositeSubDefault")
          : t("trueCost.hero.vsPrior", {
              arrow: k.compositeRateChangePct > 0 ? "▲" : k.compositeRateChangePct < 0 ? "▼" : "•",
              change: f.points(Math.abs(k.compositeRateChangePct)),
            }),
      tone:
        k.compositeRateChangePct === null
          ? "neutral"
          : k.compositeRateChangePct > 0
            ? "caution"
            : "positive",
    },
    figures: [
      {
        label: t("trueCost.hero.totalOverhead"),
        value: f.compact(k.totalOverhead),
        detail: t("trueCost.hero.accountsCount", { count: k.overheadAccounts }),
      },
      {
        label: t("trueCost.hero.absorption"),
        value: k.absorptionPct === null ? "—" : f.points(k.absorptionPct),
        detail:
          k.absorptionPct === null
            ? (data.absorptionUnavailable ?? undefined)
            : k.absorptionPct >= 100
              ? t("trueCost.hero.overAbsorbed")
              : t("trueCost.hero.underAbsorbed"),
        tone: absorptionTone,
      },
      {
        label: t("trueCost.hero.overheadApplied"),
        value:
          k.burdenApplied === null ? t("trueCost.hero.notAvailable") : f.compact(k.burdenApplied),
      },
      {
        label: t("trueCost.hero.billedHours"),
        value: f.count(k.billedHours),
        detail: t("trueCost.hero.utilizationPct", { pct: f.fraction(k.utilization) }),
      },
    ],
    feature: {
      kind: "trend",
      title: t("trueCost.hero.overheadApplied"),
      labels: data.monthly.map((month) => month.label),
      format: "money",
      series: [
        {
          name: t("trueCost.hero.overheadApplied"),
          values: data.monthly.map((month) => chartOf(month.burden)),
          style: "bar",
          role: "primary",
        },
      ],
    },
    panels: [
      {
        kind: "donut",
        title: t("trueCost.panels.overheadCategories"),
        format: "money",
        slices: data.categories
          .filter((category) => category.totalAmount > 0)
          .map((category) => ({
            name: category.name,
            value: category.totalAmount,
            display: f.compact(category.totalAmount),
            ...(category.color ? { color: category.color } : {}),
          })),
        center: { label: t("trueCost.hero.totalOverhead"), value: f.compact(k.totalOverhead) },
      },
      {
        kind: "ranking",
        title: t("trueCost.panels.rateByDepartment"),
        empty: t("spotlight.empty"),
        rows: ranked(
          departments,
          (row) => row.value,
          (row) => ({
            name: row.dept.name,
            value: rate(row.value),
            detail: t("spotlight.hours", { hours: f.count(row.dept.billedHours) }),
          }),
        ),
      },
      ...(rateIsMoney || ratePercent
        ? [
            {
              kind: "trend" as const,
              title: t("trueCost.panels.compositeTrend"),
              labels: data.monthly.map((month) => month.label),
              format: ratePercent ? ("percent" as const) : ("money" as const),
              series: [
                {
                  name: t("trueCost.hero.compositeRate"),
                  values: data.monthly.map((month) => month.rate),
                  style: "area" as const,
                  role: "secondary" as const,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

type UtilizationRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"utilization">>>;
async function utilizationSpotlight(
  t: Translate,
  orgId: string,
  read: UtilizationRead,
): Promise<AnalyticsSpotlight> {
  const currency = await presentationCurrency(orgId);
  const f = await formatters(orgId, currency);
  const { data, periodLabel } = read;
  const c = data.company.range;
  const cfg = data.config;
  const diff = c.percentBilled - cfg.target;
  const tone: SpotlightTone =
    diff >= 0 ? "positive" : diff >= -cfg.watchBandPp ? "caution" : "negative";
  const caption =
    diff >= 0
      ? t("utilization.gauge.onTarget")
      : diff >= -cfg.watchBandPp
        ? t("utilization.gauge.nearTarget")
        : diff >= -cfg.warnBandPp
          ? t("utilization.gauge.belowTarget")
          : t("utilization.gauge.atRisk");
  // History periods arrive newest first; a trend reads oldest → newest.
  const history = [...data.history.periods].reverse();
  const delta = data.company.deltas.pctDelta;
  const departments = sortedMoney(data.departments, (row) => row.range.nonBillableCost);
  return {
    slug: "utilization",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: {
      label: t("hub.utilizationRate"),
      value: f.points(c.percentBilled),
      detail: t("utilization.sub.targetPct", { target: cfg.target }),
      tone,
    },
    figures: [
      {
        label: t("utilization.kpi.billableHours"),
        value: f.count(c.billableHours),
        detail: t("utilization.sub.revenueGenerating"),
      },
      {
        label: t("utilization.kpi.nonBillableCost"),
        value: f.compact(c.nonBillableCost),
        tone: "caution",
      },
      {
        label: t("spotlight.changeVsPrior"),
        value: t("spotlight.points", { points: f.signedCount(delta) }),
        tone: delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral",
      },
      {
        label: t("utilization.kpi.totalHours"),
        value: f.count(c.hours),
        detail: t("utilization.sub.recordedTime"),
      },
    ],
    feature: {
      kind: "trend",
      title: t("spotlight.utilizationTrend"),
      labels: history.map((period) => period.label),
      format: "percent",
      series: [
        {
          name: t("hub.utilizationRate"),
          values: history.map((period) => period.companyPct),
          style: "area",
          role: "primary",
        },
      ],
      reference: { value: cfg.target, label: t("utilization.chart.target") },
    },
    panels: [
      {
        kind: "gauge",
        title: t("hub.utilizationRate"),
        score: c.percentBilled,
        display: f.points(c.percentBilled),
        caption,
        goodWhenHigh: true,
        bands: {
          excellent: cfg.target,
          good: cfg.target - cfg.watchBandPp,
          average: cfg.target - cfg.warnBandPp,
        },
      },
      {
        kind: "donut",
        title: t("utilization.panels.hoursDistribution"),
        format: "count",
        slices: [
          {
            name: t("utilization.chart.billable"),
            value: c.billableHours,
            display: t("spotlight.hours", { hours: f.count(c.billableHours) }),
            tone: "positive" as const,
          },
          {
            name: t("utilization.chart.nonBillable"),
            value: c.nonBillableHours,
            display: t("spotlight.hours", { hours: f.count(c.nonBillableHours) }),
            tone: "caution" as const,
          },
        ].filter((slice) => slice.value > 0),
        center: { label: t("hub.utilizationRate"), value: f.points(c.percentBilled) },
      },
      {
        kind: "ranking",
        title: t("utilization.panels.topDepartments"),
        empty: t("spotlight.empty"),
        rows: rankedMoney(
          departments,
          (row) => row.range.nonBillableCost,
          (row) => ({
            name: row.name,
            value: f.compact(row.range.nonBillableCost),
            detail: t("spotlight.billedShare", { pct: f.points(row.range.percentBilled) }),
            tone:
              row.range.percentBilled >= cfg.target
                ? "positive"
                : row.range.percentBilled >= cfg.target - cfg.watchBandPp
                  ? "caution"
                  : "negative",
          }),
        ),
      },
      {
        kind: "insights",
        title: t("utilization.panels.alerts"),
        empty: t("spotlight.noFindings"),
        items: data.company.alerts.slice(0, RANK_ROWS).map((alert) => ({
          tone: alert.type === "danger" ? ("negative" as const) : ("caution" as const),
          title: alert.message,
        })),
      },
    ],
  };
}

type SentinelRead = Awaited<ReturnType<typeof readAnalyticsDashboard<"sentinel">>>;
async function sentinelSpotlight(
  t: Translate,
  orgId: string,
  read: SentinelRead,
): Promise<AnalyticsSpotlight> {
  const { data, periodLabel } = read;
  const currency = data.meta.presentationCurrency;
  const f = await formatters(orgId, currency);
  const s = data.summary;
  const score = s.overallRiskScore;
  const riskLabel =
    score >= RISK_SCORE_BANDS.high
      ? t("sentinel.risk.high")
      : score >= RISK_SCORE_BANDS.elevated
        ? t("sentinel.risk.elevated")
        : score >= RISK_SCORE_BANDS.moderate
          ? t("sentinel.risk.moderate")
          : t("sentinel.risk.low");
  const tone: SpotlightTone =
    score >= RISK_SCORE_BANDS.elevated
      ? "negative"
      : score >= RISK_SCORE_BANDS.moderate
        ? "caution"
        : "positive";
  const severityTone: Record<string, SpotlightTone> = {
    critical: "negative",
    high: "caution",
    medium: "neutral",
  };
  const detectors = [
    { label: t("sentinel.detectors.duplicates"), count: s.duplicateCount },
    { label: t("sentinel.kpi.weekendDocuments"), count: s.weekendCount },
    { label: t("sentinel.detectors.rsf"), count: s.rsfCount },
    { label: t("sentinel.detectors.zscore"), count: s.zScoreCount },
    { label: t("sentinel.detectors.trap"), count: s.trapCount },
    { label: t("sentinel.panels.sequentialRuns"), count: s.sequentialGroups },
    { label: t("sentinel.detectors.ghostVendors"), count: s.ghostCount },
  ];
  const vendors = [...data.vendorRisk].sort((a, b) => b.compositeScore - a.compositeScore);
  return {
    slug: "sentinel",
    periodLabel,
    observedAt: observedOf(read),
    currency,
    headline: { label: t("hub.riskScore"), value: outOf100(f, score), detail: riskLabel, tone },
    figures: [
      {
        label: t("sentinel.kpi.flagged"),
        value: f.count(s.flaggedCount),
        tone: s.flaggedCount > 0 ? "caution" : "positive",
      },
      {
        label: t("sentinel.kpi.valueAtRisk"),
        value: f.compact(s.totalAtRisk),
        tone: cmp(s.totalAtRisk, "0") > 0 ? "negative" : "positive",
      },
      {
        label: t("sentinel.kpi.duplicatePairs"),
        value: f.count(s.duplicateCount),
        detail: f.compact(s.totalDuplicateAmount),
        tone: s.duplicateCount > 0 ? "negative" : "positive",
      },
      {
        label: t("sentinel.kpi.weekendDocuments"),
        value: f.count(s.weekendCount),
        detail: f.compact(s.weekendAmount),
      },
      { label: t("sentinel.kpi.trapAmounts"), value: f.count(s.trapCount) },
    ],
    feature: {
      kind: "trend",
      title: t("sentinel.panels.detectorSummary"),
      labels: detectors.map((detector) => detector.label),
      format: "count",
      series: [
        {
          name: t("sentinel.kpi.flagged"),
          values: detectors.map((detector) => detector.count),
          style: "bar",
          role: "caution",
        },
      ],
    },
    ...(s.excludedDetectors.length > 0
      ? { notice: t("sentinel.risk.excludedNote", { detectors: s.excludedDetectors.join(", ") }) }
      : {}),
    panels: [
      {
        kind: "gauge",
        title: t("hub.riskScore"),
        score,
        display: outOf100(f, score),
        caption: riskLabel,
        goodWhenHigh: false,
        // A score that omits unconfigured detectors carries no verdict.
        bands:
          s.excludedDetectors.length > 0
            ? null
            : {
                excellent: 100 - RISK_SCORE_BANDS.moderate,
                good: 100 - RISK_SCORE_BANDS.elevated,
                average: 100 - RISK_SCORE_BANDS.high,
              },
      },
      {
        kind: "insights",
        title: t("sentinel.panels.topRiskAreas"),
        empty: t("spotlight.noFindings"),
        items: s.topRiskAreas.slice(0, RANK_ROWS).map((area) => ({
          tone: severityTone[area.severity] ?? "neutral",
          title: area.area,
          detail: area.message,
        })),
      },
      {
        kind: "ranking",
        title: t("sentinel.panels.vendorRiskRollup"),
        empty: t("spotlight.empty"),
        rows: ranked(
          vendors,
          (vendor) => vendor.compositeScore,
          (vendor) => ({
            name: vendor.partyName,
            value: f.compact(vendor.totalAmount),
            detail: t("sentinel.vendors.drillSub", {
              flags: vendor.flagCount,
              amount: f.compact(vendor.totalAmount),
            }),
            tone: vendor.maxRiskScore >= RISK_SCORE_BANDS.high ? "negative" : "caution",
          }),
        ),
      },
      {
        kind: "trend",
        title: t("sentinel.panels.spendCalendar"),
        labels: data.calendar.map((day) => day.date),
        format: "money",
        series: [
          {
            name: t("sentinel.kpi.totalValue"),
            values: data.calendar.map((day) => chartOf(day.amount)),
            style: "bar",
            role: "secondary",
          },
        ],
      },
    ],
  };
}
