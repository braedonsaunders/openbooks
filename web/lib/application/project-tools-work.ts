import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  captureBudgetBaseline,
  listBudgetBaselines,
  BudgetBaselineError,
} from "@openbooks/engine/projects/budget-baselines";
import {
  listForecasts,
  recordForecast,
  suggestForecasts,
} from "@openbooks/engine/projects/forecasts";
import {
  listProgress,
  ProjectProgressError,
  recordProgress,
  reverseProgress,
} from "@openbooks/engine/projects/progress";
import {
  createWorkBreakdownTask,
  loadWorkBreakdownTasks,
  updateWorkBreakdownTask,
} from "../project-work-breakdown";
import {
  parseExpectedTaskVersion,
  parseTaskReason,
  parseWorkBreakdownTaskInput,
  ProjectWorkBreakdownError,
} from "../project-work-breakdown-validation";
import { isFeatureEnabled } from "../features";
import { updateProjectPercentComplete } from "../project-percent-complete";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by a project read command.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

const projectReader = (authz: Authz) => can(authz, "projects.read");
const projectManager = (authz: Authz) => can(authz, "projects.manage");

async function requireProjectFeatures(context: ApplicationContext, child?: string): Promise<void> {
  const orgId = context.authz.user.orgId;
  if (!(await isFeatureEnabled(orgId, "projects"))) throw notFound("project");
  if (child && !(await isFeatureEnabled(orgId, child))) throw notFound("project");
}

function settleProjectWorkError(error: unknown): never {
  if (error instanceof ProjectWorkBreakdownError) {
    if (error.status === 404) throw notFound("project task");
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  if (error instanceof BudgetBaselineError) {
    if (error.status === 404) throw notFound("budget baseline");
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  if (error instanceof ProjectProgressError) {
    const details = {
      code: error.code,
      ...(error.remedy ? { remedy: error.remedy } : {}),
    };
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (error.status === 409) throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

const taskFields = {
  code: z.string().max(80).nullable().optional().describe("Optional WBS code."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Task name shown in the project's work breakdown."),
  status: z
    .enum(["open", "complete", "cancelled"])
    .optional()
    .describe(
      "Task lifecycle state; reopen through open before changing one terminal state to another.",
    ),
  estimatedHours: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Budgeted hours as exact decimal text."),
  estimatedCost: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Budgeted cost as exact decimal text."),
  estimatedPrice: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Budgeted contract price as exact decimal text."),
  budgetQuantity: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Budgeted production quantity as exact decimal text."),
  budgetUnit: z
    .string()
    .max(80)
    .nullable()
    .optional()
    .describe("Unit for the budgeted production quantity."),
};

export const PROJECT_WORK_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_project_work_breakdown",
    title: "List Project Work Breakdown",
    description:
      "List the WBS tasks and their current budget fields for a project. Use the project record read to find the project id first.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: projectReader,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjectFeatures(context);
      try {
        return {
          ok: true,
          tasks: await loadWorkBreakdownTasks(
            context.authz.user.orgId,
            input.projectId,
            context.authz.allowedSubsidiaryIds,
          ),
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "create_project_task",
    title: "Create Project Task",
    description:
      "Add a task to a project's WBS, including optional exact-decimal hour, cost, price, and production budgets. Find the project with list_records and verify the result with list_project_work_breakdown.",
    inputSchema: z.object({ projectId: UUID, ...taskFields, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context);
      const { projectId, idempotencyKey: _key, ...task } = input;
      try {
        const created = await createWorkBreakdownTask({
          orgId: context.authz.user.orgId,
          projectId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          input: parseWorkBreakdownTaskInput(task),
        });
        return { ok: true, task: created, projectId, href: `/projects/${projectId}` };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "update_project_task",
    title: "Update Project Task",
    description:
      "Change one WBS task's status or budget using the current updatedAt revision from list_project_work_breakdown. Reopening or changing estimates on a closed task requires a reason.",
    inputSchema: z.object({
      projectId: UUID,
      taskId: UUID,
      ...taskFields,
      expectedUpdatedAt: z
        .string()
        .min(1)
        .max(200)
        .describe("The exact updatedAt revision returned by the WBS read."),
      reason: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Audit reason for reopening or changing a closed task budget."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context);
      const { projectId, taskId, expectedUpdatedAt, reason, idempotencyKey: _key, ...task } = input;
      try {
        const updated = await updateWorkBreakdownTask({
          orgId: context.authz.user.orgId,
          projectId,
          taskId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          expectedUpdatedAt: parseExpectedTaskVersion(expectedUpdatedAt),
          input: parseWorkBreakdownTaskInput(task),
          reason: parseTaskReason(reason),
        });
        return { ok: true, task: updated, projectId, href: `/projects/${projectId}` };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "list_project_budget_baselines",
    title: "List Project Budget Baselines",
    description:
      "List the original and revised budget snapshots for a project. Find its id with list_records before reading baselines.",
    inputSchema: z.object({ projectId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: projectReader,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjectFeatures(context);
      try {
        return {
          ok: true,
          baselines: await listBudgetBaselines(
            context.authz.user.orgId,
            input.projectId,
            context.authz.allowedSubsidiaryIds,
          ),
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "capture_project_budget_baseline",
    title: "Capture Project Budget Baseline",
    description:
      "Snapshot the current WBS budget as the original baseline or a revision. Find the project with list_records, then verify the saved baseline with list_project_budget_baselines.",
    inputSchema: z.object({
      projectId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Why this original or revised budget is being recorded."),
      label: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Optional label for this baseline."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context);
      try {
        const baseline = await captureBudgetBaseline(
          {
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          },
          { projectId: input.projectId, reason: input.reason, label: input.label ?? null },
        );
        return {
          ok: true,
          baseline,
          projectId: input.projectId,
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "list_project_progress",
    title: "List Project Progress",
    description:
      "Read installed-quantity history for a project or one task. Find project and task ids with list_records and list_project_work_breakdown.",
    inputSchema: z.object({
      projectId: UUID,
      taskId: UUID.nullable().optional().describe("Limit results to this WBS task."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: projectReader,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjectFeatures(context, "projectProgress");
      try {
        return {
          ok: true,
          entries: await listProgress({
            orgId: context.authz.user.orgId,
            projectId: input.projectId,
            taskId: input.taskId ?? null,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "record_project_progress",
    title: "Record Project Progress",
    description:
      "Append installed quantity to a budgeted WBS task using an exact decimal quantity and its budget unit. Find task ids with list_project_work_breakdown and verify with list_project_progress.",
    inputSchema: z.object({
      projectId: UUID,
      taskId: UUID,
      entryDate: DATE,
      quantity: z
        .string()
        .min(1)
        .max(40)
        .describe("Positive installed quantity as exact decimal text."),
      unit: z
        .string()
        .trim()
        .min(1)
        .max(32)
        .describe("Unit matching the task's production budget."),
      note: z.string().max(500).nullable().optional().describe("Optional progress note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context, "projectProgress");
      try {
        const entry = await recordProgress({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          projectId: input.projectId,
          taskId: input.taskId,
          entryDate: input.entryDate,
          quantity: input.quantity,
          unit: input.unit,
          note: input.note ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          entry,
          projectId: input.projectId,
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "reverse_project_progress",
    title: "Reverse Project Progress",
    description:
      "Append the exact negation of a manual progress entry with an audit reason. Find the entry with list_project_progress and verify the reversal there.",
    inputSchema: z.object({
      projectId: UUID,
      entryId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Reason for correcting the installed quantity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context, "projectProgress");
      try {
        const entry = await reverseProgress({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          projectId: input.projectId,
          entryId: input.entryId,
          reason: input.reason,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          entry,
          projectId: input.projectId,
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "list_project_forecasts",
    title: "List Project Forecasts",
    description:
      "List estimate-to-complete history for one WBS task. Find the task id with list_project_work_breakdown.",
    inputSchema: z.object({ projectId: UUID, taskId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: projectReader,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjectFeatures(context, "projectProgress");
      try {
        return {
          ok: true,
          forecasts: await listForecasts({
            orgId: context.authz.user.orgId,
            projectId: input.projectId,
            taskId: input.taskId,
            allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          }),
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "suggest_project_forecasts",
    title: "Suggest Project Forecasts",
    description:
      "Calculate estimate-to-complete suggestions for each WBS task as of a date. Find the project with list_records and verify task ids with list_project_work_breakdown.",
    inputSchema: z.object({ projectId: UUID, asOf: DATE }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: projectReader,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.read");
      await requireProjectFeatures(context, "projectProgress");
      try {
        const suggestions = await suggestForecasts({
          orgId: context.authz.user.orgId,
          projectId: input.projectId,
          asOf: input.asOf,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        if (!suggestions) throw notFound("project");
        return { ok: true, suggestions, href: `/projects/${input.projectId}` };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "record_project_forecast",
    title: "Record Project Forecast",
    description:
      "Record a manual estimate or accept a server-recomputed forecast method for a task and date. Find task ids with list_project_work_breakdown and verify with list_project_forecasts.",
    inputSchema: z.object({
      projectId: UUID,
      taskId: UUID,
      asOfDate: DATE,
      method: z
        .enum(["manual", "remaining_budget", "units_productivity", "cost_performance"])
        .describe("Manual estimate or supported calculation method."),
      costToComplete: z
        .string()
        .max(40)
        .nullable()
        .optional()
        .describe("Exact decimal remaining cost for a manual forecast."),
      hoursToComplete: z
        .string()
        .max(40)
        .nullable()
        .optional()
        .describe("Exact decimal remaining hours for a manual forecast."),
      note: z.string().max(500).nullable().optional().describe("Optional forecast note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context, "projectProgress");
      try {
        const forecast = await recordForecast({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          projectId: input.projectId,
          taskId: input.taskId,
          asOfDate: input.asOfDate,
          method: input.method,
          costToComplete: input.costToComplete ?? null,
          hoursToComplete: input.hoursToComplete ?? null,
          note: input.note ?? null,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          forecast,
          projectId: input.projectId,
          href: `/projects/${input.projectId}`,
        };
      } catch (error) {
        settleProjectWorkError(error);
      }
    },
  }),
  definition({
    name: "set_project_percent_complete",
    title: "Set Project Percent Complete",
    description:
      "Set or clear the project's cost-to-cost completion override; revenue contracts synchronize in the same transaction. Find the project with list_records and pass its current override as expectedPercentComplete, then verify with get_record.",
    inputSchema: z.object({
      projectId: UUID,
      percentComplete: z
        .number()
        .finite()
        .min(0)
        .max(100)
        .nullable()
        .describe(
          "Completion override from 0 through 100, or null to restore automatic cost-to-cost.",
        ),
      expectedPercentComplete: z
        .number()
        .finite()
        .min(0)
        .max(100)
        .nullable()
        .describe("Current override value from get_record; null means no stored override."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: projectManager,
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "projects.manage");
      await requireProjectFeatures(context);
      const result = await updateProjectPercentComplete({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        projectId: input.projectId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        percentComplete: input.percentComplete,
        expectedPercentComplete: input.expectedPercentComplete,
      });
      if (result.kind === "feature_disabled") throw notFound("project");
      if (result.kind === "not_found") throw notFound("project");
      if (result.kind === "revision_conflict") {
        throw conflict(
          "This override changed after you opened it; reload the project and reapply your value",
        );
      }
      return {
        ok: true,
        status: result.sync.synced[0] ?? null,
        problems: result.sync.skipped
          ? [...result.sync.problems, result.sync.skipped]
          : result.sync.problems,
        href: `/projects/${input.projectId}?tab=progress`,
      };
    },
  }),
];
