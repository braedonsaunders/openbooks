/**
 * Flows engine — public surface for the web phase (APIs, builder, worklist).
 * See docs/flows-design.md; ported from beaconhs-platform's lib/flows.
 */

export {
  runRecordFlows,
  emitStatusChange,
  parseFlowGraph,
  type RecordFlowsResult,
} from "./run.ts";
export { executeFlowPlan, type ExecuteFlowPlanResult } from "./execute.ts";
export {
  decideGate,
  delegateGate,
  processGateTimers,
  worklistGates,
  GateError,
  type DecideGateResult,
  type WorklistGate,
} from "./gates.ts";
export {
  activeDelegationPrincipal,
  activeDelegationPrincipals,
  createDelegation,
  listUserDelegations,
  revokeDelegation,
  DelegationError,
  type DelegationView,
} from "./delegations.ts";
export {
  appBaseUrl,
  createEmailActionToken,
  emailActionUrls,
  verifyEmailActionToken,
  EMAIL_TOKEN_TTL_MS,
  type EmailActionClaims,
} from "./email-tokens.ts";
export { runDueScheduledFlows, lastCronOccurrenceBetween } from "./scheduled.ts";
export { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";
export {
  checkFlowLock,
  getFlowLock,
  lockRecord,
  unlockRecord,
  type FlowLockInfo,
} from "./locks.ts";
export { userRoleKeys } from "./targets.ts";
export {
  registerFlowPdfRenderer,
  renderFlowPdf,
  hasFlowPdfRenderer,
  type FlowPdfAttachment,
  type FlowPdfRenderer,
} from "./pdf-hook.ts";
export {
  BANK_ACCOUNT_SUBJECT_KIND,
  BANK_ACCOUNT_MATERIAL_FIELDS,
  bankAccountsFlowAdapter,
  bankAccountSubjectProfile,
} from "./bank-accounts-adapter.ts";
export {
  BUDGET_SCENARIO_SUBJECT_KIND,
  budgetScenariosFlowAdapter,
  budgetScenarioSubjectProfile,
} from "./budget-scenarios-adapter.ts";
export { lintFlowGraphForSubject } from "./lint.ts";
export {
  BUILT_IN_ROLE_NAMES,
  DOCUMENT_FLOW_KINDS,
  DOCUMENT_STATUSES,
  documentSubjectProfile,
} from "./subject-profiles.ts";
export { resolveQuorumOutcome, type QuorumOutcome, type SiblingGate } from "./quorum.ts";
export type { FlowExecCtx, FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
