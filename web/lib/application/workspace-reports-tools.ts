import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import {
  createSavedReportShortcut,
  deleteSavedReportShortcut,
  listSavedReportShortcuts,
} from "../saved-report-write";
import { IncompleteReportPeriodError } from "../report-filters";
import { loadReportDefinition } from "../custom-reports";
import { canAccessReportDefinition } from "../report-execution-context";
import {
  archiveReportDefinition,
  createReportDefinition,
  updateReportDefinition,
} from "../report-definition-write";
import {
  createReportSchedule,
  deleteReportSchedule,
  updateReportSchedule,
} from "../report-schedule-write";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from list_report_definitions.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REPORT_EMAIL = z
  .string()
  .max(320)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  .describe("Recipient email address.");

function reportDefinitionIdempotencyId(orgId: string, key: string): string {
  const hash = createHash("sha256").update(`report-definition:${orgId}:${key}`).digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const REPORT_LAYOUT = z
  .object({
    paperSize: z.enum(["letter", "legal", "a4"]).optional().describe("Paper size."),
    orientation: z.enum(["portrait", "landscape"]).optional().describe("Page orientation."),
    marginMm: z.number().finite().optional().describe("Page margin in millimeters."),
    showSummary: z.boolean().optional().describe("Whether to show the summary section."),
    density: z.enum(["compact", "standard"]).optional().describe("Table density."),
  })
  .nullable()
  .optional()
  .describe("Optional printable report layout.");

async function assertCreatePermission(context: ApplicationContext) {
  assertApplicationPermission(context, "reports.create");
}

export const WORKSPACE_REPORT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_saved_report_shortcuts",
    title: "List Saved Report Shortcuts",
    description:
      "List the recent saved report shortcuts shown in the Reports hub, including their path and parameters. Requires reports.read; use the shortcut id when removing an entry and its path when reopening the report.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "reports.read");
      const shortcuts = await listSavedReportShortcuts(context.authz.user.orgId);
      return { shortcuts, total: shortcuts.length, href: "/reports" };
    },
  }),
  definition({
    name: "create_saved_report_shortcut",
    title: "Create Saved Report Shortcut",
    description:
      "Save a report path and its filters in the Reports hub. Requires reports.create; custom periods must include valid from and to dates, and list_saved_report_shortcuts verifies the new shortcut.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Shortcut label shown in the Reports hub."),
      path: z
        .string()
        .regex(/^\/reports(?:\/|$)/)
        .describe("Canonical report path beginning with /reports."),
      params: z
        .record(z.string(), z.string().describe("Saved report parameter value."))
        .optional()
        .describe("Report filter parameters to reopen with the shortcut."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertCreatePermission(context);
      try {
        const shortcut = await createSavedReportShortcut(context.authz, input);
        return {
          ok: true,
          savedReportId: shortcut.id,
          status: "saved",
          href: input.path,
        };
      } catch (error) {
        if (error instanceof IncompleteReportPeriodError) {
          throw new ApplicationError("invalid_input", error.message, error.status, {
            code: error.code,
            remedy: error.remedy,
            from: error.from,
            to: error.to,
          });
        }
        throw error;
      }
    },
  }),
  definition({
    name: "delete_saved_report_shortcut",
    title: "Delete Saved Report Shortcut",
    description:
      "Remove a saved report shortcut you own, or any shortcut when you have administrator access. Requires reports.create; use list_saved_report_shortcuts to resolve its id.",
    inputSchema: z.object({ savedReportId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertCreatePermission(context);
      if (!(await deleteSavedReportShortcut(context.authz, input.savedReportId))) {
        throw new ApplicationError("forbidden", "You can only delete your own saved reports.", 403);
      }
      return { ok: true, savedReportId: input.savedReportId, status: "deleted", href: "/reports" };
    },
  }),
  definition({
    name: "create_report_schedule",
    title: "Create Report Schedule",
    description:
      "Schedule an accessible report for recurring delivery. Active schedules require at least one valid recipient; use list_report_definitions to resolve definitionId and list_report_schedules to verify cadence and next run.",
    inputSchema: z.object({
      definitionId: UUID,
      cadence: z.enum(["daily", "weekly", "monthly"]).describe("Delivery frequency."),
      dayOfWeek: z
        .number()
        .int()
        .min(0)
        .max(6)
        .nullable()
        .optional()
        .describe("Weekly day, Sunday 0 through Saturday 6."),
      dayOfMonth: z.number().int().min(1).max(31).nullable().optional().describe("Monthly day."),
      hour: z.number().int().min(0).max(23).optional().describe("Local delivery hour."),
      minute: z.number().int().min(0).max(59).optional().describe("Local delivery minute."),
      timezone: z.string().min(1).max(100).describe("IANA time zone for the schedule."),
      recipientEmails: z
        .array(REPORT_EMAIL)
        .max(100)
        .describe("Recipients for each scheduled delivery."),
      active: z.boolean().optional().describe("Whether the new schedule should begin running."),
      statementParams: z
        .record(z.string(), z.string().max(256).describe("Statement parameter value."))
        .optional()
        .describe("Statement filters for statement reports."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.schedule"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.schedule");
      const schedule = await createReportSchedule(context.authz, input, context.requestId);
      return {
        ok: true,
        schedule,
        scheduleId: String(schedule.id),
        status: input.active === false ? "inactive" : "active",
        href: `/reports/custom/run/${input.definitionId}/delivery`,
      };
    },
  }),
  definition({
    name: "update_report_schedule",
    title: "Update Report Schedule",
    description:
      "Change the cadence, recipients, time zone, or active state of an accessible report schedule. Requires reports.schedule and the schedule's original report scope; use list_report_schedules to resolve scheduleId and verify the next run.",
    inputSchema: z
      .object({
        scheduleId: UUID,
        cadence: z
          .enum(["daily", "weekly", "monthly"])
          .optional()
          .describe("New delivery cadence."),
        dayOfWeek: z
          .number()
          .int()
          .min(0)
          .max(6)
          .nullable()
          .optional()
          .describe("Weekly day, Sunday 0 through Saturday 6."),
        dayOfMonth: z.number().int().min(1).max(31).nullable().optional().describe("Monthly day."),
        hour: z.number().int().min(0).max(23).optional().describe("Local delivery hour."),
        minute: z.number().int().min(0).max(59).optional().describe("Local delivery minute."),
        timezone: z.string().min(1).max(100).optional().describe("IANA time zone."),
        recipientEmails: z
          .array(REPORT_EMAIL)
          .max(100)
          .optional()
          .describe("Replacement recipient list."),
        active: z.boolean().optional().describe("Whether the schedule should run."),
        reason: z.string().max(500).optional().describe("Audit reason for the change."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        ({
          cadence,
          dayOfWeek,
          dayOfMonth,
          hour,
          minute,
          timezone,
          recipientEmails,
          active,
          reason,
        }) =>
          cadence !== undefined ||
          dayOfWeek !== undefined ||
          dayOfMonth !== undefined ||
          hour !== undefined ||
          minute !== undefined ||
          timezone !== undefined ||
          recipientEmails !== undefined ||
          active !== undefined ||
          reason !== undefined,
        "provide a schedule field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.schedule"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.schedule");
      const schedule = await updateReportSchedule(
        context.authz,
        input.scheduleId,
        input,
        context.requestId,
      );
      return {
        ok: true,
        schedule,
        scheduleId: input.scheduleId,
        status: schedule.active ? "active" : "inactive",
        href: `/reports/custom/run/${schedule.definition_id}/delivery`,
      };
    },
  }),
  definition({
    name: "delete_report_schedule",
    title: "Delete Report Schedule",
    description:
      "Delete an accessible report schedule and its delivery configuration. Requires reports.schedule and access to the schedule's original report content; use list_report_schedules to resolve scheduleId.",
    inputSchema: z.object({
      scheduleId: UUID,
      reason: z.string().max(500).optional().describe("Audit reason for removing the schedule."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.schedule"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.schedule");
      await deleteReportSchedule(context.authz, input.scheduleId, input.reason, context.requestId);
      return { ok: true, scheduleId: input.scheduleId, status: "deleted", href: "/reports" };
    },
  }),
  definition({
    name: "delete_report_definition",
    title: "Delete Report Definition",
    description:
      "Archive a custom report definition and disable its scheduled deliveries. Built-in reports cannot be deleted; requires reports.create and access to the report. Use list_report_definitions to resolve the id and verify it is archived.",
    inputSchema: z.object({ definitionId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.create");
      await archiveReportDefinition(context.authz, input.definitionId);
      return { ok: true, definitionId: input.definitionId, status: "archived", href: "/reports" };
    },
  }),
  definition({
    name: "update_report_definition",
    title: "Update Report Definition",
    description:
      "Save changes to a report definition with its exact expectedUpdatedAt revision from get_report_definition. Requires reports.create and access to the report; stale revisions refuse with a reload remedy.",
    inputSchema: z
      .object({
        definitionId: UUID,
        expectedUpdatedAt: z
          .string()
          .max(27)
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
          .describe("Exact report revision token copied from get_report_definition."),
        name: z.string().trim().min(1).max(200).optional().describe("New report name."),
        description: z
          .string()
          .max(2000)
          .nullable()
          .optional()
          .describe("New description, or null to clear it."),
        query: z.json().optional().describe("Replacement report query definition."),
        layout: REPORT_LAYOUT,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.name !== undefined ||
          input.description !== undefined ||
          input.query !== undefined ||
          input.layout !== undefined,
        "provide at least one report field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.create");
      const report = await updateReportDefinition(context.authz, input.definitionId, input);
      return {
        ok: true,
        definition: report,
        definitionId: input.definitionId,
        status: "updated",
        href: `/reports/custom/builder/${input.definitionId}`,
      };
    },
  }),
  definition({
    name: "create_report_definition",
    title: "Create Report Definition",
    description:
      "Save a custom query report definition after its query passes the report catalog and entity permission checks. Use report query vocabulary and list_report_definitions to verify the saved id.",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Report name."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Optional report description."),
      query: z.json().describe("Validated report query definition."),
      layout: REPORT_LAYOUT,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      await assertCreatePermission(context);
      const created = await createReportDefinition(
        context.authz,
        input,
        reportDefinitionIdempotencyId(context.authz.user.orgId, input.idempotencyKey),
      );
      const id = String(created.definition.id);
      return {
        ok: true,
        definition: created.definition,
        definitionId: id,
        status: "created",
        href: `/reports/custom/builder/${id}`,
      };
    },
  }),
  definition({
    name: "clone_report_definition",
    title: "Clone Report Definition",
    description:
      "Clone a visible custom query report into a new definition that can be edited independently. Requires reports.create and access to the source; use list_report_definitions to resolve the source id and verify the clone.",
    inputSchema: z.object({
      definitionId: UUID,
      name: z.string().trim().min(1).max(200).describe("Name for the copied report."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "reports.create"),
    execute: async (context, input) => {
      await assertCreatePermission(context);
      const source = await loadReportDefinition(context.authz.user.orgId, input.definitionId);
      if (!source || !(await canAccessReportDefinition(context.authz, source))) {
        throw notFound("report");
      }
      if (!source.query) {
        throw notFound("custom query report");
      }
      const created = await createReportDefinition(
        context.authz,
        {
          name: input.name,
          description: source.description,
          query: source.query,
          layout: source.layout,
        },
        reportDefinitionIdempotencyId(context.authz.user.orgId, input.idempotencyKey),
      );
      const id = String(created.definition.id);
      return {
        ok: true,
        sourceDefinitionId: input.definitionId,
        definition: created.definition,
        definitionId: id,
        status: "created",
        href: `/reports/custom/builder/${id}`,
      };
    },
  }),
];
