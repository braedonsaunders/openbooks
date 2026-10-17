/** Equity and cap table: the public engine contract for the application. */
export { EquityError, EQUITY_FEATURE_KEY, EQUITY_FEATURE_REMEDY, EQUITY_ACCOUNTS_REMEDY } from "./errors.ts";
export { equityAccountPolicyRefusal, EQUITY_POLICY_ACCOUNT_FIELDS } from "./account-policy.ts";
export { EQUITY_JOURNAL_ORIGIN, CONSIDERATION_ACCOUNT_TYPES } from "./posting.ts";
export {
  SECURITY_KINDS,
  SECURITY_EVENT_KINDS,
  type SecurityKind,
  type SecurityEventKind,
  type ShareClassKind,
  type Participation,
  type AntiDilution,
  type VestingFrequency,
  type Acceleration,
  type SafeType,
  type InterestBasis,
  type ExpenseAttribution,
} from "./types.ts";
export {
  createShareClass,
  amendShareClass,
  recordSplit,
  createPlan,
  changePlanReserve,
  createRound,
  type CreateShareClassInput,
  type AmendShareClassInput,
  type RecordSplitInput,
  type CreatePlanInput,
  type ChangePlanReserveInput,
  type CreateRoundInput,
} from "./structure.ts";
export { issueSecurity, type IssueSecurityInput, type ValuationInput } from "./securities.ts";
export { recordSecurityEvent, type RecordEventInput, type RecordEventResult } from "./events.ts";
export {
  previewCompensationRun,
  postCompensationRun,
  type CompensationPreview,
  type CompensationLine,
  type CompensationRunResult,
} from "./compensation-run.ts";
export {
  listEquityEntities,
  loadCapTableView,
  listSecurities,
  loadSecurityDetail,
  loadStructure,
  listStakeholders,
  modelEntityRound,
  runEntityWaterfall,
  listCompensationRuns,
  type CapTableView,
  type SecurityRow,
  type SecurityDetail,
  type StructureView,
  type CompensationRunRow,
} from "./read-model.ts";
export type { CapTable, ClassRow, HolderRow, PlanRow, HoldingRow, ConvertibleRow } from "./cap-table.ts";
export type { RoundModelResult, RoundModelDilutionRow } from "./round-model.ts";
export type { WaterfallResult, WaterfallClassRow, WaterfallPayout } from "./waterfall.ts";
export { blackScholesCall, type BlackScholesInputs, type BlackScholesResult } from "./black-scholes.ts";
