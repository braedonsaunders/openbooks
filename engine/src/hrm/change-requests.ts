/**
 * Governed HRM employment change-request service — public entrypoint.
 *
 * The implementation lives in focused operation modules
 * (change-requests-payload, -core, -lifecycle, -query, -release, -apply
 * and its apply helpers, and -evidence); this module re-exports the
 * public surface so existing callers keep one stable import path.
 */
export {
  PAYLOAD_SCHEMA_VERSION,
  type HrmChangeRequestCode,
  HrmChangeRequestError,
  type HirePayload,
  type HireInitialAssignment,
  type StatusChangePayload,
  type AssignmentChangePayload,
  type TerminationPayload,
  type PositionAssignmentPayload,
  type BankDetailsChangePayload,
  type ChangeRequestPayload,
  validateChangePayload,
} from "./change-requests-payload.ts";
export { type ChangeRequestDTO } from "./change-requests-core.ts";
export {
  type CreateChangeRequestQuery,
  createChangeRequestDraft,
  type UpdateChangeRequestPayloadQuery,
  updateChangeRequestPayload,
  type SubmitChangeRequestQuery,
  submitChangeRequest,
  employmentChangeFlowsEnabled,
  type WithdrawChangeRequestQuery,
  withdrawChangeRequest,
} from "./change-requests-lifecycle.ts";
export {
  type GetChangeRequestQuery,
  getChangeRequest,
  type ListChangeRequestsQuery,
  listChangeRequests,
  type CountChangeRequestsQuery,
  countChangeRequests,
  listChangeRequestsWithTotal,
} from "./change-requests-query.ts";
export {
  type ReleaseChangeRequestQuery,
  type ReleaseChangeRequestResult,
  releaseHrmChangeRequest,
} from "./change-requests-release.ts";
export {
  EMPLOYMENT_CHANGE_KINDS,
  type EmploymentChangeKind,
  insertEmploymentChange,
} from "./change-requests-evidence.ts";
