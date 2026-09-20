import { fromUnits, toUnits } from "../money/money.ts";

export type WorkItemSeverity = "info" | "warning" | "critical";

/**
 * Shared money/age measurement helpers for continuous-close detector packs.
 * Exact decimal arithmetic throughout — never floats.
 */
export function absoluteUnits(value: string): bigint {
  const units = toUnits(value);
  return units < 0n ? -units : units;
}

export function moneyAbs(value: string): string {
  return fromUnits(absoluteUnits(value));
}

export function dateAgeDays(value: string, now = new Date()): number {
  const date = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - date) / 86_400_000));
}

export function classifyUnmatchedBankActivity(args: {
  materiality: string;
  threshold: string;
  oldestDate: string;
  count: number;
  now?: Date;
  criticalAgeDays?: number;
  criticalItemCount?: number;
  criticalMaterialityMultiple?: number;
}): WorkItemSeverity {
  const age = dateAgeDays(args.oldestDate, args.now);
  const material = absoluteUnits(args.materiality);
  const threshold = absoluteUnits(args.threshold);
  if (age >= (args.criticalAgeDays ?? 30) || material >= threshold * BigInt(args.criticalMaterialityMultiple ?? 5) || args.count >= (args.criticalItemCount ?? 50)) return "critical";
  return "warning";
}

export function classifyBudgetVariance(args: { budget: string; actual: string; accountType: string; threshold: string; minimumVarianceBps?: number; criticalVarianceBps?: number }): {
  include: boolean;
  favorable: boolean;
  variance: string;
  varianceBps: number | null;
  severity: WorkItemSeverity;
} {
  const budget = toUnits(args.budget);
  const actual = toUnits(args.actual);
  const variance = actual - budget;
  const absVariance = variance < 0n ? -variance : variance;
  const absBudget = budget < 0n ? -budget : budget;
  const threshold = absoluteUnits(args.threshold);
  const income = args.accountType === "income" || args.accountType === "income_other";
  const favorable = income ? variance >= 0n : variance <= 0n;
  const varianceBps = absBudget === 0n ? null : Number((absVariance * 10_000n) / absBudget);
  const include = !favorable && absVariance >= threshold && (varianceBps === null || varianceBps >= (args.minimumVarianceBps ?? 1_000));
  const severity: WorkItemSeverity = varianceBps !== null && varianceBps >= (args.criticalVarianceBps ?? 2_500) ? "critical" : "warning";
  return {
    include,
    favorable,
    variance: fromUnits(variance),
    varianceBps,
    severity,
  };
}

export function classifyPeriodPerformance(args: { currentRevenue: string; priorRevenue: string; currentCogs: string; priorCogs: string; threshold: string; minimumRevenueDeclineBps?: number }): {
  revenueDecline: boolean;
  revenueChangeBps: number | null;
  grossMarginDropBps: number | null;
} {
  const currentRevenue = toUnits(args.currentRevenue);
  const priorRevenue = toUnits(args.priorRevenue);
  const threshold = absoluteUnits(args.threshold);
  const decline = priorRevenue - currentRevenue;
  const revenueChangeBps = priorRevenue === 0n ? null : Number(((currentRevenue - priorRevenue) * 10_000n) / (priorRevenue < 0n ? -priorRevenue : priorRevenue));
  const marginBps = (revenue: bigint, cogs: bigint): bigint | null => (revenue === 0n ? null : ((revenue - cogs) * 10_000n) / revenue);
  const currentMargin = marginBps(currentRevenue, toUnits(args.currentCogs));
  const priorMargin = marginBps(priorRevenue, toUnits(args.priorCogs));
  const grossMarginDropBps = currentMargin === null || priorMargin === null ? null : Number(priorMargin - currentMargin);
  return {
    revenueDecline: decline >= threshold && revenueChangeBps !== null && revenueChangeBps <= -(args.minimumRevenueDeclineBps ?? 1_000),
    revenueChangeBps,
    grossMarginDropBps,
  };
}

/**
 * Per-item forensic severity: exposure is absolute (credits escalate exactly
 * like debits) and the detector materiality is the inclusion floor, so the
 * only question is the critical multiple.
 */
export function classifyForensicItem(args: { materiality: string; threshold: string; criticalMaterialityMultiple?: number }): WorkItemSeverity {
  const material = absoluteUnits(args.materiality);
  const threshold = absoluteUnits(args.threshold);
  return material >= threshold * BigInt(args.criticalMaterialityMultiple ?? 5) ? "critical" : "warning";
}
