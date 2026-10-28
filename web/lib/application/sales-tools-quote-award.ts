import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  awardQuote,
  previewQuoteAward,
  QuoteAwardError,
} from "@openbooks/engine/billing/quote-award";
import { AwardPlanError } from "@openbooks/engine/projects/award-plan";
import { ProjectCreateError } from "@openbooks/engine/projects/project-create";
import { BudgetBaselineError } from "@openbooks/engine/projects/budget-baselines";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { listRecordDrawerHref } from "../cross-module-drawer-links";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from the quote, project, project type, or project task read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const MONEY = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal currency amount as text, with at most four places.");
const visible = (authz: Parameters<typeof can>[0]) =>
  can(authz, "projects.manage") && can(authz, "estimates.read");

function assertQuoteAwardPermissions(
  context: Parameters<typeof assertApplicationPermission>[0],
): void {
  assertApplicationPermission(context, "projects.manage");
  assertApplicationPermission(context, "estimates.read");
}

function awardContext(context: Parameters<typeof assertApplicationPermission>[0]) {
  return {
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
  };
}

function settleAward(error: unknown): never {
  if (
    (error instanceof QuoteAwardError ||
      error instanceof ProjectCreateError ||
      error instanceof BudgetBaselineError) &&
    error.status === 404
  )
    throw notFound("quote or project");
  if (error instanceof AwardPlanError || error instanceof ProjectCreateError) {
    throw invalidInput(error.message, error.field ? { field: error.field } : undefined);
  }
  if (error instanceof QuoteAwardError) {
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    throw invalidInput(error.message);
  }
  throw error;
}

const awardInput = z.object({
  target: z
    .discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("new").describe("Create a project for this quote."),
          name: z
            .string()
            .max(300)
            .nullable()
            .optional()
            .describe("Project name, or null to use the quote's customer and number."),
          projectTypeId: UUID.nullable()
            .optional()
            .describe("Project type UUID, or null for the organization default."),
          startsOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional()
            .describe("Project start date in YYYY-MM-DD format."),
          contractValue: MONEY.nullable()
            .optional()
            .describe("Exact contract value, or null when determined from the project type."),
        })
        .strict()
        .describe("Options for creating a new project."),
      z
        .object({
          mode: z.literal("existing").describe("Add the quote budget to an existing project."),
          projectId: UUID,
        })
        .strict()
        .describe("Existing project target."),
    ])
    .describe("Choose a new or existing target project."),
  tasks: z
    .array(
      z
        .object({
          key: z
            .string()
            .min(1)
            .max(200)
            .describe("Stable key from preview_quote_award.plan.tasks."),
          code: z.string().max(80).nullable().optional().describe("Optional project task code."),
          name: z.string().max(300).describe("Project task name."),
          existingTaskId: UUID.nullable()
            .optional()
            .describe("Existing task UUID to reuse, or null for a new task."),
        })
        .strict()
        .describe("Task mapping for an awarded quote line."),
    )
    .max(2000)
    .optional()
    .describe("Project tasks to create or reuse."),
  mapping: z
    .array(
      z
        .object({
          lineId: UUID,
          taskKey: z.string().max(200).describe("Task key from the tasks array."),
        })
        .strict()
        .describe("Map one quote line to a task."),
    )
    .max(5000)
    .optional()
    .describe("Quote line to task mappings."),
  lineCosts: z
    .array(
      z
        .object({ lineId: UUID, cost: MONEY })
        .strict()
        .describe("Exact estimated cost for one quote line."),
    )
    .max(5000)
    .optional()
    .describe("Estimated cost by quote line."),
  productionQuantities: z
    .boolean()
    .optional()
    .describe("Create production quantity budgets when project progress is enabled."),
});

export const SALES_QUOTE_AWARD_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "preview_quote_award",
    title: "Preview Quote Award",
    description:
      "Preview how an issued quote will create project tasks, budget totals, and customer project links. Read the quote first; optionally provide an existing project id to plan the award there.",
    inputSchema: z.object({
      quoteId: UUID,
      projectId: UUID.nullable()
        .optional()
        .describe("Existing customer project UUID, or null to use the quote default."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "projects",
    visibleTo: visible,
    execute: async (context, input) => {
      assertQuoteAwardPermissions(context);
      if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("quote");
      try {
        const preview = await previewQuoteAward(awardContext(context), input.quoteId, {
          projectId: input.projectId,
        });
        return { ok: true, ...preview, href: listRecordDrawerHref("quote", input.quoteId) };
      } catch (error) {
        settleAward(error);
      }
    },
  }),
  definition({
    name: "award_quote_to_project",
    title: "Award Quote To Project",
    description:
      "Award an issued quote to a new or existing project, creating its task plan and financial baseline. Review the result of preview_quote_award first; get the quote id with get_record.",
    inputSchema: awardInput.extend({ quoteId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "projects",
    visibleTo: visible,
    execute: async (context, input) => {
      assertQuoteAwardPermissions(context);
      if (!(await isFeatureEnabled(context.authz.user.orgId, "orders"))) throw notFound("quote");
      try {
        const { quoteId, idempotencyKey: _key, ...body } = input;
        const result = await awardQuote(awardContext(context), quoteId, body);
        return { ok: true, ...result, href: `/projects?project=${result.projectId}` };
      } catch (error) {
        settleAward(error);
      }
    },
  }),
];
