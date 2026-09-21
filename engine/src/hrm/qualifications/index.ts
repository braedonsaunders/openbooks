/**
 * HR-14 qualifications and dispatch gating services: the worker
 * qualification ledger, requirements, the dispatch gate, and expiry
 * alerts.
 */
export { HrmQualificationError } from "./errors.ts";
export {
  HRM_CERTIFICATION_ALERTS_FEATURE,
  HRM_CERTIFICATIONS_FEATURE,
  HRM_DISPATCH_GATING_FEATURE,
  HRM_EQUIPMENT_QUALIFICATIONS_FEATURE,
  addMonthsUtc,
  monthsBetween,
  projectDerivedStatus,
  type DerivedQualificationStatus,
  type StoredQualificationStatus,
} from "./shared.ts";
export {
  BASE_CATEGORIES,
  DEFAULT_ALERT_LEAD_DAYS,
  createQualificationType,
  declareCategory,
  listQualificationTypes,
  loadSettings,
  setAlertSchedule,
  updateQualificationType,
  type QualificationSettings,
  type QualificationType,
} from "./types.ts";
export {
  attachEvidence,
  listQualificationEvents,
  listQualifications,
  recordQualification,
  renewQualification,
  revokeQualification,
  selfAndTeamEmploymentIds,
  verifyQualification,
  type QualificationEvent,
  type WorkerQualification,
} from "./qualifications.ts";
export {
  listRequirements,
  removeRequirement,
  resolveSubject,
  setRequirement,
  type QualificationRequirement,
  type RequirementSeverity,
  type RequirementSubjectKind,
} from "./requirements.ts";
export {
  checkAssignment,
  checkAssignmentInternal,
  checkAssignmentTrusted,
  gateScheduleAssignment,
  noteWarnedDispatch,
  refuseBlockedDispatch,
  type CheckAssignmentInput,
  type CheckAssignmentTrustedInput,
  type GateFinding,
  type GateVerdict,
  type GateVerdictReason,
  type ScheduleGateInput,
  type ScheduleGateResult,
} from "./gating.ts";
export {
  listAlertEligibleOrgs,
  listAlerts,
  runQualificationAlertScan,
  type AlertScanSummary,
  type QualificationAlert,
} from "./alerts.ts";
