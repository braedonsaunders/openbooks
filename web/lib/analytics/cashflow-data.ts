import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { analyticsConfig } from "./config";
import {
  bankBalances,
  buildWeekGrid,
  categoryWeekly,
  addMoney,
  compareMoney,
  divideMoney,
  loadCategories,
  normalizeMoneyValue,
  openItems,
  paymentStats,
  resolveAsOf,
  scheduleForecast,
  summariseSide,
  subtractMoney,
  sumMoney,
  toISO,
  ZERO_MONEY,
} from "../cash/core";
import { buildTimeline } from "../cash/cash-position";

/**
 * Cash Flow forecasting — the analytics (read-only) composite. This is the
 * *analytical* read of the cash engine: it explains the future. The operational
 * reads that *act* on the same numbers live in the domain cockpits (AP / AR /
 * Banking-Cash) under `lib/cash/`.
 *
 * Every primitive — open-item prediction, payment statistics, aging, the weekly
 * timeline roll — is shared from `lib/cash/core` and `lib/cash/cash-position`,
 * so this forecast and the cockpits never drift. The model is a faithful port
 * of the Liquidity/Cashflow dashboard.
 */

// Re-export the shared types so existing analytics imports keep working.
export type {
  Side,
  Bucket,
  ForecastEntry,
  WeekRow,
  ForecastCategory,
  CategoryWeekly,
  SideSummary,
} from "../cash/core";

import type { SideSummary } from "../cash/core";

interface AccountOptionRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
}

export interface CashflowData {
  asOf: string;
  horizonWeeks: number;
  startingCash: string;
  bankAccounts: { id: string; name: string; number: string | null; balance: string }[];
  weeks: import("../cash/core").WeekRow[];
  /**
   * Forecast totals per counterparty across the horizon, per side. Computed
   * here because it is an aggregate: the Category tab used to derive it by
   * flattening every week's transactions in the browser, which is the only
   * reason the page had to ship them.
   */
  partyTotals: { ar: { name: string; amount: string; count: number }[]; ap: { name: string; amount: string; count: number }[] };
  summary: {
    startingCash: string;
    projectedEnd: string;
    totalInflows: string;
    totalOutflows: string;
    netChange: string;
    lowestCash: string;
    lowestWeek: string;
    burnRate: string; // avg weekly outflow
    runwayWeeks: string | null;
    runwayStatus: "healthy" | "caution" | "critical";
    arCoverage: string | null; // (cash + AR outstanding) / AP outstanding
    dso: number | null;
    dpo: number | null;
  };
  ar: SideSummary;
  ap: SideSummary;
  categories: import("../cash/core").CategoryWeekly[];
  apSettings: { weeklyCap: string; restrictToSafe: boolean };
  /** AP predicted inside the horizon but unpayable under the cap — spills past the end. */
  deferredBeyondHorizon: string;
  /** Vendor options for the category editor (distinct parties on open AP). */
  vendorOptions: { id: string; name: string }[];
  accountOptions: { id: string; number: string | null; name: string }[];
}

export async function cashflowData(orgId: string, horizonWeeks: number, asOfDate?: string): Promise<CashflowData> {
  const asOfIso = await resolveAsOf(orgId, asOfDate);
  const grid = buildWeekGrid(asOfIso, horizonWeeks);

  const [arItems, apItems, arStats, apStats, banks, catConfigs, apCfg, accountRows] = await Promise.all([
    openItems(orgId, "ar", asOfIso),
    openItems(orgId, "ap", asOfIso),
    paymentStats("ar", asOfIso),
    paymentStats("ap", asOfIso),
    bankBalances(asOfIso),
    loadCategories(orgId),
    analyticsConfig(orgId, "cashflow"),
    (db.execute<AccountOptionRow>(sql`
      select id, number, name from accounts
      where org_id = ${orgId} and is_summary = false
      order by number nulls last, name
    `)),
  ]);
  const weeklyCap = normalizeMoneyValue(String(apCfg.weeklyApCap ?? 0));
  const restrictToSafe = (apCfg.restrictToSafe ?? 0) >= 1;

  const startingCash = sumMoney(banks.map((b) => b.balance));

  // Predict each open item into a week bucket ().
  const ar = scheduleForecast(arItems, arStats, grid.asOf, grid.start, grid.end);
  const ap = scheduleForecast(apItems, apStats, grid.asOf, grid.start, grid.end);
  const weekTotals = (byWeek: Map<string, { amount: string }[]>): Record<string, string> =>
    Object.fromEntries([...byWeek.entries()].map(([k, es]) => [k, sumMoney(es.map((e) => e.amount))]));
  const catContext = { arWeekly: weekTotals(ar.byWeek), apWeekly: weekTotals(ap.byWeek), cashStart: startingCash };
  const categories = await Promise.all(catConfigs.map((c) => categoryWeekly(orgId, c, asOfIso, grid.weekStarts, catContext)));

  const timeline = buildTimeline({
    weekStarts: grid.weekStarts,
    startingCash,
    arByWeek: ar.byWeek,
    apByWeek: ap.byWeek,
    categories,
    apSettings: { weeklyCap, restrictToSafe },
  });
  const weeks = timeline.weeks;

  // Lowest point.
  let lowestCash = startingCash;
  let lowestWeek = toISO(grid.start);
  for (const w of weeks) {
    if (compareMoney(w.endingCash, lowestCash) < 0) {
      lowestCash = w.endingCash;
      lowestWeek = w.weekStart;
    }
  }

  const totalIn = timeline.totalInflows;
  const totalOut = timeline.totalOutflows;
  const projectedEnd = weeks.length ? weeks[weeks.length - 1]!.endingCash : startingCash;
  const burnRate = weeks.length ? divideMoney(totalOut, String(weeks.length)) : ZERO_MONEY;
  // Runway: weeks of cash at the current burn rate (net of inflows if positive).
  const netBurn = subtractMoney(burnRate, weeks.length ? divideMoney(totalIn, String(weeks.length)) : ZERO_MONEY);
  const runwayWeeks = compareMoney(netBurn, ZERO_MONEY) > 0 && compareMoney(startingCash, ZERO_MONEY) > 0 ? divideMoney(startingCash, netBurn) : compareMoney(startingCash, ZERO_MONEY) > 0 ? null : ZERO_MONEY;
  const runwayStatus: "healthy" | "caution" | "critical" =
    compareMoney(lowestCash, ZERO_MONEY) < 0 ? "critical" : runwayWeeks !== null && compareMoney(runwayWeeks, "8.0000") < 0 ? "caution" : "healthy";

  const arSummary = summariseSide(arItems, grid.asOf, ar.scheduled, arStats.globalAvg);
  const apSummary = summariseSide(apItems, grid.asOf, ap.scheduled, apStats.globalAvg);

  const partyTotalsFor = (side: "ar" | "ap") => {
    const byParty = new Map<string, { name: string; amount: string; count: number }>();
    for (const w of weeks) {
      for (const e of side === "ar" ? w.arEntries : w.apEntries) {
        const cur = byParty.get(e.partyName) ?? { name: e.partyName, amount: ZERO_MONEY, count: 0 };
        cur.amount = addMoney(cur.amount, e.amount);
        cur.count++;
        byParty.set(e.partyName, cur);
      }
    }
    return [...byParty.values()].sort((a, b) => compareMoney(b.amount, a.amount));
  };

  return {
    asOf: asOfIso,
    horizonWeeks,
    startingCash,
    bankAccounts: banks,
    weeks,
    partyTotals: { ar: partyTotalsFor("ar"), ap: partyTotalsFor("ap") },
    summary: {
      startingCash,
      projectedEnd,
      totalInflows: totalIn,
      totalOutflows: totalOut,
      netChange: subtractMoney(totalIn, totalOut),
      lowestCash,
      lowestWeek,
      burnRate,
      runwayWeeks,
      runwayStatus,
      // Coverage formula: (starting cash + AR outstanding) / AP outstanding.
      arCoverage: compareMoney(apSummary.outstanding, ZERO_MONEY) > 0 ? divideMoney(addMoney(startingCash, arSummary.outstanding), apSummary.outstanding) : null,
      dso: arStats.globalAvg,
      dpo: apStats.globalAvg,
    },
    ar: arSummary,
    ap: apSummary,
    categories,
    apSettings: { weeklyCap, restrictToSafe },
    deferredBeyondHorizon: timeline.deferredBeyondHorizon,
    vendorOptions: [...new Map(apItems.filter((i) => i.partyId).map((i) => [i.partyId!, { id: i.partyId!, name: i.partyName }])).values()].sort((a, b) => a.name.localeCompare(b.name)),
    accountOptions: accountRows.rows.map((a) => ({ id: a.id, number: a.number ?? null, name: a.name })),
  };
}
