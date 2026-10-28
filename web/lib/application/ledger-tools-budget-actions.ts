import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { loadBudgetScenario } from "../budgets";
import { executeBudgetScenarioAction } from "../budget-scenario-actions";
import {
  budgetScenarioPatchSchema,
  deleteBudgetScenario,
  updateBudgetScenario,
} from "../budget-scenarios";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by the native budgets read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact budget action.");
async function runAction(
  context: ApplicationContext,
  input: {
    scenarioId: string;
    action: string;
    expectedRevision: number;
    idempotencyKey: string;
  } & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertApplicationPermission(context, "budgets.manage");
  assertApplicationPermission(context, "budgets.read");
  const { scenarioId, idempotencyKey: _key, ...body } = input;
  const response = await executeBudgetScenarioAction({
    request: new Request(`http://localhost/api/budgets/${scenarioId}/actions`),
    authz: context.authz,
    params: { id: scenarioId },
    body: { ...body, action: input.action },
  });
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed native response cannot be represented as a successful command result.
  }
  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.message === "string"
          ? payload.message
          : "Budget action refused.";
    const details = {
      ...(typeof payload.code === "string" ? { code: payload.code } : {}),
      ...(typeof payload.remedy === "string" ? { remedy: payload.remedy } : {}),
    };
    if (response.status === 403) throw new ApplicationError("forbidden", message, 403, details);
    if (response.status === 404) throw notFound("budget scenario");
    if (response.status === 409) throw conflict(message, details);
    if (response.status >= 500) throw new Error(message);
    throw new ApplicationError("invalid_input", message, response.status, details);
  }
  const resultId = typeof payload.id === "string" ? payload.id : scenarioId;
  const scenario = await loadBudgetScenario(
    resultId,
    context.authz.user.orgId,
    context.authz.allowedSubsidiaryIds,
  );
  if (!scenario) throw notFound("budget scenario");
  return {
    ok: true,
    scenarioId: resultId,
    ...(typeof payload.revision === "number" ? { revision: payload.revision } : {}),
    ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    scenario,
    href: `/budgets/${resultId}`,
  };
}

export const LEDGER_BUDGET_ACTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "update_budget_scenario",
    title: "Update Budget Scenario",
    description:
      "Edit draft budget metadata such as its name, description, type, book, or fiscal year. Find the scenario and current revision with get_budget_scenario; changing its book or year requires an empty draft.",
    inputSchema: budgetScenarioPatchSchema.extend({
      scenarioId: UUID.describe("Draft budget scenario id from get_budget_scenario."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage"),
    featureKey: "budgets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "budgets.manage");
      const { scenarioId, idempotencyKey: _key, ...changes } = input;
      try {
        const result = await updateBudgetScenario(context.authz, scenarioId, changes);
        return {
          ok: true,
          scenarioId,
          ...result,
          status: "updated",
          href: `/budgets/${scenarioId}`,
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "delete_budget_scenario",
    title: "Delete Budget Scenario",
    description:
      "Delete a draft budget scenario that is no longer needed. Find the scenario with get_budget_scenario; submitted, approved, or out-of-scope scenarios cannot be deleted.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Draft budget scenario id from get_budget_scenario."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage"),
    featureKey: "budgets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "budgets.manage");
      try {
        await deleteBudgetScenario(context.authz, input.scenarioId);
        return {
          ok: true,
          scenarioId: input.scenarioId,
          status: "deleted",
          href: "/budgets",
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "copy_budget_scenario",
    title: "Copy Budget Scenario",
    description:
      "Copy an existing budget or forecast into a draft scenario, optionally targeting another fiscal year. Find the scenario and current revision with get_budget_scenario; the source must have a complete period mapping in the target year.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Source budget scenario id from get_budget_scenario."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current scenario revision from get_budget_scenario."),
      fiscalYear: z
        .number()
        .int()
        .optional()
        .describe("Target fiscal year; omitted copies into the current year."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage") && can(authz, "budgets.read"),
    featureKey: "budgets",
    execute: async (context, input) => runAction(context, { ...input, action: "copy" }),
  }),
  definition({
    name: "copy_budget_prior_actuals",
    title: "Copy Prior Actuals to Budget",
    description:
      "Replace selected draft budget lines with posted prior fiscal year actuals mapped by period. Find the scenario revision with get_budget_scenario and provide any dimension filters explicitly; the target year must map every nonzero source period.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Draft budget scenario id from get_budget_scenario."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current scenario revision from get_budget_scenario."),
      subsidiaryId: UUID.nullable()
        .optional()
        .describe("Optional legal entity filter and target dimension."),
      departmentId: UUID.nullable()
        .optional()
        .describe("Optional department filter and target dimension."),
      projectId: UUID.nullable()
        .optional()
        .describe("Optional project filter and target dimension."),
      locationId: UUID.nullable()
        .optional()
        .describe("Optional location filter and target dimension."),
      classId: UUID.nullable().optional().describe("Optional class filter and target dimension."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage") && can(authz, "budgets.read"),
    featureKey: "budgets",
    execute: async (context, input) =>
      runAction(context, { ...input, action: "copy_prior_actuals" }),
  }),
  definition({
    name: "apply_budget_scenario_source",
    title: "Apply Budget Scenario Source",
    description:
      "Replace the visible lines in a draft budget scenario with lines from another scenario, mapped to the target fiscal year. Find both scenarios and revisions with get_budget_scenario; the source must be fully in scope and map every period.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Target draft scenario id from get_budget_scenario."),
      sourceScenarioId: UUID.describe("Source scenario id from get_budget_scenario."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current target revision from get_budget_scenario."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage") && can(authz, "budgets.read"),
    featureKey: "budgets",
    execute: async (context, input) => runAction(context, { ...input, action: "apply_source" }),
  }),
  definition({
    name: "archive_budget_scenario",
    title: "Archive Budget Scenario",
    description:
      "Archive a submitted, approved or draft scenario while retaining its history. Find the scenario and current revision with get_budget_scenario; archiving an approved scenario also requires budget-approval authority.",
    inputSchema: z.object({
      scenarioId: UUID.describe("Budget scenario id from get_budget_scenario."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current scenario revision from get_budget_scenario."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "budgets.manage") && can(authz, "budgets.read"),
    featureKey: "budgets",
    execute: async (context, input) => runAction(context, { ...input, action: "archive" }),
  }),
];
