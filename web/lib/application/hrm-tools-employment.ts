import "server-only";
import { z } from "zod";
import {
  closePosition,
  correctEmploymentChange,
  createChangeRequestDraft,
  createPosition,
  proposeFirstEmployment,
  rescindEmploymentChange,
  revisePosition,
  submitChangeRequest,
  updateChangeRequestPayload,
  withdrawChangeRequest,
  writePositionFunding,
} from "@openbooks/engine/hrm/workforce";
import { correctEmploymentStart } from "@openbooks/engine/hrm/change-requests";
import { validateSubmitActionReason } from "@openbooks/engine/automations/action-reasons";
import { listActionReasons } from "@openbooks/engine/automations/action-reasons";
import { hrmRead, HRM_DATE, HRM_UUID, hrmMutation, hrmShortText } from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";

const decimal = (description: string) =>
  z
    .string()
    .regex(/^\d+(?:\.\d{1,4})?$/)
    .describe(description);
const nullableId = (description: string) => HRM_UUID.nullable().optional().describe(description);
const reason = hrmShortText("Reason recorded in the employment audit trail.", 2000);

const hireAssignment = z
  .object({
    assignmentKey: hrmShortText("Stable key for the initial assignment.", 120),
    jobTitle: hrmShortText("Initial job title.", 240).nullable().optional(),
    departmentId: nullableId("Department for the initial assignment."),
    locationId: nullableId("Work location for the initial assignment."),
    fte: decimal("Exact FTE decimal, up to four fractional digits.").optional(),
    isPrimary: z.boolean().optional().describe("Whether this is the primary assignment."),
    managerEmploymentId: nullableId("Manager employment, if assigned."),
    positionId: nullableId("Position filled by this assignment, if applicable."),
  })
  .describe("Optional first assignment created with the hire.");

const changePayload = z
  .looseObject({ kind: hrmShortText("Employment change kind from the HRM change vocabulary.", 80) })
  .describe("Typed change payload; use the fields supported for its kind.");

export const HRM_EMPLOYMENT_TOOLS: ApplicationToolDefinition[] = [
  hrmRead({
    name: "list_hr_action_reasons",
    title: "List HR Action Reasons",
    description:
      "List active action and reason codes used to classify employment changes before submission. The organization requires these values only when configured; results use the native HRM action reason read.",
    input: z.object({
      action: hrmShortText("Employment action to filter the reason list.", 60).optional(),
    }),
    permission: "hrm.employment.read",
    featureKey: "hrm",
    execute: async (context, input) => ({
      reasons: await listActionReasons(
        context.authz.user.orgId,
        context.authz.user.id,
        input.action,
      ),
      href: "/hrm/employees",
    }),
  }),
  hrmMutation({
    name: "create_employment",
    title: "Create Employment",
    description:
      "Hire a party that has no employment episode, optionally with its first assignment. The native command creates the employment and governed change request together; use hrm_employment_as_of or hrm_change_requests to verify the result.",
    input: z.object({
      workerPartyId: HRM_UUID.describe(
        "Existing native party to hire; never create a parallel employee record.",
      ),
      employerSubsidiaryId: HRM_UUID.describe("Legal employer subsidiary for the employment."),
      status: z
        .enum(["offered", "active", "on_leave", "suspended"])
        .optional()
        .describe("Initial employment status; defaults according to the native hire policy."),
      effectiveFrom: HRM_DATE.describe("First effective day of employment."),
      effectiveTo: HRM_DATE.nullable()
        .optional()
        .describe("Optional last effective day for a bounded episode."),
      initialAssignment: hireAssignment.optional(),
      reason: hrmShortText("Why the person is being hired.", 500),
      action: hrmShortText(
        "Action code from list_hr_action_reasons when the organization requires classification.",
        60,
      ).optional(),
      reasonCode: hrmShortText(
        "Reason code from list_hr_action_reasons when the organization requires classification.",
        120,
      ).optional(),
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const hire = await proposeFirstEmployment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        workerPartyId: input.workerPartyId,
        employerSubsidiaryId: input.employerSubsidiaryId,
        ...(input.status === undefined ? {} : { status: input.status }),
        effectiveFrom: input.effectiveFrom,
        ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }),
        ...(input.initialAssignment === undefined ? {} : { assignment: input.initialAssignment }),
        reason: input.reason,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      });
      return {
        ok: true,
        employmentId: hire.employmentId,
        requestId: hire.changeRequestId,
        status: hire.status,
        applied: hire.applied,
        employment: { id: hire.employmentId },
        request: { id: hire.changeRequestId, status: hire.status },
        href: `/hrm/change-requests?employment=${hire.employmentId}`,
      };
    },
  }),
  hrmMutation({
    name: "correct_employment_start",
    title: "Correct Employment Start",
    description:
      "Correct a wrongly recorded start date when committed payroll does not conflict with the correction. Read the employment with hrm_employment_as_of first; the command audits the correction and its affected records.",
    input: z.object({
      employmentId: HRM_UUID.describe("Employment id from hrm_employment_as_of."),
      correctedStart: HRM_DATE.describe("Correct first day of service."),
      reason: hrmShortText("Reason for correcting the recorded start date.", 500).refine(
        (value) => value.length >= 10,
        "Use at least 10 characters.",
      ),
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const result = await correctEmploymentStart({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        correctedStart: input.correctedStart,
        reason: input.reason,
      });
      return { ok: true, ...result, href: `/hrm/employees?employment=${input.employmentId}` };
    },
  }),
  hrmMutation({
    name: "create_position",
    title: "Create Position",
    description:
      "Open a new budgeted position with its legal employer, effective dates and vacancy status. Read positions in the HRM Positions workspace first to avoid duplicate positions.",
    input: z.object({
      positionCode: hrmShortText("Unique position code.", 255),
      title: hrmShortText("Position title.", 240),
      departmentId: nullableId("Owning department, if assigned."),
      locationId: nullableId("Work location, if assigned."),
      employerSubsidiaryId: HRM_UUID.describe("Legal employer subsidiary."),
      jobGrade: hrmShortText("Job grade, if assigned.", 120).nullable().optional(),
      plannedFte: decimal(
        "Planned FTE as an exact decimal string, up to four fractional digits.",
      ).optional(),
      status: z
        .enum(["planned", "open", "filled", "frozen", "closed"])
        .optional()
        .describe("Initial position status."),
      effectiveFrom: HRM_DATE.describe("First effective day."),
      effectiveTo: HRM_DATE.nullable().optional().describe("Optional last effective day."),
      reason: hrmShortText("Reason for opening the position.", 2000),
    }),
    permission: "hrm.position.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const position = await createPosition({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, position, positionId: position.id, href: "/hrm/positions" };
    },
  }),
  hrmMutation({
    name: "revise_position",
    title: "Revise Position",
    description:
      "Revise a position's effective title, department, location, grade, FTE or status while preserving its version history. Find and read the position in the HRM Positions workspace first.",
    input: z.object({
      positionId: HRM_UUID.describe("Position id from the HRM Positions workspace."),
      title: hrmShortText("Replacement position title.", 240).optional(),
      departmentId: HRM_UUID.nullable()
        .optional()
        .describe("Replacement department, or null to clear it."),
      locationId: HRM_UUID.nullable()
        .optional()
        .describe("Replacement location, or null to clear it."),
      employerSubsidiaryId: HRM_UUID.optional().describe(
        "Legal employer subsidiary for the revised version.",
      ),
      jobGrade: hrmShortText("Replacement job grade.", 120).nullable().optional(),
      plannedFte: decimal("Replacement planned FTE as an exact decimal string.").optional(),
      status: z
        .enum(["planned", "open", "filled", "frozen"])
        .optional()
        .describe("Replacement position status."),
      effectiveFrom: HRM_DATE.optional().describe("First effective day of this revision."),
      effectiveTo: HRM_DATE.nullable()
        .optional()
        .describe("Optional last effective day of this revision."),
      reason,
    }),
    permission: "hrm.position.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { positionId, ...change } = input;
      const position = await revisePosition({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        positionId,
        ...change,
      });
      return { ok: true, position, positionId, href: "/hrm/positions" };
    },
  }),
  hrmMutation({
    name: "close_position",
    title: "Close Position",
    description:
      "Close a position from an effective date when it has no blocking holders or commitments. Read the position in the HRM Positions workspace first; closure is audited and cannot be applied retroactively through this action.",
    input: z.object({
      positionId: HRM_UUID.describe("Position id from the HRM Positions workspace."),
      effectiveDate: HRM_DATE.describe("Date the position closes."),
      reason,
    }),
    permission: "hrm.position.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const position = await closePosition({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, position, positionId: input.positionId, href: "/hrm/positions" };
    },
  }),
  hrmMutation({
    name: "fund_position",
    title: "Fund Position",
    description:
      "Record position funding for a fiscal period and run its native preflight. Use the HRM Positions and accounting period reads to resolve ids; amounts and FTE remain exact decimal strings.",
    input: z.object({
      positionId: HRM_UUID.describe("Position id from the HRM Positions workspace."),
      periodId: HRM_UUID.describe("Fiscal period id from the accounting period read."),
      fundedFte: decimal("Funded FTE as an exact decimal string."),
      fundingSourceId: HRM_UUID.nullable()
        .optional()
        .describe("Funding source, if the organization tracks one."),
      amount: decimal("Funding amount as an exact decimal string.").nullable().optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional()
        .describe("Three-letter ISO currency when an amount is supplied."),
      reason,
    }),
    permission: "hrm.position.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const result = await writePositionFunding({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        funding: result.funding,
        preflight: result.preflight,
        positionId: input.positionId,
        href: "/hrm/positions",
      };
    },
  }),
  hrmMutation({
    name: "create_change_request",
    title: "Create Change Request",
    description:
      "Draft an effective-dated employment change such as a transfer, job change, leave of absence, return, rehire or termination. Use hrm_employment_as_of to resolve the employment id; submit_change_request starts the configured Flow when one exists.",
    input: z.object({
      employmentId: HRM_UUID.describe("Employment id from hrm_employment_as_of."),
      payload: changePayload,
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const request = await createChangeRequestDraft({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        payload: input.payload,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: `/hrm/change-requests?request=${request.id}`,
      };
    },
  }),
  hrmMutation({
    name: "update_change_request",
    title: "Update Change Request",
    description:
      "Replace the payload of a draft employment change request before submission. Read the request with hrm_change_requests or the request detail endpoint first; submitted requests must use governed correction or rescission actions.",
    input: z.object({
      requestId: HRM_UUID.describe("Draft request id from hrm_change_requests."),
      payload: changePayload,
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const request = await updateChangeRequestPayload({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: input.requestId,
        payload: input.payload,
      });
      return {
        ok: true,
        request,
        requestId: input.requestId,
        status: request.status,
        href: `/hrm/change-requests?request=${input.requestId}`,
      };
    },
  }),
  hrmMutation({
    name: "submit_change_request",
    title: "Submit Change Request",
    description:
      "Submit a complete draft employment change for its configured approval Flow; when no Flow is configured, the native service applies the change according to policy. Read the draft with hrm_change_requests first; approvals use decide_approval.",
    input: z.object({
      requestId: HRM_UUID.describe("Draft request id from hrm_change_requests."),
      reason: hrmShortText("Submission reason.", 500).optional(),
      action: hrmShortText("Action code from list_hr_action_reasons when required.", 60).optional(),
      reasonCode: hrmShortText(
        "Reason code from list_hr_action_reasons when required.",
        120,
      ).optional(),
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      await validateSubmitActionReason({
        orgId: context.authz.user.orgId,
        ...(input.action ? { action: input.action } : {}),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      const request = await submitChangeRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: input.requestId,
        reason: input.reason,
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
      });
      return {
        ok: true,
        request,
        requestId: input.requestId,
        status: request.status,
        href: `/hrm/change-requests?request=${input.requestId}`,
      };
    },
  }),
  hrmMutation({
    name: "withdraw_change_request",
    title: "Withdraw Change Request",
    description:
      "Withdraw a draft or pending request when the requester owns the eligible profile-change request or the caller can manage employment changes. Find its id with hrm_change_requests; this action is destructive and records the reason.",
    input: z.object({
      requestId: HRM_UUID.describe("Draft or pending request id from hrm_change_requests."),
      reason: hrmShortText("Reason for withdrawing the request.", 500),
    }),
    permission: ["hrm.employment.manage", "hrm.self.request"],
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const request = await withdrawChangeRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: input.requestId,
        reason: input.reason,
      });
      return {
        ok: true,
        request,
        requestId: input.requestId,
        status: request.status,
        href: `/hrm/change-requests?request=${input.requestId}`,
      };
    },
  }),
  hrmMutation({
    name: "rescind_employment_change",
    title: "Rescind Employment Change",
    description:
      "Rescind a completed employment change when no later change or consumed payroll period blocks it. Read the employment's change history first; the native action restores the prior version and audits the reason.",
    input: z.object({
      changeId: HRM_UUID.describe("Completed change id from the employment history."),
      reason: hrmShortText("Reason for rescinding the completed change.", 2000),
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const result = await rescindEmploymentChange({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        changeId: input.changeId,
        reason: input.reason,
      });
      return { ok: true, ...result, href: `/hrm/change-requests` };
    },
  }),
  hrmMutation({
    name: "correct_employment_change",
    title: "Correct Employment Change",
    description:
      "Correct a completed employment change by opening a prefilled replacement request that follows the configured approval policy. Read the completed change from hrm_employment_as_of first; the native correction refuses when its history cannot be safely revised.",
    input: z.object({
      changeId: HRM_UUID.describe("Completed change id from the employment history."),
      reason: hrmShortText("Reason for correcting the completed change.", 2000),
      correctedFields: z
        .record(z.string(), z.json())
        .optional()
        .describe("Fields to replace in the corrected payload."),
      prefillPayload: z
        .record(z.string(), z.json())
        .optional()
        .describe("Explicit replacement payload when the original request cannot be prefetched."),
    }),
    permission: "hrm.employment.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const result = await correctEmploymentChange({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        changeId: input.changeId,
        reason: input.reason,
        ...(input.correctedFields ? { correctedFields: input.correctedFields } : {}),
        ...(input.prefillPayload ? { prefillPayload: input.prefillPayload } : {}),
      });
      return { ok: true, ...result, href: "/hrm/change-requests" };
    },
  }),
];
