/** Pay-run pre-flight: readiness, staleness, funding, and changes. See the sibling readiness-* modules. */

export { payrollPopulationRegions, installedPayrollCountries } from "./readiness-context.ts";
export type { ReadinessSeverity, ReadinessItem, PayRunReadiness } from "./readiness-context.ts";
export { setupTaxYearCheck, payrollSetupState } from "./readiness-setup.ts";
export type { PayrollSetupCheck, PayrollSetupState } from "./readiness-setup.ts";
export { payRunReadiness } from "./readiness-pay-run.ts";
export { payrollStatutoryRateGaps } from "./readiness-statutory-gaps.ts";
export { STALENESS_INPUT_CLASSES, payRunStaleness, staleCalculationMessage, assertPayRunNotStale } from "./readiness-staleness.ts";
export type { PayRunStaleness } from "./readiness-staleness.ts";
export { payRunFunding } from "./readiness-funding.ts";
export type { FundingRail, PayRunFunding } from "./readiness-funding.ts";
export { payRunChanges } from "./readiness-changes.ts";
export type { StubChange } from "./readiness-changes.ts";
