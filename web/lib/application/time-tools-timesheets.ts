import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { type ApplicationToolDefinition } from "./tool-definition";
import { timeDefinition } from "./time-tool-common";
import { notFound } from "./errors";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { correctUnapprovedTimeType } from "@openbooks/engine/projects/time-type-correction";
import { amendLockedWeek, amendTimeEntry } from "../time-amendment";
import { saveBodySchema, saveTimesheetEntries } from "../time-entry-write";
import { billableBodySchema, handleTimesheetBillable } from "../time-entry-billable";
import {
  handleReopenTimesheet,
  handleSubmitTimesheet,
  handleWithdrawTimesheet,
  reopenTimesheetBodySchema,
  submitTimesheetBodySchema,
  withdrawTimesheetBodySchema,
} from "../timesheet-week-lifecycle";
import {
  loadWeek,
  pinTimekeeper,
  pinTimekeeperEntry,
  weekStart,
} from "../../app/api/timesheets/_lib";
import {
  DATE,
  IDEMPOTENCY_KEY,
  settleTimeRefusal,
  settleTimeResponse,
  UUID,
} from "./time-tool-common";

const WORK_FAMILY = z
  .enum(["project", "production"])
  .describe("Time workspace for the entry target.");
const WEEK = DATE.describe("Any date within the Sunday-start week.");

function assertTimePermission(
  context: ApplicationContext,
  permission: "time.manage" | "time.reopen",
) {
  if (can(context.authz, permission)) return;
  if (permission === "time.manage" && can(context.authz, "time.self")) return;
  assertApplicationPermission(context, permission);
}

function timeHref(employeeId: string): string {
  return `/timesheets?employee=${encodeURIComponent(employeeId)}`;
}

export const TIMESHEETS_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  timeDefinition({
    name: "set_submitted_time_line_billable",
    title: "Set Submitted Time Line Billable",
    description:
      "Mark a submitted project time line billable or non-billable before approval. Use `get_timesheet_week` for its exact line values; approved or billed lines require reopen, amendment or invoice correction.",
    inputSchema: billableBodySchema.extend({
      expectedWorkFamily: WORK_FAMILY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.approve"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.approve");
      const { idempotencyKey: _key, expectedWorkFamily, ...body } = input;
      const response = await handleTimesheetBillable({
        request: new Request(
          `http://localhost/api/timesheets/billable?workFamily=${expectedWorkFamily}`,
        ),
        authz: context.authz,
        body,
      });
      const result = await settleTimeResponse(response);
      return { ok: true, ...result, href: timeHref(input.employee) };
    },
  }),
  timeDefinition({
    name: "save_timesheet_week",
    title: "Save Timesheet Week",
    description:
      "Replace the editable draft or rejected entries in a weekly grid, preserving revision checks and immutable submitted or approved time. Use `search_timesheets` and `get_timesheet_week` for the employee, week and current revision.",
    inputSchema: saveBodySchema
      .extend({
        expectedWorkFamily: WORK_FAMILY,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((body, ctx) => {
        body.rows.forEach((row, rowIndex) =>
          row.hours.forEach((hours, dayIndex) => {
            if (typeof hours === "number")
              ctx.addIssue({
                code: "custom",
                path: ["rows", rowIndex, "hours", dayIndex],
                message: "Send hours as an exact decimal string, not a JSON number.",
              });
          }),
        );
      }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.manage") || can(authz, "time.self"),
    execute: async (context, input) => {
      assertTimePermission(context, "time.manage");
      const { expectedWorkFamily, idempotencyKey: _key, ...body } = input;
      const response = await saveTimesheetEntries({
        request: new Request(`http://localhost/api/timesheets?workFamily=${expectedWorkFamily}`),
        authz: context.authz,
        body,
      });
      const result = await settleTimeResponse(response);
      return { ok: true, ...result, href: timeHref(input.employee) };
    },
  }),
  timeDefinition({
    name: "submit_timesheet_week",
    title: "Submit Timesheet Week",
    description:
      "Submit a draft or rejected employee week into the configured approval Flow. Use search_timesheets and get_timesheet_week for the employee, week and current revision; additional time requires its exact pending entry timestamps.",
    inputSchema: submitTimesheetBodySchema.safeExtend({
      expectedWorkFamily: WORK_FAMILY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.manage") || can(authz, "time.self"),
    execute: async (context, input) => {
      assertTimePermission(context, "time.manage");
      const { expectedWorkFamily, idempotencyKey: _key, ...body } = input;
      const response = await handleSubmitTimesheet({
        request: new Request(
          "http://localhost/api/timesheets/submit?workFamily=" + expectedWorkFamily,
        ),
        authz: context.authz,
        body,
      });
      const result = await settleTimeResponse(response);
      return { ok: true, ...result, href: timeHref(input.employee) };
    },
  }),
  timeDefinition({
    name: "reopen_timesheet_week",
    title: "Reopen Timesheet Week",
    description:
      "Return an approved, unlocked week to draft for correction. Use get_timesheet_week to inspect its status and locks; consumed time must be amended instead.",
    inputSchema: reopenTimesheetBodySchema.extend({
      expectedWorkFamily: WORK_FAMILY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.reopen"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.reopen");
      const { expectedWorkFamily, idempotencyKey: _key, ...body } = input;
      const response = await handleReopenTimesheet({
        request: new Request(
          "http://localhost/api/timesheets/reopen?workFamily=" + expectedWorkFamily,
        ),
        authz: context.authz,
        body,
      });
      const result = await settleTimeResponse(response);
      return { ok: true, ...result, href: timeHref(input.employee) };
    },
  }),
  timeDefinition({
    name: "withdraw_timesheet_week",
    title: "Withdraw Timesheet Week",
    description:
      "Recall your submitted week to draft and cancel its open approval work. Use get_timesheet_week to confirm it is still submitted; decided weeks require reject or reopen.",
    inputSchema: withdrawTimesheetBodySchema.extend({
      expectedWorkFamily: WORK_FAMILY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.manage") || can(authz, "time.self"),
    execute: async (context, input) => {
      assertTimePermission(context, "time.manage");
      const { expectedWorkFamily, idempotencyKey: _key, ...body } = input;
      const response = await handleWithdrawTimesheet({
        request: new Request(
          "http://localhost/api/timesheets/withdraw?workFamily=" + expectedWorkFamily,
        ),
        authz: context.authz,
        body,
      });
      const result = await settleTimeResponse(response);
      return { ok: true, ...result, href: timeHref(input.employee) };
    },
  }),
  timeDefinition({
    name: "amend_time_entry",
    title: "Amend Time Entry",
    description:
      "Create governed offset entries for a consumed time entry that cannot be reopened. Find the entry in `get_timesheet_week`; a replacement requires exact hours and an audit reason.",
    inputSchema: z.object({
      entryId: UUID.describe("Consumed time entry id from get_timesheet_week."),
      replacement: z
        .object({
          hours: z
            .string()
            .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/)
            .describe("Replacement hours as an exact decimal string."),
          reason: z.string().trim().min(5).max(500).describe("Reason for the amendment."),
        })
        .strict()
        .optional()
        .describe("Replacement hours; omit to reverse the source entry."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.reopen"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.reopen");
      try {
        const employee = await pinTimekeeperEntry(
          context.authz.user.orgId,
          input.entryId,
          context.authz.allowedSubsidiaryIds,
        );
        if (!employee) throw notFound("time entry");
        const result = await amendTimeEntry(
          context.authz.user.orgId,
          context.authz.user.id,
          input.entryId,
          context.authz.allowedSubsidiaryIds,
          input.replacement,
        );
        const timesheet = await loadWeek(
          context.authz.user.orgId,
          employee,
          result.week,
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          entryId: input.entryId,
          amendmentId: result.id,
          status: "amended",
          timesheet,
          href: timeHref(employee),
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "amend_timesheet_week",
    title: "Amend Timesheet Week",
    description:
      "Amend every consumed entry in a locked week with offsetting entries. Use `get_timesheet_week` to confirm the employee and week; the service records the reason and source links.",
    inputSchema: z.object({
      employeePartyId: UUID.describe("Employee party id from search_timesheets."),
      week: WEEK,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.reopen"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.reopen");
      try {
        const employee = await pinTimekeeper(
          context.authz.user.orgId,
          input.employeePartyId,
          context.authz.allowedSubsidiaryIds,
        );
        if (!employee) throw notFound("timesheet week");
        const week = weekStart(input.week);
        const result = await amendLockedWeek(
          context.authz.user.orgId,
          context.authz.user.id,
          employee,
          week,
          context.authz.allowedSubsidiaryIds,
        );
        const timesheet = await loadWeek(
          context.authz.user.orgId,
          employee,
          week,
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          employeePartyId: employee,
          week,
          status: "amended",
          amendments: result,
          timesheet,
          href: timeHref(employee),
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "correct_unapproved_time_type",
    title: "Correct Unapproved Time Type",
    description:
      "Correct a time type on an unapproved entry with revision checks and an audit reason. Find the week and entry in `get_timesheet_week`; approved time uses amendment or reopen instead.",
    inputSchema: z.object({
      employeePartyId: UUID.describe("Employee party id from search_timesheets."),
      weekStart: DATE.describe("Sunday starting the week."),
      entryId: UUID.describe("Time entry id from get_timesheet_week."),
      expectedUpdatedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        .describe("Entry timestamp from the current week read."),
      timeTypeId: UUID.describe("Replacement time type id."),
      timeTypeUpdatedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
        .describe("Time type timestamp from its current read."),
      commandId: UUID.describe("Unique command UUID for native correction idempotency."),
      reason: z.string().trim().min(10).max(500).describe("Reason for correcting the time type."),
      expectedWorkFamily: WORK_FAMILY,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "time.manage") || can(authz, "time.self"),
    execute: async (context, input) => {
      assertTimePermission(context, "time.manage");
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, async () =>
          correctUnapprovedTimeType({
            ...input,
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            requestedScope: context.authz.allowedSubsidiaryIds,
            workFamily: input.expectedWorkFamily,
          }),
        );
        const timesheet = await loadWeek(
          context.authz.user.orgId,
          input.employeePartyId,
          weekStart(input.weekStart),
          context.authz.allowedSubsidiaryIds,
        );
        return {
          ok: true,
          employeePartyId: input.employeePartyId,
          entryId: input.entryId,
          status: "corrected",
          correction: result,
          timesheet,
          href: timeHref(input.employeePartyId),
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
];
