/**
 * Demand planning: statistical forecasts per item and stock location become
 * reviewable purchase and transfer suggestions.
 *
 * Stable surface for the planning UI, the scheduler, and the public
 * barrel: every name below resolved here before the split and resolves
 * here after it. The responsibilities live in four modules —
 * demand-planning-policy.ts (feature gate, errors, item policies),
 * demand-planning-runs.ts (history readers, the plan run),
 * demand-planning-suggestions.ts (suggestion reads, lifecycle, converts),
 * demand-planning-forecasts.ts (overrides, scheduled scans, accuracy).
 */
export {
  assertDemandPlanningFeature,
  DemandPlanningError,
  DemandPlanningNotFoundError,
  listDemandPolicies,
  saveDemandPolicy,
  type DemandItemPolicy,
  type DemandPlanningRefusalCode,
  type ResolvedDemandPolicy,
} from "./demand-planning-policy.ts";
export {
  runDemandPlan,
  type DemandPlanRun,
  type RunDemandPlanOptions,
} from "./demand-planning-runs.ts";
export {
  confirmPlanSuggestion,
  convertTransferSuggestion,
  dismissPlanSuggestion,
  getDemandRun,
  getPlanSuggestion,
  groupSuggestionsBySupplier,
  listDemandRuns,
  listPlanSuggestions,
  markBuySuggestionConverted,
  type DemandHistoryPoint,
  type PlanSuggestion,
} from "./demand-planning-suggestions.ts";
export {
  forecastAccuracy,
  listForecastOverrides,
  runDueDemandForecasts,
  saveForecastOverride,
  type DemandForecastScanResult,
  type ForecastAccuracyRow,
  type ForecastOverrideInput,
} from "./demand-planning-forecasts.ts";
