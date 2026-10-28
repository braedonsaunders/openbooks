import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import { loadWorkSchedules } from "@openbooks/engine/payroll/work-schedules/operations";
import { isFeatureEnabled } from "../features";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { notFound } from "./errors";
import { type ApplicationToolDefinition } from "./tool-definition";
import { timeDefinition } from "./time-tool-common";
import { IDEMPOTENCY_KEY, settleTimeResponse } from "./time-tool-common";
import {
  deleteWorkScheduleBodySchema,
  saveWorkScheduleBodySchema,
  writeWorkSchedule,
} from "../work-schedules-write";

function assertScheduleAccess(context: ApplicationContext): void {
  assertApplicationPermission(context, "admin.setup.manage");
}

function scopedIds(context: ApplicationContext) {
  return context.authz.allowedSubsidiaryIds === undefined
    ? new Set<string>()
    : context.authz.allowedSubsidiaryIds;
}

async function assertPayrollEnabled(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "payroll"))) throw notFound("record");
}

export const WORK_SCHEDULE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  timeDefinition({
    name: "list_work_schedules",
    title: "List Work Schedules",
    description:
      "List effective-dated employee work patterns used by workforce planning and holiday pay. Use this when you need schedule ids or current cycle hours before making a change.",
    inputSchema: z.object({}).strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "payroll",
    execute: async (context) => {
      assertScheduleAccess(context);
      await assertPayrollEnabled(context);
      const schedules = await loadWorkSchedules(db, context.authz.user.orgId, scopedIds(context));
      return { ok: true, schedules, href: "/admin/setup/payroll?tab=workSchedules" };
    },
  }),
  timeDefinition({
    name: "save_work_schedule",
    title: "Save Work Schedule",
    description:
      "Create or replace an effective-dated work pattern and its cycle days atomically. Use `list_work_schedules` to find the existing schedule id and confirm the saved hours.",
    inputSchema: saveWorkScheduleBodySchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      assertScheduleAccess(context);
      await assertPayrollEnabled(context);
      const { idempotencyKey: _key, ...body } = input;
      const response = await writeWorkSchedule({ authz: context.authz, body });
      const result = await settleTimeResponse(response);
      const scheduleId = typeof result.id === "string" ? result.id : body.id;
      return {
        ok: true,
        scheduleId,
        status: "saved",
        result,
        href: "/admin/setup/payroll?tab=workSchedules",
      };
    },
  }),
  timeDefinition({
    name: "delete_work_schedule",
    title: "Delete Work Schedule",
    description:
      "Retire a work schedule and its repeating day rows with an audit snapshot. Use `list_work_schedules` to confirm the schedule id and verify that it no longer appears.",
    inputSchema: deleteWorkScheduleBodySchema.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "payroll",
    execute: async (context, input) => {
      assertScheduleAccess(context);
      await assertPayrollEnabled(context);
      const { idempotencyKey: _key, ...body } = input;
      const response = await writeWorkSchedule({ authz: context.authz, body });
      const result = await settleTimeResponse(response);
      return {
        ok: true,
        scheduleId: body.id,
        status: "deleted",
        result,
        href: "/admin/setup/payroll?tab=workSchedules",
      };
    },
  }),
];
