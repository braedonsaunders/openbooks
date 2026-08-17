import "server-only";
import { z } from "zod";
import { withOrg } from "@openbooks/engine/src/db.ts";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, num, capList } from "./tools-shared";
import { healthData } from "../analytics/health-data";
import { customerData, customerProfitability } from "../analytics/customer-data";
import { vendorData } from "../analytics/vendor-data";
import { cashflowData } from "../analytics/cashflow-data";
import { trueCostData } from "../analytics/true-cost-data";
import { utilizationData } from "../analytics/utilization-data";
import { spendVelocityData } from "../analytics/spend-velocity-data";
import { sentinelData } from "../analytics/sentinel-data";
import { analyticsConfig } from "../analytics/config";
import { apPosition } from "../cash/ap-position";
import { arPosition } from "../cash/ar-position";
import { cashPosition } from "../cash/cash-position";
import type { CategoryWeekly, ForecastEntry, WeekRow } from "../cash/core";

/**
 * Analytics-dashboard + cash-cockpit read tools for the agentic assistant.
 * Each tool calls the exact data function its dashboard renders from
 * (web/lib/analytics/*, web/lib/cash/*) so the assistant can never disagree
 * with the screens, then trims the payload: scalars/vitals kept as-is, every
 * array capped, wide rows mapped down to their informative fields.
 *
 * Several of these data functions scope by the RLS GUC only (no explicit
 * orgId filter in SQL), so EVERY data call is wrapped in
 * `withOrg(authz.user.orgId, ...)` — same precedent as the internal report
 * render route.
 */

// ---------------------------------------------------------------------------
// shared input + shaping helpers
// ---------------------------------------------------------------------------

const periodInput = z.object({ fromDate: dateInput, toDate: dateInput });

type PeriodArgs = { fromDate: string; toDate: string };

function buildPeriod(a: PeriodArgs): { from: string; to: string; label: string } {
  return { from: a.fromDate, to: a.toDate, label: `${a.fromDate} – ${a.toDate}` };
}

function invalidPeriod(a: PeriodArgs): ToolResult | null {
  if (a.fromDate > a.toDate) return { ok: false, error: "invalid_period" };
  return null;
}

/** Compact map of a shared-engine forecast entry (AR/AP schedule line). */
function slimEntry(e: ForecastEntry) {
  return {
    docId: e.docId,
    docKind: e.docKind,
    docNumber: e.docNumber,
    partyName: e.partyName,
    amount: num(e.amount),
    tranDate: e.tranDate,
    dueDate: e.dueDate,
    predictedDate: e.predictedDate,
    daysOverdue: e.daysOverdue,
  };
}

/** Weekly cash-timeline row without the nested per-entry drill lists. */
function slimWeek(w: WeekRow) {
  return {
    weekStart: w.weekStart,
    weekEnd: w.weekEnd,
    label: w.label,
    inflow: num(w.inflow),
    outflow: num(w.outflow),
    net: num(w.net),
    startingCash: num(w.startingCash),
    endingCash: num(w.endingCash),
    dynamicInflow: num(w.dynamicInflow),
    dynamicOutflow: num(w.dynamicOutflow),
    deferredOut: num(w.deferredOut),
    apCapacity: w.apCapacity === null ? null : num(w.apCapacity),
  };
}

/** Recurring forecast category without the breakdown/logic drill payload. */
function slimCategory(c: CategoryWeekly) {
  return {
    id: c.id,
    name: c.name,
    direction: c.direction,
    method: c.method,
    total: num(c.total),
    weekly: c.weekly.map((n) => num(n)),
  };
}

/** The org's AP capacity-scheduling knobs, exactly as the AP/AR/Cash pages
 *  build them from the cashflow analytics config. */
async function loadApSettings(orgId: string): Promise<{ weeklyCap: number; restrictToSafe: boolean }> {
  const cfg = await analyticsConfig(orgId, "cashflow");
  return { weeklyCap: cfg.weeklyApCap ?? 0, restrictToSafe: (cfg.restrictToSafe ?? 0) >= 1 };
}

// ---------------------------------------------------------------------------
// 1. Financial Health
// ---------------------------------------------------------------------------

const financialHealthTool: AssistantToolDef = {
  name: "analytics_financial_health",
  description:
    "Financial Health dashboard for a posting-date period: overall health score, ratio scorecard graded vs benchmarks, raw figures, 12-month P&L series, margin waterfall, department/class/location segment performance, revenue and cost drivers, item movers, budget variance, and generated insights. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const r = await withOrg(authz.user.orgId, () => healthData(buildPeriod(a), authz.user.orgId));
    const ratios = Object.fromEntries(
      Object.entries(r.ratios).map(([cat, list]) => [
        cat,
        list.map((x) => ({
          id: x.id,
          value: x.value,
          format: x.format,
          benchmark: x.benchmark,
          calc: x.calc,
          score: x.score,
          grade: x.grade,
          ...(x.noData ? { noData: true } : {}),
        })),
      ]),
    );
    return {
      ok: true,
      data: {
        period: r.period,
        overallScore: r.overallScore,
        scoreLabel: r.scoreLabel,
        hasBalanceSheet: r.hasBalanceSheet,
        hasDA: r.hasDA,
        hasHeadcount: r.hasHeadcount,
        figures: r.figures,
        categoryScores: r.categoryScores,
        ratios,
        benchmarks: r.benchmarks,
        monthly: r.monthly,
        pnlSummary: r.pnlSummary,
        marginFlow: r.marginFlow,
        segments: {
          department: capList(r.segments.department, 50),
          class: capList(r.segments.class, 50),
          location: capList(r.segments.location, 50),
        },
        drivers: {
          revenue: capList(r.drivers.revenue, 50),
          cost: capList(r.drivers.cost, 50),
        },
        items: {
          totalCurrent: num(r.items.totalCurrent),
          totalChange: num(r.items.totalChange),
          gainers: capList(r.items.gainers, 25),
          decliners: capList(r.items.decliners, 25),
          rows: capList(r.items.rows, 50),
        },
        budget: {
          scenario: r.budget.scenario,
          totals: r.budget.totals,
          rows: capList(r.budget.rows, 50),
        },
        insights: capList(r.insights, 25),
        href: "/analytics/financial-health",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 2. Customer Intelligence
// ---------------------------------------------------------------------------

const customerIntelligenceTool: AssistantToolDef = {
  name: "analytics_customer_intelligence",
  description:
    "Customer Intelligence dashboard for a posting-date period: intelligence score, per-customer RFM segment, CLV tier, churn and friction risk, payment behaviour and health grade, concentration (HHI), monthly growth, cohort retention, insights, plus job-costed customer profitability with fake-champion detection. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const period = buildPeriod(a);
    const orgId = authz.user.orgId;
    const [r, prof] = await withOrg(orgId, () =>
      Promise.all([customerData(period, orgId), customerProfitability(period, orgId)]),
    );
    return {
      ok: true,
      data: {
        period: r.period,
        intelligence: r.intelligence,
        kpis: r.kpis,
        segments: r.segments,
        tierBreakdown: r.tierBreakdown,
        growth: {
          yoyGrowth: r.growth.yoyGrowth,
          avgMonthlyGrowth: r.growth.avgMonthlyGrowth,
          medianMonthlyRevenue: num(r.growth.medianMonthlyRevenue),
          totalNewCustomers: r.growth.totalNewCustomers,
          trend: r.growth.trend,
          monthly: capList(r.growth.monthly, 24),
        },
        cohorts: r.cohorts,
        insights: capList(r.insights, 25),
        config: r.config,
        customers: capList(
          r.rows.map((c) => ({
            id: c.id,
            name: c.name,
            revenue: num(c.revenue),
            yoyPct: c.yoyPct,
            invoices: c.invoices,
            avgInvoice: num(c.avgInvoice),
            recencyDays: c.recencyDays,
            segment: c.segment,
            tier: c.tier,
            clv: num(c.clv),
            churnScore: c.churnScore,
            churnLevel: c.churnLevel,
            frictionLevel: c.frictionLevel,
            paymentRating: c.paymentRating,
            avgDaysToPay: c.avgDaysToPay,
            sharePct: c.sharePct,
            concentrationRisk: c.concentrationRisk,
            marginPct: c.marginPct,
            isFakeChampion: c.isFakeChampion,
            healthScore: c.healthScore,
            healthGrade: c.healthGrade,
            recommendation: c.recommendation,
          })),
          50,
        ),
        profitability: {
          summary: prof.summary,
          customers: capList(
            prof.customers.map((c) => ({
              customerId: c.customerId,
              customerName: c.customerName,
              totalRevenue: num(c.totalRevenue),
              totalCost: num(c.totalCost),
              grossProfit: num(c.grossProfit),
              marginPct: c.marginPct,
              profitTier: c.profitTier,
              isFakeChampion: c.isFakeChampion,
            })),
            50,
          ),
        },
        href: "/analytics/customer-intelligence",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 3. Vendor Performance
// ---------------------------------------------------------------------------

const vendorPerformanceTool: AssistantToolDef = {
  name: "analytics_vendor_performance",
  description:
    "Vendor Performance dashboard for a posting-date period: per-vendor spend with YoY change, spend tiers, payment-relationship scorecard grades, leverage-matrix quadrants, concentration (HHI, top-5/10 share), and the 12-month spend trend. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    // vendorData takes no orgId — it is scoped purely by the RLS GUC set here.
    const r = await withOrg(authz.user.orgId, () => vendorData(buildPeriod(a)));
    return {
      ok: true,
      data: {
        period: r.period,
        totals: r.totals,
        tierBreakdown: r.tierBreakdown,
        gradeBreakdown: r.gradeBreakdown,
        quadrantBreakdown: r.quadrantBreakdown,
        monthly: r.monthly,
        vendors: capList(
          r.rows.map((v) => ({
            id: v.id,
            name: v.name,
            spend: num(v.spend),
            yoyPct: v.yoyPct,
            sharePct: v.sharePct,
            bills: v.bills,
            avgBill: num(v.avgBill),
            lastBill: v.lastBill,
            recencyDays: v.recencyDays,
            tier: v.tier,
            avgDaysToPay: v.avgDaysToPay,
            onTimePct: v.onTimePct,
            lateSpend: num(v.lateSpend),
            score: v.score,
            grade: v.grade,
            quadrant: v.quadrant,
          })),
          50,
        ),
        href: "/analytics/vendor-performance",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 4. Cash Flow forecast
// ---------------------------------------------------------------------------

const cashflowTool: AssistantToolDef = {
  name: "analytics_cashflow",
  description:
    "Cash Flow forecast: bank balances rolled through a 4, 8, or 12-week timeline (default 4) of predicted AR collections, capacity-scheduled AP payments, and recurring category flows — runway, burn rate, lowest-cash week, DSO/DPO, AR/AP aging summaries. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    horizonWeeks: z.union([z.literal(4), z.literal(8), z.literal(12)]).optional(),
    asOfDate: dateInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { horizonWeeks?: 4 | 8 | 12; asOfDate?: string };
    const horizon = a.horizonWeeks ?? 4;
    const r = await withOrg(authz.user.orgId, () => cashflowData(authz.user.orgId, horizon, a.asOfDate));
    return {
      ok: true,
      data: {
        asOf: r.asOf,
        horizonWeeks: r.horizonWeeks,
        startingCash: num(r.startingCash),
        summary: r.summary,
        ar: r.ar,
        ap: r.ap,
        apSettings: r.apSettings,
        deferredBeyondHorizon: num(r.deferredBeyondHorizon),
        bankAccounts: capList(
          r.bankAccounts.map((b) => ({ id: b.id, name: b.name, number: b.number, balance: num(b.balance) })),
          50,
        ),
        weeks: r.weeks.map(slimWeek),
        categories: capList(r.categories.map(slimCategory), 50),
        href: "/analytics/cashflow",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 5. True Cost
// ---------------------------------------------------------------------------

const trueCostTool: AssistantToolDef = {
  name: "analytics_true_cost",
  description:
    "True Cost overhead engine for a period: company composite burden rate ($/billable hr), burden categories with rates and classified accounts, department composites, absorption gap, employee labour cost rates, monthly trend and forecast. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const r = await withOrg(authz.user.orgId, () => trueCostData(authz.user.orgId, buildPeriod(a)));
    return {
      ok: true,
      data: {
        period: r.period,
        kpis: r.kpis,
        hasBurdenGL: r.hasBurdenGL,
        departments: capList(
          r.departments.map((d) => ({
            id: d.id,
            name: d.name,
            billedHours: num(d.billedHours),
            totalHours: num(d.totalHours),
            composite: num(d.composite),
          })),
          50,
        ),
        categories: capList(
          r.categories.map((c) => ({
            id: c.id,
            key: c.key,
            name: c.name,
            categoryType: c.categoryType,
            totalAmount: num(c.totalAmount),
            rate: c.rate,
            rawRate: num(c.rawRate),
            rateDisplay: c.rateDisplay,
            allocationBase: c.allocationBase,
            allocationMethod: c.allocationMethod,
            rateFormat: c.rateFormat,
            includeInComposite: c.includeInComposite,
            accounts: capList(
              c.accounts.map((x) => ({ id: x.id, number: x.number, name: x.name, amount: num(x.amount), pinned: x.pinned })),
              10,
            ),
          })),
          50,
        ),
        unassigned: capList(
          r.unassigned.map((x) => ({ id: x.id, number: x.number, name: x.name, amount: num(x.amount), pinned: x.pinned })),
          25,
        ),
        totals: r.totals,
        labor: {
          count: r.labor.count,
          min: num(r.labor.min),
          max: num(r.labor.max),
          weighted: num(r.labor.weighted),
          employees: capList(
            r.labor.employees.map((e) => ({
              id: e.id,
              name: e.name,
              deptName: e.deptName,
              title: e.title,
              rate: num(e.rate),
              hours: num(e.hours),
            })),
            50,
          ),
        },
        monthly: r.monthly,
        forecast: r.forecast,
        config: {
          activeProfileId: r.config.activeProfileId,
          compositeMethod: r.config.compositeMethod,
          baseLaborRate: r.config.baseLaborRate,
          fringeRate: r.config.fringeRate,
          profiles: r.config.profiles,
        },
        href: "/analytics/true-cost",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 6. Utilization
// ---------------------------------------------------------------------------

const utilizationTool: AssistantToolDef = {
  name: "analytics_utilization",
  description:
    "Utilization dashboard for a period: company billable-hours utilization vs target with non-billable cost and alerts, department / service-item / employee breakdowns with prior-period deltas, and the rolling utilization history. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const r = await withOrg(authz.user.orgId, () => utilizationData(authz.user.orgId, buildPeriod(a)));
    const slimGroup = (g: (typeof r.departments)[number]) => ({
      id: g.id,
      name: g.name,
      ...(g.title ? { title: g.title } : {}),
      ...(g.departmentName ? { departmentName: g.departmentName } : {}),
      range: g.range,
      prior: g.prior,
      deltas: g.deltas,
      meetsMinHours: g.meetsMinHours,
      ...(g.noBillable ? { noBillable: true } : {}),
    });
    return {
      ok: true,
      data: {
        period: r.period,
        prior: r.prior,
        config: r.config,
        company: r.company,
        departments: capList(r.departments.map(slimGroup), 50),
        items: capList(r.items.map(slimGroup), 50),
        employees: capList(r.employees.map(slimGroup), 50),
        history: { periodMonths: r.history.periodMonths, periods: capList(r.history.periods, 24) },
        href: "/analytics/utilization",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 7. Spend Velocity
// ---------------------------------------------------------------------------

const spendVelocityTool: AssistantToolDef = {
  name: "analytics_spend_velocity",
  description:
    "Spend Velocity dashboard for a period: account and vendor spend growth (CAGR velocity + acceleration), anomaly detection, monthly and seasonal trends, boiling-frog creep, concentration, zombie subscriptions, fragmentation, commitment cliff, expense analysis, and period comparison. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const r = await withOrg(authz.user.orgId, () => spendVelocityData(authz.user.orgId, buildPeriod(a)));
    const slimVelocity = (v: (typeof r.accountVelocity)[number]) => ({
      id: v.id,
      name: v.name,
      entityType: v.entityType,
      totalSpend: num(v.totalSpend),
      transactionCount: v.transactionCount,
      billPct: v.billPct,
      expensePct: v.expensePct,
      velocity: v.velocity,
      acceleration: v.acceleration,
      trend: v.trend,
      latestSpend: num(v.latestSpend),
      previousSpend: num(v.previousSpend),
      avgMonthlySpend: num(v.avgMonthlySpend),
    });
    return {
      ok: true,
      data: {
        period: r.period,
        summary: r.summary,
        accountVelocity: capList(r.accountVelocity.map(slimVelocity), 50),
        vendorVelocity: capList(r.vendorVelocity.map(slimVelocity), 50),
        anomalies: { summary: r.anomalies.summary, items: capList(r.anomalies.items, 50) },
        monthlyTrends: capList(r.monthlyTrends, 24),
        seasonal: r.seasonal,
        boilingFrog: {
          summary: r.boilingFrog.summary,
          accounts: capList(
            r.boilingFrog.accounts.map((x) => ({
              accountId: x.accountId,
              accountName: x.accountName,
              monotonicRatio: x.monotonicRatio,
              avgMonthlyIncrease: num(x.avgMonthlyIncrease),
              totalCreep: num(x.totalCreep),
              annualizedCreep: num(x.annualizedCreep),
              monthCount: x.monthCount,
              severity: x.severity,
            })),
            25,
          ),
        },
        concentration: {
          summary: r.concentration.summary,
          accounts: capList(
            r.concentration.accounts.map((x) => ({ ...slimVelocity(x), spendShare: x.spendShare })),
            25,
          ),
        },
        zombies: { summary: r.zombies.summary, subscriptions: capList(r.zombies.subscriptions, 25) },
        fragmentation: { summary: r.fragmentation.summary, categories: capList(r.fragmentation.categories, 25) },
        shadowIT: r.shadowIT,
        commitmentCliff: { summary: r.commitmentCliff.summary, months: capList(r.commitmentCliff.months, 24) },
        revenue: r.revenue,
        insights: capList(r.insights, 25),
        periodComparison: {
          summary: r.periodComparison.summary,
          accounts: capList(
            r.periodComparison.accounts.map((x) => ({
              accountId: x.accountId,
              accountName: x.accountName,
              currentAmount: num(x.currentAmount),
              priorAmount: num(x.priorAmount),
              twoBackAmount: num(x.twoBackAmount),
              changePct: x.changePct,
              projectedAmount: num(x.projectedAmount),
              isNew: x.isNew,
              velocity: x.velocity,
              acceleration: x.acceleration,
              trend: x.trend,
            })),
            50,
          ),
        },
        expenseAnalysis: {
          summary: r.expenseAnalysis.summary,
          topSpenders: capList(r.expenseAnalysis.topSpenders, 25),
          categories: capList(r.expenseAnalysis.categories, 25),
          monthlyTrends: capList(r.expenseAnalysis.monthlyTrends, 24),
        },
        href: "/analytics/spend-velocity",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 8. Sentinel (ledger forensics)
// ---------------------------------------------------------------------------

const sentinelTool: AssistantToolDef = {
  name: "analytics_sentinel",
  description:
    "Sentinel ledger forensics for a posting-date period: Benford first/second-digit conformity, duplicate payment pairs, threshold-trap (just-under-approval-limit) postings, weekend postings, vendor amount outliers (RSF and z-score), sequential invoice runs, ghost-vendor matches, audit-trail deletes/changes, and a per-vendor risk rollup. Every detail list is capped at 50 rows with a truncation flag. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: periodInput,
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as PeriodArgs;
    const bad = invalidPeriod(a);
    if (bad) return bad;
    const r = await withOrg(authz.user.orgId, () => sentinelData(authz.user.orgId, buildPeriod(a)));
    return {
      ok: true,
      data: {
        period: r.period,
        meta: r.meta,
        summary: r.summary,
        config: r.config,
        duplicates: { total: r.duplicates.total, pairs: capList(r.duplicates.pairs, 50) },
        benford1D: {
          totalTransactions: r.benford1D.totalTransactions,
          mad: r.benford1D.mad,
          conformity: r.benford1D.conformity,
          message: r.benford1D.message,
          digits: capList(r.benford1D.digits, 50),
        },
        benford2D: {
          totalTransactions: r.benford2D.totalTransactions,
          mad: r.benford2D.mad,
          conformity: r.benford2D.conformity,
          anomalies: capList(r.benford2D.anomalies, 50),
        },
        thresholdTrap: {
          total: r.thresholdTrap.total,
          totalAmount: num(r.thresholdTrap.totalAmount),
          byTrap: capList(r.thresholdTrap.byTrap, 50),
          items: capList(r.thresholdTrap.items, 50),
        },
        weekend: {
          total: r.weekend.total,
          totalAmount: num(r.weekend.totalAmount),
          saturday: r.weekend.saturday,
          sunday: r.weekend.sunday,
          items: capList(r.weekend.items, 50),
        },
        rsf: { total: r.rsf.total, items: capList(r.rsf.items, 50) },
        zscore: { total: r.zscore.total, items: capList(r.zscore.items, 50) },
        sequential: capList(
          r.sequential.map((g) => ({
            partyId: g.partyId,
            partyName: g.partyName,
            count: g.count,
            totalAmount: num(g.totalAmount),
            startRef: g.startRef,
            endRef: g.endRef,
            dateSpanDays: g.dateSpanDays,
            firstDate: g.firstDate,
            lastDate: g.lastDate,
            riskLevel: g.riskLevel,
            riskScore: g.riskScore,
            reason: g.reason,
            invoices: capList(g.invoices, 10),
          })),
          50,
        ),
        ghosts: capList(r.ghosts, 50),
        auditTrail: {
          total: r.auditTrail.total,
          deletes: r.auditTrail.deletes,
          sensitiveChanges: r.auditTrail.sensitiveChanges,
          events: capList(r.auditTrail.events, 50),
        },
        flagged: capList(r.flagged, 50),
        vendorRisk: capList(r.vendorRisk, 50),
        calendar: capList(r.calendar, 50),
        href: "/analytics/sentinel",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 9. AP cockpit
// ---------------------------------------------------------------------------

const apPositionTool: AssistantToolDef = {
  name: "ap_position",
  description:
    "Accounts Payable operational position (the AP cockpit): open payables outstanding and overdue, aging buckets, the 4-week predicted payment schedule, payables grouped by vendor, the pay-priority worklist, and the capacity-scheduled pay-run recommendation using the org's configured weekly AP cap. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ap.read"] },
  inputSchema: z.object({ asOfDate: dateInput.optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { asOfDate?: string };
    const orgId = authz.user.orgId;
    const r = await withOrg(orgId, async () => {
      const apSettings = await loadApSettings(orgId);
      return apPosition(orgId, 4, apSettings, a.asOfDate);
    });
    return {
      ok: true,
      note: `Open payables ${num(r.outstanding)} (${num(r.overdue)} overdue across ${r.overdueCount} bills); ${num(r.dueThisWeek)} predicted due this week, pay run recommends ${num(r.payPlan.recommendedTotal)}.`,
      data: {
        asOf: r.asOf,
        horizonWeeks: r.horizonWeeks,
        outstanding: num(r.outstanding),
        overdue: num(r.overdue),
        overdueCount: r.overdueCount,
        dueThisWeek: num(r.dueThisWeek),
        dueNext30: num(r.dueNext30),
        dpo: num(r.dpo),
        summary: r.summary,
        weeks: r.weeks.map((w) => ({
          weekStart: w.weekStart,
          weekEnd: w.weekEnd,
          label: w.label,
          amount: num(w.amount),
          count: w.count,
        })),
        byVendor: capList(
          r.byVendor.map((v) => ({
            partyId: v.partyId,
            partyName: v.partyName,
            amount: num(v.amount),
            count: v.count,
            overdue: num(v.overdue),
            oldestDue: v.oldestDue,
          })),
          50,
        ),
        worklist: capList(r.worklist.map(slimEntry), 50),
        payPlan: {
          weeklyCap: num(r.payPlan.weeklyCap),
          restrictToSafe: r.payPlan.restrictToSafe,
          scheduling: r.payPlan.scheduling,
          capacity: r.payPlan.capacity === null ? null : num(r.payPlan.capacity),
          startingCash: num(r.payPlan.startingCash),
          recommendedTotal: num(r.payPlan.recommendedTotal),
          deferredThisWeek: num(r.payPlan.deferredThisWeek),
          deferredBeyondHorizon: num(r.payPlan.deferredBeyondHorizon),
          recommended: capList(r.payPlan.recommended.map(slimEntry), 50),
        },
        categories: capList(r.categories.map(slimCategory), 50),
        href: "/ap",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 10. AR cockpit
// ---------------------------------------------------------------------------

const arPositionTool: AssistantToolDef = {
  name: "ar_position",
  description:
    "Accounts Receivable operational position (the AR cockpit): open receivables outstanding and overdue, aging buckets, the 4-week predicted collection schedule, receivables grouped by customer, and the collections worklist ordered most-overdue first. Lists capped. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read"] },
  inputSchema: z.object({ asOfDate: dateInput.optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { asOfDate?: string };
    const orgId = authz.user.orgId;
    const r = await withOrg(orgId, async () => {
      const apSettings = await loadApSettings(orgId);
      return arPosition(orgId, 4, apSettings, a.asOfDate);
    });
    return {
      ok: true,
      note: `Open receivables ${num(r.outstanding)} (${num(r.overdue)} overdue across ${r.overdueCount} invoices); ${num(r.expectedThisWeek)} expected this week, ${num(r.expectedNext30)} within 30 days.`,
      data: {
        asOf: r.asOf,
        horizonWeeks: r.horizonWeeks,
        outstanding: num(r.outstanding),
        overdue: num(r.overdue),
        overdueCount: r.overdueCount,
        expectedThisWeek: num(r.expectedThisWeek),
        expectedNext30: num(r.expectedNext30),
        dso: num(r.dso),
        summary: r.summary,
        weeks: r.weeks.map((w) => ({
          weekStart: w.weekStart,
          weekEnd: w.weekEnd,
          label: w.label,
          amount: num(w.amount),
          count: w.count,
        })),
        byCustomer: capList(
          r.byCustomer.map((c) => ({
            partyId: c.partyId,
            partyName: c.partyName,
            amount: num(c.amount),
            count: c.count,
            overdue: num(c.overdue),
            oldestDue: c.oldestDue,
          })),
          50,
        ),
        worklist: capList(r.worklist.map(slimEntry), 50),
        categories: capList(r.categories.map(slimCategory), 50),
        href: "/ar",
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 11. Cash cockpit
// ---------------------------------------------------------------------------

const cashPositionTool: AssistantToolDef = {
  name: "cash_position",
  description:
    "Company-wide cash position (the Banking cash cockpit, consolidated — no subsidiary filter): bank balances rolled through a 4, 8, or 12-week forecast timeline (default 8) of predicted AR, capacity-scheduled AP, and recurring category flows, with projected end, lowest-cash week, burn rate, runway, and AR/AP coverage. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["banking.read"] },
  inputSchema: z.object({
    horizonWeeks: z.union([z.literal(4), z.literal(8), z.literal(12)]).optional(),
    asOfDate: dateInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { horizonWeeks?: 4 | 8 | 12; asOfDate?: string };
    const horizon = a.horizonWeeks ?? 8;
    const orgId = authz.user.orgId;
    const r = await withOrg(orgId, async () => {
      const apSettings = await loadApSettings(orgId);
      return cashPosition(orgId, horizon, apSettings, a.asOfDate);
    });
    return {
      ok: true,
      note: `Cash ${num(r.startingCash)} as of ${r.asOf}, projected ${num(r.projectedEnd)} after ${r.horizonWeeks} weeks (lowest ${num(r.lowestCash)} in week of ${r.lowestWeek}); runway ${r.runwayStatus}.`,
      data: {
        asOf: r.asOf,
        horizonWeeks: r.horizonWeeks,
        startingCash: num(r.startingCash),
        totalInflows: num(r.totalInflows),
        totalOutflows: num(r.totalOutflows),
        netChange: num(r.netChange),
        projectedEnd: num(r.projectedEnd),
        lowestCash: num(r.lowestCash),
        lowestWeek: r.lowestWeek,
        burnRate: num(r.burnRate),
        runwayWeeks: r.runwayWeeks === null ? null : num(r.runwayWeeks),
        runwayStatus: r.runwayStatus,
        deferredBeyondHorizon: num(r.deferredBeyondHorizon),
        dso: num(r.dso),
        dpo: num(r.dpo),
        arOutstanding: num(r.arOutstanding),
        apOutstanding: num(r.apOutstanding),
        arCoverage: r.arCoverage,
        apSettings: r.apSettings,
        bankAccounts: capList(
          r.bankAccounts.map((b) => ({ id: b.id, name: b.name, number: b.number, balance: num(b.balance) })),
          50,
        ),
        weeks: r.weeks.map(slimWeek),
        categories: capList(r.categories.map(slimCategory), 50),
        href: "/banking/cash",
      },
    };
  },
};

// ---------------------------------------------------------------------------

export const ANALYTICS_TOOLS: AssistantToolDef[] = [
  financialHealthTool,
  customerIntelligenceTool,
  vendorPerformanceTool,
  cashflowTool,
  trueCostTool,
  utilizationTool,
  spendVelocityTool,
  sentinelTool,
  apPositionTool,
  arPositionTool,
  cashPositionTool,
];
