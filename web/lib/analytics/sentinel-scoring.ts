/**
 * Sentinel severity model: one declared object mapping each forensic signal
 * to its points, confidence or severity ladder. The Configuration tab
 * renders this object read-only, so an operator sees exactly how points
 * accrue — and a renamed rule fails to compile at every scorer that reads
 * it, instead of silently scoring zero. Detection thresholds are
 * organization configuration, not scoring constants: no detection cut-off
 * lives here, and no scoring constant lives inline elsewhere.
 *
 * Client-safe on purpose: the Sentinel risk gauge and the dashboard risk
 * tiles read the score bands from this module, while the server scorer
 * reads the points. Neither reader keeps its own copy of the numbers.
 */
export interface RiskScoreRule {
  /** Full catalog path for the Configuration → Scoring model row. */
  labelKey: string;
  /** Static ICU params for the row. `tierKey` names a config field whose
   * translated label the panel resolves; `countKey` names a config field
   * whose live value the panel resolves. */
  params: Record<string, string | number>;
  points?: number;
  confidence?: number;
  days?: number;
  ratio?: number;
  z?: number;
  perUnit?: number;
  cap?: number;
  share?: number;
}

export interface RiskScoringSection {
  titleKey: string;
  rules: Record<string, RiskScoreRule>;
}

export type RiskScoringSectionKey =
  | "trap"
  | "duplicate"
  | "weekend"
  | "rsf"
  | "zscore"
  | "sequential"
  | "ghost"
  | "vendor"
  | "summary";

const TIER = (tierKey: string, points: number): RiskScoreRule => ({
  labelKey: "analytics.sentinel.scoring.tierBump",
  params: { tierKey, points },
  points,
});

export const RISK_SCORING = {
  trap: {
    titleKey: "analytics.sentinel.scoring.trap",
    rules: {
      ends9999: { labelKey: "analytics.sentinel.scoring.trapPattern", params: { pattern: "9999", points: 65 }, points: 65 },
      ends999: { labelKey: "analytics.sentinel.scoring.trapPattern", params: { pattern: "999", points: 55 }, points: 55 },
      ends99: { labelKey: "analytics.sentinel.scoring.trapPattern", params: { pattern: "99", points: 45 }, points: 45 },
    },
  },
  duplicate: {
    titleKey: "analytics.sentinel.scoring.duplicate",
    rules: {
      base: { labelKey: "analytics.sentinel.scoring.base", params: { points: 50 }, points: 50 },
      tierCritical: TIER("analytics.sentinel.config.fields.criticalRiskAmount.label", 25),
      tierHigh: TIER("analytics.sentinel.config.fields.highRiskAmount.label", 15),
      tierModerate: TIER("analytics.sentinel.config.fields.moderateRiskAmount.label", 5),
      span1Day: { labelKey: "analytics.sentinel.scoring.spanBump", params: { days: 1, points: 20 }, days: 1, points: 20 },
      span3Days: { labelKey: "analytics.sentinel.scoring.spanBump", params: { days: 3, points: 15 }, days: 3, points: 15 },
      span7Days: { labelKey: "analytics.sentinel.scoring.spanBump", params: { days: 7, points: 10 }, days: 7, points: 10 },
      sharedReference: { labelKey: "analytics.sentinel.scoring.sharedReference", params: { points: 10 }, points: 10 },
      confSharedReference: { labelKey: "analytics.sentinel.scoring.confShared", params: {}, confidence: 0.95 },
      confSpan3Days: { labelKey: "analytics.sentinel.scoring.confSpan", params: { days: 3 }, days: 3, confidence: 0.9 },
      confSpan7Days: { labelKey: "analytics.sentinel.scoring.confSpan", params: { days: 7 }, days: 7, confidence: 0.85 },
      confOtherwise: { labelKey: "analytics.sentinel.scoring.confOtherwise", params: {}, confidence: 0.75 },
    },
  },
  weekend: {
    titleKey: "analytics.sentinel.scoring.weekend",
    rules: {
      base: { labelKey: "analytics.sentinel.scoring.base", params: { points: 35 }, points: 35 },
      tierCritical: TIER("analytics.sentinel.config.fields.criticalRiskAmount.label", 30),
      tierHigh: TIER("analytics.sentinel.config.fields.highRiskAmount.label", 20),
      sunday: { labelKey: "analytics.sentinel.scoring.sunday", params: { points: 10 }, points: 10 },
    },
  },
  rsf: {
    titleKey: "analytics.sentinel.scoring.rsf",
    rules: {
      base: { labelKey: "analytics.sentinel.scoring.base", params: { points: 40 }, points: 40 },
      ratio50: { labelKey: "analytics.sentinel.scoring.ratioBump", params: { ratio: 50, points: 40 }, ratio: 50, points: 40 },
      ratio20: { labelKey: "analytics.sentinel.scoring.ratioBump", params: { ratio: 20, points: 30 }, ratio: 20, points: 30 },
      ratio15: { labelKey: "analytics.sentinel.scoring.ratioBump", params: { ratio: 15, points: 20 }, ratio: 15, points: 20 },
      ratioBase: { labelKey: "analytics.sentinel.scoring.ratioOtherwise", params: { points: 10 }, points: 10 },
      tierCritical: TIER("analytics.sentinel.config.fields.criticalRiskAmount.label", 15),
      tierHigh: TIER("analytics.sentinel.config.fields.highRiskAmount.label", 10),
    },
  },
  zscore: {
    titleKey: "analytics.sentinel.scoring.zscore",
    rules: {
      base: { labelKey: "analytics.sentinel.scoring.base", params: { points: 45 }, points: 45 },
      z5: { labelKey: "analytics.sentinel.scoring.zBump", params: { z: 5, points: 30 }, z: 5, points: 30 },
      z4: { labelKey: "analytics.sentinel.scoring.zBump", params: { z: 4, points: 20 }, z: 4, points: 20 },
      tierCritical: TIER("analytics.sentinel.config.fields.criticalRiskAmount.label", 15),
    },
  },
  sequential: {
    titleKey: "analytics.sentinel.scoring.sequential",
    rules: {
      highSpan: { labelKey: "analytics.sentinel.scoring.sequentialHighSpan", params: { points: 75 }, points: 75 },
      baseSpan: { labelKey: "analytics.sentinel.scoring.sequentialBaseSpan", params: { points: 50 }, points: 50 },
      perInvoice: { labelKey: "analytics.sentinel.scoring.perInvoice", params: { points: 4, cap: 20 }, perUnit: 4, cap: 20 },
      tierCritical: TIER("analytics.sentinel.config.fields.aggregateCriticalAmount.label", 10),
      tierHigh: TIER("analytics.sentinel.config.fields.aggregateHighAmount.label", 7),
      tierModerate: TIER("analytics.sentinel.config.fields.criticalRiskAmount.label", 5),
    },
  },
  ghost: {
    titleKey: "analytics.sentinel.scoring.ghost",
    rules: {
      nameAndAddress: { labelKey: "analytics.sentinel.scoring.ghostRow", params: { matchKey: "analytics.sentinel.ghost.matchBoth", points: 95 }, points: 95 },
      addressOnly: { labelKey: "analytics.sentinel.scoring.ghostRow", params: { matchKey: "analytics.sentinel.ghost.matchAddress", points: 90 }, points: 90 },
      nameOnly: { labelKey: "analytics.sentinel.scoring.ghostRow", params: { matchKey: "analytics.sentinel.ghost.matchName", points: 75 }, points: 75 },
    },
  },
  vendor: {
    titleKey: "analytics.sentinel.scoring.vendor",
    rules: {
      perFlag: { labelKey: "analytics.sentinel.scoring.perFlag", params: { points: 8, cap: 40 }, perUnit: 8, cap: 40 },
      tierCritical: TIER("analytics.sentinel.config.fields.aggregateHighAmount.label", 25),
      tierHigh: TIER("analytics.sentinel.config.fields.highRiskAmount.label", 15),
      tierBase: { labelKey: "analytics.sentinel.scoring.tierOtherwise", params: { points: 5 }, points: 5 },
      perType: { labelKey: "analytics.sentinel.scoring.perType", params: { points: 8 }, points: 8 },
      worstShare: { labelKey: "analytics.sentinel.scoring.worstShare", params: {}, share: 0.3 },
    },
  },
  summary: {
    titleKey: "analytics.sentinel.scoring.summary",
    rules: {
      flaggedHigh: { labelKey: "analytics.sentinel.scoring.summaryVolume", params: { countKey: "summaryFlaggedHigh", points: 15 }, points: 15 },
      flaggedMedium: { labelKey: "analytics.sentinel.scoring.summaryVolume", params: { countKey: "summaryFlaggedMedium", points: 10 }, points: 10 },
      dupCritical: { labelKey: "analytics.sentinel.scoring.tierBump", params: { tierKey: "analytics.sentinel.config.fields.aggregateCriticalAmount.label", points: 20 }, points: 20 },
      dupHigh: { labelKey: "analytics.sentinel.scoring.tierBump", params: { tierKey: "analytics.sentinel.config.fields.aggregateHighAmount.label", points: 15 }, points: 15 },
      ghostAny: { labelKey: "analytics.sentinel.scoring.ghostAny", params: { points: 25 }, points: 25 },
      sequentialAny: { labelKey: "analytics.sentinel.scoring.sequentialAny", params: { points: 15 }, points: 15 },
      benford: { labelKey: "analytics.sentinel.scoring.benfordNonconforming", params: { points: 15 }, points: 15 },
    },
  },
} as const satisfies Record<RiskScoringSectionKey, RiskScoringSection>;

/**
 * Overall-score bands: the minimum score for each band. The Sentinel risk
 * gauge and the dashboard risk tiles both read these cut-offs, so a score
 * means the same severity in both places. Each reader keeps its own visual
 * vocabulary (gauge colors, tile tones); only the numbers are shared.
 */
export const RISK_SCORE_BANDS = {
  high: 60,
  elevated: 40,
  moderate: 20,
  low: 0,
} as const;
