import "server-only";
import { z } from "zod";
import {
  cancelLeaveRequest,
  fileLeaveRequest,
  listOwnLeaveEmploymentOptions,
  recordLeaveAttachment,
  submitLeaveRequest,
  withdrawLeaveRequest,
} from "@openbooks/engine/hrm/leave";
import { recordAbsence } from "@openbooks/engine/hrm/attendance";
import { ApplicationError, invalidInput } from "./errors";
import { hrmMutation, HRM_DATE, HRM_UUID, hrmShortText } from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";

const exactHours = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,2})?$/)
  .describe("Exact number of leave hours as a decimal string, with at most two fractional digits.");
const reason = hrmShortText("Reason recorded with the leave action.", 2000);

export const HRM_LEAVE_TOOLS: ApplicationToolDefinition[] = [
  hrmMutation({
    name: "file_leave_request",
    title: "File Leave Request",
    description:
      "File a draft leave request for yourself by omitting employmentId, or for another employee when you hold hrm.leave.manage and set onBehalf. Find leave type ids with the HRM leave setup read and verify requests with hrm_leave; submission starts the configured approval Flow.",
    input: z.object({
      employmentId: HRM_UUID.optional().describe(
        "Employment id from hrm_employment_as_of; omit to resolve your own employment, and provide one explicitly if you have several.",
      ),
      leaveTypeId: HRM_UUID.describe("Active leave type id from the HRM leave setup read."),
      startsOn: HRM_DATE.describe("First day of the leave request."),
      endsOn: HRM_DATE.describe("Last day of the leave request, inclusive."),
      hours: exactHours,
      reason: hrmShortText("Reason for the leave request.", 2000).nullable().optional(),
      onBehalf: z
        .boolean()
        .optional()
        .describe(
          "Set true only when filing for another employee; the service requires manager authority and a reason.",
        ),
    }),
    permission: "hrm.leave.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      let employmentId = input.employmentId;
      if (!employmentId) {
        const own = await listOwnLeaveEmploymentOptions({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        });
        if (own.length === 0) {
          throw new ApplicationError(
            "not_found",
            "No employment is linked to your user; ask HR to create your employment before requesting leave.",
            404,
          );
        }
        if (own.length > 1) {
          throw invalidInput(
            `You have ${own.length} employments; pass the employmentId for the one whose leave you are requesting.`,
          );
        }
        employmentId = own[0]!.employmentId;
      }
      const request = await fileLeaveRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId,
        leaveTypeId: input.leaveTypeId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        hours: input.hours,
        reason: input.reason ?? null,
        onBehalf: input.onBehalf,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: "/hrm/my-leave",
      };
    },
  }),
  hrmMutation({
    name: "attach_leave_request_file",
    title: "Attach Leave Request File",
    description:
      "Attach an existing File Cabinet upload to a draft leave request when its leave type requires evidence. Read the request with hrm_leave first and upload the file with upload_file; the native service verifies tenant ownership and request state.",
    input: z.object({
      requestId: HRM_UUID.describe("Draft leave request id from hrm_leave."),
      attachmentId: HRM_UUID.describe("File id returned by upload_file."),
    }),
    permission: "hrm.leave.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const request = await recordLeaveAttachment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: "/hrm/my-leave",
      };
    },
  }),
  hrmMutation({
    name: "submit_leave_request",
    title: "Submit Leave Request",
    description:
      "Submit a draft leave request for its configured approval Flow; a zero-gate policy may approve it immediately. Read the request with hrm_leave first; pending approvals are decided with decide_approval.",
    input: z.object({ requestId: HRM_UUID.describe("Draft leave request id from hrm_leave.") }),
    permission: "hrm.leave.request",
    featureKey: "hrm",
    execute: async (context, input) => {
      const request = await submitLeaveRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: input.requestId,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: "/hrm/my-leave",
      };
    },
  }),
  hrmMutation({
    name: "withdraw_leave_request",
    title: "Withdraw Leave Request",
    description:
      "Withdraw a draft or submitted leave request with a reason while it is still eligible. Read the request with hrm_leave first; withdrawal preserves its audit history.",
    input: z.object({
      requestId: HRM_UUID.describe("Draft or submitted leave request id from hrm_leave."),
      reason,
    }),
    permission: "hrm.leave.request",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const request = await withdrawLeaveRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: "/hrm/my-leave",
      };
    },
  }),
  hrmMutation({
    name: "cancel_leave_request",
    title: "Cancel Leave Request",
    description:
      "Cancel an approved leave request with a reason; native controls reverse unconsumed absences and refuse changes already consumed by a committed pay run. Read the request with hrm_leave first.",
    input: z.object({
      requestId: HRM_UUID.describe("Approved leave request id from hrm_leave."),
      reason,
    }),
    permission: "hrm.leave.request",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const request = await cancelLeaveRequest({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        request,
        requestId: request.id,
        status: request.status,
        href: "/hrm/my-leave",
      };
    },
  }),
  hrmMutation({
    name: "record_leave_absence",
    title: "Record Leave Absence",
    description:
      "Record an employee absence after the fact as an absence record only; it does not create a payroll input or time entry. Find the employment and leave type in native HRM reads, and verify the result in the leave calendar.",
    input: z.object({
      employmentId: HRM_UUID.describe("Employment id from hrm_employment_as_of."),
      leaveTypeId: HRM_UUID.describe("Leave type id from the HRM leave setup read."),
      onDate: HRM_DATE.describe("Date of the absence."),
      hours: exactHours,
      reason: hrmShortText("Reason for recording this absence.", 2000).nullable().optional(),
    }),
    permission: "hrm.leave.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const absence = await recordAbsence({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, absence, absenceId: absence.id, href: "/hrm/leave" };
    },
  }),
];
