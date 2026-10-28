import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isValidEmailAddress } from "@openbooks/emails";
import { runDunningForOrg } from "@openbooks/engine/receivables/dunning";
import {
  AutopayError,
  parseExpiryNoticeDays,
  parseFinalAction,
  parseRetryOffsetsDays,
} from "@openbooks/engine/payments/autopay";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { can } from "../authz";
import { canonicalDecimal, compareDecimal } from "../exact-decimal";
import { invalidInput, forbidden, notFound } from "./errors";
import {
  createDunningPolicyRecord,
  deleteDunningPolicyRecord,
  listDunningPolicies as readDunningPolicies,
  updateDunningPolicyRecord,
  DunningPolicyEditConflict,
  DunningPolicyStagesRefusal,
} from "../dunning-policy-management";
import { type ApplicationContext } from "./context";
import {
  assertTreasuryGate,
  DATE,
  IDEMPOTENCY_KEY,
  MONEY,
  runOutsideTenantTransaction,
  settleDomainRefusal,
  UUID,
} from "./treasury-tools-common";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { z } from "zod";

function assertDunningSetup(context: ApplicationContext) {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

const dunningStagesSchema = z
  .array(
    z.object({
      id: UUID.optional().describe("Existing reminder stage UUID when retaining an edited stage."),
      sequence: z.number().int().min(-2147483648).max(2147483647).describe("Unique ladder order."),
      name: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => !!value.trim())
        .describe("Operator-visible reminder stage name."),
      offsetDays: z
        .number()
        .int()
        .min(-2147483648)
        .max(2147483647)
        .describe("Days from due date; negative values send pre-due reminders."),
      subjectTemplate: z
        .string()
        .min(1)
        .max(998)
        .refine((value) => !!value.trim())
        .describe("Nonempty email subject template."),
      bodyTemplate: z
        .string()
        .min(1)
        .max(10000)
        .refine((value) => !!value.trim())
        .describe("Nonempty email body template."),
      escalate: z
        .boolean()
        .optional()
        .describe("Whether this stage flags the account for escalation."),
    }),
  )
  .max(100)
  .superRefine((stages, ctx) => {
    if (new Set(stages.map((stage) => stage.sequence)).size !== stages.length) {
      ctx.addIssue({ code: "custom", message: "reminder stage sequences must be unique" });
    }
  })
  .describe("Ordered reminder ladder; replacing it keeps existing stage identities by sequence.");

const retryOffsetsSchema = z
  .array(z.number().int().min(1).max(90).describe("Whole days after a failed collection."))
  .max(8)
  .optional()
  .describe(
    "Optional retry schedule. Supplying it also requires autopay.manage and the autopay feature.",
  );

const policyFields = {
  name: z.string().trim().min(1).max(200).optional().describe("Operator-readable policy name."),
  appliesToKind: z
    .enum(["customer_invoice"])
    .optional()
    .describe("Receivable document kind this policy applies to."),
  gracePeriodDays: z
    .number()
    .int()
    .min(0)
    .max(2147483647)
    .optional()
    .describe("Non-negative whole days after the due date."),
  minBalance: MONEY.optional().describe(
    "Minimum balance eligible for reminders as an exact decimal string.",
  ),
  replyTo: z
    .string()
    .max(320)
    .refine(isValidEmailAddress)
    .nullable()
    .optional()
    .describe("Optional reply-to email address."),
  isActive: z.boolean().optional().describe("Whether this policy participates in dunning runs."),
  stages: dunningStagesSchema.optional(),
  retryOffsetsDays: retryOffsetsSchema,
  insufficientFundsOffsetsDays: retryOffsetsSchema.describe(
    "Optional insufficient-funds retry schedule; also requires autopay.manage and the autopay feature.",
  ),
  expiryNoticeDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .nullable()
    .optional()
    .describe(
      "Days before card expiry to notify; setting requires autopay.manage and the autopay feature.",
    ),
  finalAction: z
    .enum(["none", "suspend", "cancel"])
    .nullable()
    .optional()
    .describe(
      "Action after autopay retries end; setting requires autopay.manage and the autopay feature.",
    ),
};

const createDunningStagesSchema = z
  .array(
    z.object({
      sequence: z.number().int().min(-2147483648).max(2147483647).describe("Unique ladder order."),
      name: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => !!value.trim())
        .describe("Operator-visible reminder stage name."),
      offsetDays: z
        .number()
        .int()
        .min(-2147483648)
        .max(2147483647)
        .describe("Days from due date; negative values send pre-due reminders."),
      subjectTemplate: z
        .string()
        .min(1)
        .max(998)
        .refine((value) => !!value.trim())
        .describe("Nonempty email subject template."),
      bodyTemplate: z
        .string()
        .min(1)
        .max(10000)
        .refine((value) => !!value.trim())
        .describe("Nonempty email body template."),
      escalate: z
        .boolean()
        .optional()
        .describe("Whether this stage flags the account for escalation."),
    }),
  )
  .max(100)
  .superRefine((stages, ctx) => {
    if (new Set(stages.map((stage) => stage.sequence)).size !== stages.length) {
      ctx.addIssue({ code: "custom", message: "reminder stage sequences must be unique" });
    }
  })
  .describe("Ordered reminder ladder for new policies.");

const policyHref = "/admin/setup?tab=collections";

function settleDunningPolicy(error: unknown): never {
  if (error instanceof AutopayError) throw invalidInput(error.message);
  if (error instanceof DunningPolicyEditConflict || error instanceof DunningPolicyStagesRefusal) {
    settleDomainRefusal({ message: error.message, status: error.status });
  }
  settleDomainRefusal(error);
}

function validatePolicyMoney(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const exact = canonicalDecimal(value, 4);
  if (exact === null || compareDecimal(exact, "0") < 0) {
    throw invalidInput("minBalance must be a non-negative amount");
  }
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw invalidInput("minBalance must be a non-negative amount");
  }
  return normalizeMoney(exact);
}

function normalizeAutopayPolicyFields(input: Record<string, unknown>) {
  const hasAutopaySettings = [
    "retryOffsetsDays",
    "insufficientFundsOffsetsDays",
    "expiryNoticeDays",
    "finalAction",
  ].some((field) => input[field] !== undefined);
  if (!hasAutopaySettings) return {};
  try {
    return {
      ...(input.retryOffsetsDays !== undefined
        ? { retryOffsetsDays: parseRetryOffsetsDays(input.retryOffsetsDays) }
        : {}),
      ...(input.insufficientFundsOffsetsDays !== undefined
        ? {
            insufficientFundsOffsetsDays: parseRetryOffsetsDays(input.insufficientFundsOffsetsDays),
          }
        : {}),
      ...(input.expiryNoticeDays !== undefined && input.expiryNoticeDays !== null
        ? { expiryNoticeDays: parseExpiryNoticeDays(input.expiryNoticeDays) }
        : {}),
      ...(input.finalAction !== undefined && input.finalAction !== null
        ? { finalAction: parseFinalAction(input.finalAction) }
        : {}),
    };
  } catch (error) {
    if (error instanceof AutopayError) throw invalidInput(error.message);
    throw error;
  }
}

async function requireDunningPolicy(context: ApplicationContext, id: string): Promise<void> {
  const found = await db.execute<{ id: string }>(
    sql`select id from dunning_policies where id = ${id} and org_id = ${context.authz.user.orgId}`,
    "objects",
  );
  if (!found[0]) throw notFound("record");
}

export const TREASURY_DUNNING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_dunning_policies",
    title: "List Dunning Policies",
    description:
      "Read organization-wide reminder ladders, eligibility thresholds, and autopay retry settings before a collection run or policy change. This configuration read requires unrestricted documents.manage access.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "documents.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context) => {
      await assertTreasuryGate(context, "documents.manage");
      assertDunningSetup(context);
      return {
        policies: await readDunningPolicies(context.authz.user.orgId),
        href: policyHref,
      };
    },
  }),
  definition({
    name: "create_dunning_policy",
    title: "Create Dunning Policy",
    description:
      "Create an organization-wide reminder policy with an ordered email ladder; active policies need at least one stage. Use list_dunning_policies to inspect stages and find policy IDs for later edits.",
    inputSchema: z.object({
      ...policyFields,
      name: z.string().trim().min(1).max(200).describe("Operator-readable policy name."),
      stages: createDunningStagesSchema.optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "documents.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "documents.manage");
      assertDunningSetup(context);
      const stages = input.stages ?? [];
      const isActive = input.isActive ?? true;
      if (isActive && stages.length === 0) {
        throw invalidInput(
          "cannot activate a policy with no stages — add at least one stage or create it inactive",
        );
      }
      const minBalance = validatePolicyMoney(input.minBalance ?? "0")!;
      if (
        input.retryOffsetsDays !== undefined ||
        input.insufficientFundsOffsetsDays !== undefined ||
        input.expiryNoticeDays !== undefined ||
        input.finalAction !== undefined
      ) {
        await assertTreasuryGate(context, "autopay.manage", "autopay");
      }
      const autopay = normalizeAutopayPolicyFields(input);
      try {
        const id = await createDunningPolicyRecord({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          requestId: null,
          input: {
            name: input.name,
            appliesToKind: input.appliesToKind ?? "customer_invoice",
            gracePeriodDays: input.gracePeriodDays ?? 0,
            minBalance,
            replyTo: input.replyTo ?? null,
            isActive,
            stages,
            ...autopay,
          },
        });
        const policy = (await readDunningPolicies(context.authz.user.orgId)).find(
          (item) => item.id === id,
        );
        if (!policy) throw notFound("record");
        return {
          ok: true,
          id,
          policy,
          status: policy.isActive ? "active" : "inactive",
          href: policyHref,
        };
      } catch (error) {
        settleDunningPolicy(error);
      }
    },
  }),
  definition({
    name: "update_dunning_policy",
    title: "Update Dunning Policy",
    description:
      "Edit an existing reminder policy, including its stages and eligibility rules; use list_dunning_policies for the policy ID and expected updatedAt revision. Changing autopay retry fields also requires autopay.manage with the autopay feature enabled.",
    inputSchema: z
      .object({
        policyId: UUID.describe("Policy UUID from list_dunning_policies."),
        expectedUpdatedAt: z
          .string()
          .max(64)
          .regex(/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/)
          .optional()
          .describe(
            "Revision timestamp from list_dunning_policies to prevent overwriting a newer edit.",
          ),
        ...policyFields,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.name !== undefined ||
          input.appliesToKind !== undefined ||
          input.gracePeriodDays !== undefined ||
          input.isActive !== undefined ||
          input.minBalance !== undefined ||
          input.replyTo !== undefined ||
          input.stages !== undefined ||
          input.retryOffsetsDays !== undefined ||
          input.insufficientFundsOffsetsDays !== undefined ||
          input.expiryNoticeDays !== undefined ||
          input.finalAction !== undefined,
        { message: "At least one field must be provided." },
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "documents.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "documents.manage");
      assertDunningSetup(context);
      await requireDunningPolicy(context, input.policyId);
      const minBalance = validatePolicyMoney(input.minBalance);
      if (
        input.retryOffsetsDays !== undefined ||
        input.insufficientFundsOffsetsDays !== undefined ||
        input.expiryNoticeDays !== undefined ||
        input.finalAction !== undefined
      ) {
        await assertTreasuryGate(context, "autopay.manage", "autopay");
      }
      const autopay = normalizeAutopayPolicyFields(input);
      try {
        await updateDunningPolicyRecord({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          policyId: input.policyId,
          input: {
            ...(input.expectedUpdatedAt !== undefined
              ? { expectedUpdatedAt: input.expectedUpdatedAt }
              : {}),
            ...(input.appliesToKind !== undefined ? { appliesToKind: input.appliesToKind } : {}),
            ...(input.gracePeriodDays !== undefined
              ? { gracePeriodDays: input.gracePeriodDays }
              : {}),
            ...(minBalance !== undefined ? { minBalance } : {}),
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
            ...(input.stages !== undefined ? { stages: input.stages } : {}),
            ...autopay,
          },
        });
        const policy = (await readDunningPolicies(context.authz.user.orgId)).find(
          (item) => item.id === input.policyId,
        );
        if (!policy) throw notFound("record");
        return {
          ok: true,
          id: input.policyId,
          policy,
          status: policy.isActive ? "active" : "inactive",
          href: policyHref,
        };
      } catch (error) {
        settleDunningPolicy(error);
      }
    },
  }),
  definition({
    name: "delete_dunning_policy",
    title: "Delete Dunning Policy",
    description:
      "Delete a reminder policy and its stages after verifying it is no longer needed for future collection runs. Use list_dunning_policies to find the policy ID; deletion is audited and destructive.",
    inputSchema: z.object({
      policyId: UUID.describe("Policy UUID from list_dunning_policies."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "documents.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "documents.manage");
      assertDunningSetup(context);
      try {
        const deleted = await deleteDunningPolicyRecord({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          policyId: input.policyId,
        });
        if (!deleted) throw notFound("record");
        return { ok: true, id: input.policyId, status: "deleted", href: policyHref };
      } catch (error) {
        settleDunningPolicy(error);
      }
    },
  }),
  definition({
    name: "run_dunning",
    title: "Run Dunning",
    description:
      "Run overdue customer invoice reminders for this organization using its active dunning policies and current business date. Review list_dunning_policies and the collections worklist first; this queues customer communications.",
    inputSchema: z.object({
      asOf: DATE.optional().describe("Optional controlled business date for the dunning run."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "documents.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      await assertTreasuryGate(context, "documents.manage");
      assertDunningSetup(context);
      try {
        const result = await runOutsideTenantTransaction(context, () =>
          runDunningForOrg(context.authz.user.orgId, input.asOf),
        );
        return {
          ok: result.orgErrors.length === 0,
          ...result,
          status: "completed",
          href: "/collections",
        };
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  }),
];
