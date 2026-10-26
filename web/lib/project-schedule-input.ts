import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { canonicalDecimal } from "./exact-decimal";
import { moneyRefusal } from "./payroll-decimal-refusal";

const project = { projectId: uuidString() };
const taskPatchShape = {
  phaseId: z.string().nullable().optional(),
  calendarId: uuidString().nullable().optional(),
  parentTaskId: uuidString().nullable().optional(),
  outlineLevel: z.number().int().min(0).optional(),
  name: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(5000).optional(),
  taskType: z.enum(["task", "milestone", "summary"]).optional(),
  status: z.enum(["not_started", "in_progress", "complete", "on_hold"]).optional(),
  startDate: z
    .string()
    .refine(isIsoCalendarDate, "startDate must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  endDate: z
    .string()
    .refine(isIsoCalendarDate, "endDate must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  duration: z.number().finite().min(0).optional(),
  progress: z.number().finite().min(0).max(100).optional(),
  assignee: z.string().max(500).optional(),
  order: z.number().int().min(0).optional(),
  resourceAssignments: z
    .array(
      z.strictObject({
        resourceId: uuidString(),
        units: z.number().finite().positive().optional(),
        role: z.string().max(200).optional(),
      }),
    )
    .optional(),
  constraintType: z.enum(["asap", "alap", "snet", "snlt", "fnet", "fnlt", "mso", "mfo"]).optional(),
  constraintDate: z
    .string()
    .refine(isIsoCalendarDate, "constraintDate must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  deadlineDate: z
    .string()
    .refine(isIsoCalendarDate, "deadlineDate must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  actualStart: z
    .string()
    .refine(isIsoCalendarDate, "actualStart must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
  actualEnd: z
    .string()
    .refine(isIsoCalendarDate, "actualEnd must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional(),
};
const taskPatch = z.strictObject(taskPatchShape);
const taskCreate = z.strictObject({ ...taskPatchShape, name: z.string().trim().min(1).max(500) });
const dependencyInput = z.strictObject({
  predecessorId: uuidString(),
  successorId: uuidString(),
  type: z.enum(["FS", "SS", "FF", "SF"]).optional(),
  lagDays: z.number().int().min(-2147483648).max(2147483647).optional(),
});
const baselineInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(["primary", "secondary", "tertiary", "snapshot", "custom"]).optional(),
  isPrimary: z.boolean().optional(),
});
const calendarInput = z
  .strictObject({
    id: uuidString().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    workingDays: z.record(z.string().regex(/^[0-6]$/), z.boolean()).optional(),
    holidays: z
      .array(
        z.string().refine(isIsoCalendarDate, "holiday must be a real calendar date (YYYY-MM-DD)"),
      )
      .optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((input) => Boolean(input.id) || Boolean(input.name), {
    message: "a calendar name is required when creating a calendar",
    path: ["name"],
  });
const costRate = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null)
    ctx.addIssue({ code: "custom", message: moneyRefusal("Cost rate", value) });
});
const resourceInput = z
  .strictObject({
    id: uuidString().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    role: z.string().max(200).optional(),
    kind: z.enum(["labor", "crew", "equipment", "subcontractor"]).optional(),
    calendarId: uuidString().nullable().optional(),
    defaultUnits: z.number().finite().positive().optional(),
    capacityPerDay: z.number().finite().positive().optional(),
    costRate: costRate.nullable().optional(),
  })
  .refine((input) => Boolean(input.id) || Boolean(input.name), {
    message: "a resource name is required when creating a resource",
    path: ["name"],
  });
export const projectScheduleBody = z.discriminatedUnion("action", [
  z.strictObject({ ...project, action: z.literal("createTask"), input: taskCreate }),
  z.strictObject({
    ...project,
    action: z.literal("updateTask"),
    taskId: uuidString(),
    patch: taskPatch,
  }),
  z.strictObject({
    ...project,
    action: z.literal("batchUpdateTasks"),
    updates: z.array(z.strictObject({ id: uuidString(), ...taskPatchShape })).min(1),
  }),
  z.strictObject({ ...project, action: z.literal("deleteTask"), taskId: uuidString() }),
  z.strictObject({ ...project, action: z.literal("createDependency"), input: dependencyInput }),
  z.strictObject({ ...project, action: z.literal("deleteDependency"), id: uuidString() }),
  z.strictObject({ ...project, action: z.literal("createBaseline"), input: baselineInput }),
  z.strictObject({ ...project, action: z.literal("deleteBaseline"), id: uuidString() }),
  z.strictObject({ ...project, action: z.literal("saveCalendar"), input: calendarInput }),
  z.strictObject({ ...project, action: z.literal("deleteCalendar"), id: uuidString() }),
  z.strictObject({ ...project, action: z.literal("saveResource"), input: resourceInput }),
  z.strictObject({ ...project, action: z.literal("deleteResource"), id: uuidString() }),
]);
