import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  ScheduleError,
  batchUpdateScheduleTasks,
  createScheduleBaseline,
  createScheduleDependency,
  createScheduleTask,
  deleteScheduleBaseline,
  deleteScheduleCalendar,
  deleteScheduleDependency,
  deleteScheduleResource,
  deleteScheduleTask,
  loadProjectSchedule,
  updateScheduleTask,
  upsertScheduleCalendar,
  upsertScheduleResource,
} from "../project-schedule";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by the project schedule or project record read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const canRead = (authz: Authz) => can(authz, "projects.read");
const canManage = (authz: Authz) => can(authz, "projects.manage");

async function requireScheduling(context: ApplicationContext): Promise<void> {
  const orgId = context.authz.user.orgId;
  if (
    !(await isFeatureEnabled(orgId, "projects")) ||
    !(await isFeatureEnabled(orgId, "projectScheduling"))
  ) {
    throw notFound("project schedule");
  }
}

function settleSchedule(error: unknown): never {
  if (error instanceof ScheduleError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

async function refreshedSchedule(context: ApplicationContext, projectId: string) {
  const schedule = await loadProjectSchedule(
    context.authz.user.orgId,
    projectId,
    context.authz.allowedSubsidiaryIds,
  );
  return { schedule, href: `/projects/${projectId}?tab=schedule` };
}

const taskPatchShape = {
  phaseId: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Schedule phase identifier, or null to clear."),
  calendarId: UUID.nullable()
    .optional()
    .describe("Work calendar identifier, or null to use the project default."),
  parentTaskId: UUID.nullable()
    .optional()
    .describe("Parent task id in this project's schedule outline, or null for a root task."),
  outlineLevel: z.number().int().min(0).optional().describe("Depth in the schedule outline."),
  name: z.string().trim().min(1).max(500).optional().describe("Schedule task name."),
  description: z.string().max(5000).optional().describe("Schedule task detail."),
  taskType: z.enum(["task", "milestone", "summary"]).optional().describe("Schedule task type."),
  status: z
    .enum(["not_started", "in_progress", "complete", "on_hold"])
    .optional()
    .describe("Schedule task status."),
  startDate: DATE.nullable().optional().describe("Planned start date, or null to clear."),
  endDate: DATE.nullable().optional().describe("Planned finish date, or null to clear."),
  duration: z.number().finite().min(0).optional().describe("Planned duration in work days."),
  progress: z
    .number()
    .finite()
    .min(0)
    .max(100)
    .optional()
    .describe("Schedule completion percentage from 0 through 100."),
  assignee: z.string().max(500).optional().describe("Display name or assignment label."),
  order: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Position among tasks at the same outline level."),
  resourceAssignments: z
    .array(
      z.object({
        resourceId: UUID,
        units: z.number().finite().positive().optional().describe("Assigned capacity units."),
        role: z.string().max(200).optional().describe("Role for this resource on the task."),
      }),
    )
    .max(100)
    .optional()
    .describe("Complete replacement set of schedule resources assigned to this task."),
  constraintType: z
    .enum(["asap", "alap", "snet", "snlt", "fnet", "fnlt", "mso", "mfo"])
    .optional()
    .describe("Scheduling constraint type."),
  constraintDate: DATE.nullable().optional().describe("Date used by the scheduling constraint."),
  deadlineDate: DATE.nullable().optional().describe("Deadline date, or null to clear."),
  actualStart: DATE.nullable().optional().describe("Actual start date, or null to clear."),
  actualEnd: DATE.nullable().optional().describe("Actual finish date, or null to clear."),
};
const taskPatch = z.object(taskPatchShape);
const taskCreate = z.object({
  ...taskPatchShape,
  name: z.string().trim().min(1).max(500).describe("Schedule task name."),
});
const dependencyInput = z.object({
  predecessorId: UUID,
  successorId: UUID,
  type: z
    .enum(["FS", "SS", "FF", "SF"])
    .optional()
    .describe("Dependency type: finish/start, start/start, finish/finish, or start/finish."),
  lagDays: z
    .number()
    .int()
    .min(-2147483648)
    .max(2147483647)
    .optional()
    .describe("Calendar-day lag between linked tasks."),
});
const baselineInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Name for the schedule snapshot."),
  description: z.string().max(2000).optional().describe("Optional baseline description."),
  kind: z
    .enum(["primary", "secondary", "tertiary", "snapshot", "custom"])
    .optional()
    .describe("Baseline category."),
  isPrimary: z.boolean().optional().describe("Set this as the schedule's primary baseline."),
});
const calendarInput = z
  .object({
    id: UUID.optional().describe("Existing project calendar id to update; omit to create."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Calendar name; required when creating."),
    description: z.string().max(2000).optional().describe("Optional calendar description."),
    workingDays: z
      .record(z.string().regex(/^[0-6]$/), z.boolean())
      .optional()
      .describe("Whether each weekday number 0 through 6 is a working day."),
    holidays: z
      .array(DATE)
      .max(1000)
      .optional()
      .describe("Calendar dates that are non-working holidays."),
    isDefault: z.boolean().optional().describe("Make this the default project calendar."),
  })
  .refine((input) => Boolean(input.id) || Boolean(input.name), {
    message: "a calendar name is required when creating",
  });
const resourceInput = z
  .object({
    id: UUID.optional().describe("Existing project resource id to update; omit to create."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Resource name; required when creating."),
    role: z.string().max(200).optional().describe("Resource role."),
    kind: z
      .enum(["labor", "crew", "equipment", "subcontractor"])
      .optional()
      .describe("Resource category."),
    calendarId: UUID.nullable()
      .optional()
      .describe("Work calendar id, or null for the default calendar."),
    defaultUnits: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe("Default assigned capacity units."),
    capacityPerDay: z
      .number()
      .finite()
      .positive()
      .optional()
      .describe("Daily capacity in resource units."),
    costRate: z
      .string()
      .max(40)
      .nullable()
      .optional()
      .describe("Exact decimal hourly cost rate, or null to clear."),
  })
  .refine((input) => Boolean(input.id) || Boolean(input.name), {
    message: "a resource name is required when creating",
  });

type Mutation<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  destructive?: boolean;
  visibleTo?: (authz: Authz) => boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
};

function scheduleMutation<T extends z.ZodTypeAny>(args: Mutation<T>): ApplicationToolDefinition {
  return definition({
    ...args,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: args.visibleTo ?? canManage,
    featureKey: "projectScheduling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireScheduling(context);
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleSchedule(error);
      }
    },
  });
}

export const PROJECT_SCHEDULE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_project_schedule",
    title: "Get Project Schedule",
    description:
      "Read schedule tasks, dependencies, resources, calendars, and baselines for a project. Find the project id with list_records.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canRead,
    featureKey: "projectScheduling",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireScheduling(context);
      try {
        return { ok: true, ...(await refreshedSchedule(context, input.projectId)) };
      } catch (error) {
        settleSchedule(error);
      }
    },
  }),
  scheduleMutation({
    name: "create_schedule_task",
    title: "Create Schedule Task",
    description:
      "Add a task or milestone to a project's schedule. Find the project with list_records and verify the result with get_project_schedule.",
    inputSchema: z.object({
      projectId: UUID,
      input: taskCreate.describe("Complete schedule task fields."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const id = await createScheduleTask(
        context.authz.user.orgId,
        input.projectId,
        input.input as never,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, taskId: id, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "update_schedule_task",
    title: "Update Schedule Task",
    description:
      "Change dates, status, dependencies in the outline, progress, or assignments for one schedule task. Use get_project_schedule for its current values and id.",
    inputSchema: z.object({
      projectId: UUID,
      taskId: UUID,
      patch: taskPatch.describe("Fields to change on this schedule task."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await updateScheduleTask(
        context.authz.user.orgId,
        input.projectId,
        input.taskId,
        input.patch as never,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        taskId: input.taskId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
  scheduleMutation({
    name: "batch_update_schedule_tasks",
    title: "Batch Update Schedule Tasks",
    description:
      "Apply a set of schedule task changes atomically, including outline moves. Use get_project_schedule to obtain current task ids and values.",
    inputSchema: z.object({
      projectId: UUID,
      updates: z
        .array(z.object({ id: UUID, ...taskPatchShape }))
        .min(1)
        .max(1000)
        .describe("Task ids and their changed schedule fields."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await batchUpdateScheduleTasks(
        context.authz.user.orgId,
        input.projectId,
        input.updates as never,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "delete_schedule_task",
    title: "Delete Schedule Task",
    description:
      "Remove a schedule task with no time-entry history; child tasks are lifted to the top level. Find task ids with get_project_schedule.",
    inputSchema: z.object({ projectId: UUID, taskId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await deleteScheduleTask(
        context.authz.user.orgId,
        input.projectId,
        input.taskId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        taskId: input.taskId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
  scheduleMutation({
    name: "create_schedule_dependency",
    title: "Create Schedule Dependency",
    description:
      "Link two tasks with a supported dependency and lag; cyclic schedules are refused. Find both task ids with get_project_schedule.",
    inputSchema: z.object({
      projectId: UUID,
      input: dependencyInput.describe("Dependency between two tasks in this project."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await createScheduleDependency(
        context.authz.user.orgId,
        input.projectId,
        input.input,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "delete_schedule_dependency",
    title: "Delete Schedule Dependency",
    description: "Remove a dependency between schedule tasks. Find its id in get_project_schedule.",
    inputSchema: z.object({ projectId: UUID, dependencyId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await deleteScheduleDependency(
        context.authz.user.orgId,
        input.projectId,
        input.dependencyId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        dependencyId: input.dependencyId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
  scheduleMutation({
    name: "create_schedule_baseline",
    title: "Create Schedule Baseline",
    description:
      "Capture the current schedule as a named baseline, optionally making it primary. Verify it with get_project_schedule.",
    inputSchema: z.object({
      projectId: UUID,
      input: baselineInput.describe("Name and classification of the schedule baseline."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      await createScheduleBaseline(
        context.authz.user.orgId,
        input.projectId,
        input.input,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "delete_schedule_baseline",
    title: "Delete Schedule Baseline",
    description:
      "Delete a project schedule baseline and its snapshot rows. Find the baseline id with get_project_schedule.",
    inputSchema: z.object({ projectId: UUID, baselineId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await deleteScheduleBaseline(
        context.authz.user.orgId,
        input.projectId,
        input.baselineId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        baselineId: input.baselineId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
  scheduleMutation({
    name: "save_schedule_calendar",
    title: "Save Schedule Calendar",
    description:
      "Create or update a project work calendar with working days, holidays, and default status. Find calendar ids with get_project_schedule.",
    inputSchema: z.object({
      projectId: UUID,
      input: calendarInput.describe("Calendar fields to create or update."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const calendarId = await upsertScheduleCalendar(
        context.authz.user.orgId,
        input.projectId,
        input.input,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, calendarId, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "delete_schedule_calendar",
    title: "Delete Schedule Calendar",
    description:
      "Delete a project calendar; tasks and resources fall back to the default calendar. Find the id with get_project_schedule.",
    inputSchema: z.object({ projectId: UUID, calendarId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await deleteScheduleCalendar(
        context.authz.user.orgId,
        input.projectId,
        input.calendarId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        calendarId: input.calendarId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
  scheduleMutation({
    name: "save_schedule_resource",
    title: "Save Schedule Resource",
    description:
      "Create or update a labor, crew, equipment, or subcontractor resource and its exact cost rate. Find resource ids with get_project_schedule.",
    inputSchema: z.object({
      projectId: UUID,
      input: resourceInput.describe("Schedule resource fields to create or update."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const resourceId = await upsertScheduleResource(
        context.authz.user.orgId,
        input.projectId,
        input.input,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, resourceId, ...(await refreshedSchedule(context, input.projectId)) };
    },
  }),
  scheduleMutation({
    name: "delete_schedule_resource",
    title: "Delete Schedule Resource",
    description:
      "Remove a project schedule resource and its task assignments. Find its id with get_project_schedule.",
    inputSchema: z.object({ projectId: UUID, resourceId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      await deleteScheduleResource(
        context.authz.user.orgId,
        input.projectId,
        input.resourceId,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        resourceId: input.resourceId,
        ...(await refreshedSchedule(context, input.projectId)),
      };
    },
  }),
];
