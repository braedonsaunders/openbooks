/** Public close API. Operation modules own their lifecycles and never import this facade. */
export { requestPeriodReopen, decidePeriodReopen, recloseApprovedReopen, recloseExpiredReopens } from "./reopening.ts";
export { closeApprovedRun, publishCloseRun } from "./run-completion.ts";
export { attestOwnerManagedClose, requestCloseApproval, finalizeCloseFlowApproval } from "./approvals.ts";
export { updateCloseTask, addCloseEvidence } from "./tasks.ts";
export { startCloseRun } from "./run-start.ts";
export { periodScopeAdvisoryLock, setPeriodLockState } from "./period-locks.ts";
export { refreshCloseRun, runCloseAutomations, runDueCloseAutomations } from "./run-automation.ts";
export { ensureCloseDefaults } from "./defaults.ts";
export { generateAccountingPeriods } from "./calendar.ts";
export { CloseError, CLOSE_MODULES, DOCUMENT_KINDS, NON_POSTING_DOCUMENT_KINDS, periodLockBlocksPosting, closeModuleForDocument, assertPeriodModulesOpen, arePeriodModulesOpen, type CloseModule } from "./period-policy.ts";
export { advancedCloseEnabled } from "./features.ts";
export { CLOSE_AUTOMATION_STALE_CLAIM_MS, CloseAutomationLeaseFencedError } from "./automations.ts";
