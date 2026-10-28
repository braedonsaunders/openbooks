import "server-only";
import { z } from "zod";
import {
  NetInvestmentError,
  proposeNetInvestmentAssessment,
  proposeNetInvestmentReversal,
  applyNetInvestmentAssessment,
  applyNetInvestmentReversal,
} from "@openbooks/engine/consolidation";
import {
  LossOfControlProposalError,
  applyLossOfControl,
  applyLossOfControlReversal,
  proposeLossOfControl,
  proposeLossOfControlReversal,
} from "@openbooks/engine/consolidation/loss-of-control";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { submitFinancialChange } from "@openbooks/engine/flows/financial-changes-adapter";
import {
  FinancialChangeConflictError,
  FinancialChangeFeatureError,
} from "@openbooks/engine/platform/financial-changes";
import { sql } from "drizzle-orm";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  lossOfControlReversalSchema,
  lossOfControlSchema,
  lossOfControlToolSchema,
  netInvestmentAssessmentSchema,
  netInvestmentReversalSchema,
} from "../consolidation/action-schemas";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Financial change or ownership-interest id from a native read.");
const hasPermission = (permission: string) => (authz: ApplicationContext["authz"]) =>
  can(authz, permission);

function settleConsolidationRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof ScopeNotFoundError) throw notFound("consolidation change");
  if (error instanceof NetInvestmentError) throw invalidInput(error.message);
  if (error instanceof FinancialChangeConflictError) throw conflict(error.message);
  if (error instanceof FinancialChangeFeatureError) throw invalidInput(error.message);
  if (
    error instanceof Error &&
    error.message === "only the proposer can submit this accounting event"
  )
    throw forbidden(error.message);
  if (error instanceof Error) {
    const typed = error as Error & {
      status?: unknown;
      code?: unknown;
      details?: unknown;
      remedy?: unknown;
    };
    if (typeof typed.status === "number") {
      const domainDetails =
        typeof typed.details === "object" && typed.details !== null
          ? (typed.details as Record<string, unknown>)
          : undefined;
      const code =
        typed.status === 403
          ? "forbidden"
          : typed.status === 404
            ? "not_found"
            : typed.status === 409
              ? "conflict"
              : "invalid_input";
      const details = {
        ...(typeof typed.code === "string"
          ? { code: typed.code }
          : typeof domainDetails?.code === "string"
            ? { code: domainDetails.code }
            : {}),
        ...(typeof typed.remedy === "string"
          ? { remedy: typed.remedy }
          : typeof domainDetails?.remedy === "string"
            ? { remedy: domainDetails.remedy }
            : {}),
        ...(typed.details !== undefined ? { domainDetails: typed.details } : {}),
      };
      throw new ApplicationError(code, typed.message, typed.status, details);
    }
    if (error instanceof LossOfControlProposalError) {
      if (error.status === 403) throw forbidden(error.message);
      if (error.status === 404) throw notFound(error.message);
      if (error.status === 409) throw conflict(error.message);
      throw invalidInput(error.message);
    }
  }
  throw error;
}

async function withAuthorizedConsolidationChange<T>(
  context: ApplicationContext,
  changeId: string,
  operation: "net_investment_oci" | "loss_of_control" | "net_investment_oci_reversal" | "reversal",
  execute: () => Promise<T>,
): Promise<T> {
  assertApplicationPermission(context, "close.run");
  return withOrgTransaction(context.authz.user.orgId, async () => {
    const rows = await db.execute<{
      domain: string;
      operation: string;
      subsidiaryId: string | null;
      requiredSubsidiaryIds: string[] | null;
    }>(
      sql`
        select domain, operation, subsidiary_id as "subsidiaryId",
               payload->'requiredSubsidiaryIds' as "requiredSubsidiaryIds"
          from financial_changes
         where org_id = ${context.authz.user.orgId} and id = ${changeId}
         for update
      `,
      "objects",
    );
    const change = rows[0];
    if (!change || change.domain !== "consolidation" || change.operation !== operation) {
      throw notFound("consolidation change");
    }
    const required = change.requiredSubsidiaryIds ?? [];
    if (!Array.isArray(required) || typeof change.subsidiaryId !== "string") {
      throw notFound("consolidation change");
    }
    const allowed = context.authz.allowedSubsidiaryIds;
    if (
      allowed !== null &&
      [change.subsidiaryId, ...required].some((subsidiaryId) => !allowed.has(subsidiaryId))
    ) {
      throw notFound("consolidation change");
    }
    return execute();
  });
}

async function applyConsolidationChange(
  context: ApplicationContext,
  changeId: string,
  operation: "net_investment_oci" | "loss_of_control" | "net_investment_oci_reversal" | "reversal",
): Promise<Record<string, unknown>> {
  return withAuthorizedConsolidationChange(context, changeId, operation, async () => {
    if (operation === "net_investment_oci") {
      return applyNetInvestmentAssessment(
        context.authz.user.orgId,
        changeId,
        context.authz.user.id,
      );
    }
    if (operation === "loss_of_control") {
      return applyLossOfControl(context.authz.user.orgId, changeId, context.authz.user.id);
    }
    if (operation === "net_investment_oci_reversal") {
      return applyNetInvestmentReversal(context.authz.user.orgId, changeId, context.authz.user.id);
    }
    return applyLossOfControlReversal(context.authz.user.orgId, changeId, context.authz.user.id);
  });
}

async function submitConsolidationChange(
  context: ApplicationContext,
  changeId: string,
  operation: "net_investment_oci" | "loss_of_control" | "net_investment_oci_reversal" | "reversal",
): Promise<{ status: string }> {
  return withAuthorizedConsolidationChange(context, changeId, operation, async () => {
    await submitFinancialChange(context.authz.user.orgId, changeId, context.authz.user.id);
    const rows = await db.execute<{ status: string }>(
      sql`select status from financial_changes where org_id = ${context.authz.user.orgId} and id = ${changeId}`,
      "objects",
    );
    const status = rows[0]?.status;
    if (!status) throw notFound("consolidation change");
    return { status };
  });
}

export const LEDGER_CONSOLIDATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "submit_consolidation_change",
    title: "Submit Consolidation Change",
    description:
      "Send a net-investment or loss-of-control proposal through the configured approval flow. Use the change id returned by its propose command; only the proposer can submit it, and the change must remain in your entity scope.",
    inputSchema: z.object({
      changeId: UUID.describe("Financial change id returned by a consolidation proposal command."),
      operation: z
        .enum(["net_investment_oci", "loss_of_control", "reversal"])
        .describe(
          "Proposal operation: net-investment assessment, loss-of-control assessment, or loss-of-control reversal.",
        ),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{8,200}$/)
        .describe("Unique retry key for this submission."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiSubsidiary",
    execute: async (context, input) => {
      try {
        const result = await submitConsolidationChange(context, input.changeId, input.operation);
        return {
          ok: true,
          changeId: input.changeId,
          status: result.status,
          href: `/accounting/changes?change=${input.changeId}`,
        };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
  definition({
    name: "submit_net_investment_reversal",
    title: "Submit Net Investment Reversal",
    description:
      "Send an approved-workpaper correction to a net-investment assessment through the configured approval flow. Use the change id returned by reverse_net_investment_assessment; this correction remains available when multi-subsidiary accounting is disabled.",
    inputSchema: z.object({
      changeId: UUID.describe(
        "Net-investment reversal change id returned by the proposal command.",
      ),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{8,200}$/)
        .describe("Unique retry key for this submission."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => {
      try {
        const result = await submitConsolidationChange(
          context,
          input.changeId,
          "net_investment_oci_reversal",
        );
        return {
          ok: true,
          changeId: input.changeId,
          status: result.status,
          href: `/accounting/changes?change=${input.changeId}`,
        };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
  ...(
    [
      {
        name: "apply_net_investment_assessment",
        title: "Apply Net Investment Assessment",
        description:
          "Apply an independently approved net-investment assessment and post its governed ledger effects. Use the change id returned by propose_net_investment_assessment; the proposal must have an approval decision and remain within your entity scope.",
        operation: "net_investment_oci",
        featureKey: "multiSubsidiary",
      },
      {
        name: "apply_loss_of_control_assessment",
        title: "Apply Loss of Control Assessment",
        description:
          "Apply an independently approved loss-of-control assessment and post its governed ledger effects. Use the change id returned by propose_loss_of_control_assessment; the proposal must have an approval decision and remain within your entity scope.",
        operation: "loss_of_control",
        featureKey: "multiSubsidiary",
      },
      {
        name: "apply_net_investment_reversal",
        title: "Apply Net Investment Reversal",
        description:
          "Apply an approved correction to a posted net-investment assessment. Use the reversal change id returned by reverse_net_investment_assessment; correcting posted history remains available when the creation feature is disabled.",
        operation: "net_investment_oci_reversal",
        featureKey: undefined,
      },
      {
        name: "apply_loss_of_control_reversal",
        title: "Apply Loss of Control Reversal",
        description:
          "Apply an independently approved reversal of a loss-of-control change. Use the reversal change id returned by reverse_loss_of_control_assessment; the change must remain within your entity scope.",
        operation: "reversal",
        featureKey: "multiSubsidiary",
      },
    ] as const
  ).map((tool) =>
    definition({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.object({
        changeId: UUID.describe("Approved consolidation change id from the proposal result."),
        idempotencyKey: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{8,200}$/)
          .describe("Unique retry key for this application."),
      }),
      readOnly: false,
      destructive: false,
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: hasPermission("close.run"),
      ...(tool.featureKey ? { featureKey: tool.featureKey } : {}),
      execute: async (context, input) => {
        try {
          const result = await applyConsolidationChange(context, input.changeId, tool.operation);
          return {
            ok: true,
            ...result,
            changeId: input.changeId,
            status: "applied",
            href: `/accounting/changes?change=${input.changeId}`,
          };
        } catch (error) {
          settleConsolidationRefusal(error);
        }
      },
    }),
  ),
  definition({
    name: "propose_net_investment_assessment",
    title: "Propose Net Investment Assessment",
    description:
      "Create an approval proposal that classifies an intercompany balance as part of a net investment. Use Setup reads for the ownership interest, pair, accounts and source journal line ids.",
    inputSchema: netInvestmentAssessmentSchema.extend({
      interestId: UUID.describe("Ownership-interest id being assessed."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiSubsidiary",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const { interestId, ...assessment } = input;
        const changeId = await proposeNetInvestmentAssessment(
          context.authz.user.orgId,
          interestId,
          context.authz.user.id,
          assessment,
        );
        return { ok: true, changeId, href: "/close" };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
  definition({
    name: "propose_loss_of_control_assessment",
    title: "Propose Loss of Control Assessment",
    description:
      "Create an approval proposal for a subsidiary disposal and retained interest. Use Setup reads for the ownership-interest and account ids, and provide exact decimal amounts and rates.",
    inputSchema: lossOfControlToolSchema.extend({
      interestId: UUID.describe("Ownership-interest id whose control is being assessed."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiSubsidiary",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const { interestId, ...assessmentInput } = input;
        const assessment = lossOfControlSchema.parse(assessmentInput);
        const changeId = await proposeLossOfControl(
          context.authz.user.orgId,
          interestId,
          context.authz.user.id,
          assessment,
        );
        return { ok: true, changeId, href: "/close" };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
  definition({
    name: "reverse_net_investment_assessment",
    title: "Reverse Net Investment Assessment",
    description:
      "Propose a governed correction to a posted net-investment assessment on or after its original date. Find the source change in the close change history and provide the correction date and reason.",
    inputSchema: netInvestmentReversalSchema.extend({
      changeId: UUID.describe("Source net-investment change id from close change history."),
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const { changeId, ...reversal } = input;
        const newChangeId = await proposeNetInvestmentReversal(
          context.authz.user.orgId,
          changeId,
          context.authz.user.id,
          reversal,
        );
        return { ok: true, changeId: newChangeId, href: "/close" };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
  definition({
    name: "reverse_loss_of_control_assessment",
    title: "Reverse Loss of Control Assessment",
    description:
      "Propose a governed reversal of a loss-of-control consolidation change with a reason. Find the source change id in close change history; the native service checks its domain and subsidiary scope.",
    inputSchema: lossOfControlReversalSchema.extend({
      changeId: UUID.describe("Source loss-of-control change id from close change history."),
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("close.run"),
    featureKey: "multiSubsidiary",
    execute: async (context, input) => {
      assertApplicationPermission(context, "close.run");
      try {
        const changeId = await proposeLossOfControlReversal(
          context.authz.user.orgId,
          input.changeId,
          context.authz.user.id,
          input.reason,
          input.idempotencyKey,
        );
        return { ok: true, changeId, href: "/close" };
      } catch (error) {
        settleConsolidationRefusal(error);
      }
    },
  }),
];
