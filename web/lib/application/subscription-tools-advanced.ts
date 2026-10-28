import "server-only";
import { z } from "zod";
import { advancedSubscriptionWorkspace } from "@openbooks/engine/billing/advanced-subscriptions";
import {
  getEntitlementSnapshot,
  listPlanVersionEntitlements,
  listSaasFeatures,
} from "@openbooks/engine/billing";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { ApplicationError } from "./errors";
import type { ApplicationContext } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";
import { readTool, mutationTool, UUID, DATE, IDEMPOTENCY_KEY } from "./subscription-tools-shared";
import { executeAdvancedSubscriptionAction } from "@/lib/subscriptions/advanced-actions";
import { executeEntitlementAction } from "@/lib/subscriptions/entitlement-actions";
import { executeRenewalAction } from "@/lib/subscriptions/renewal-actions";

async function responseValue(response: Response, href: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const payload = (await response.json()) as Record<string, unknown>;
    const message =
      typeof payload.error === "string" ? payload.error : "The subscription action was refused.";
    const details: Record<string, unknown> = {};
    for (const key of ["code", "remedy", "field"] as const) {
      if (payload[key] !== undefined) details[key] = payload[key];
    }
    const status = response.status;
    const code =
      status === 403
        ? "forbidden"
        : status === 404
          ? "not_found"
          : status === 409
            ? "conflict"
            : status < 500
              ? "invalid_input"
              : "internal_error";
    throw new ApplicationError(code, message, status, details);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return { ok: true, ...payload, status: payload.status ?? response.status, href };
}

const component = z
  .object({
    componentKey: z
      .string()
      .min(1)
      .max(100)
      .describe("Stable key for this component within its plan version."),
    name: z.string().min(1).max(200).describe("Component name shown on subscription invoices."),
    description: z.string().nullable().optional().describe("Optional component description."),
    quantity: z
      .string()
      .max(40)
      .optional()
      .describe("Exact decimal component quantity; defaults to one."),
    unitPrice: z
      .string()
      .max(40)
      .describe("Exact decimal unit price; send 0 for a free component."),
    incomeAccountId: UUID.nullable()
      .optional()
      .describe("Income account for component invoice lines."),
    itemId: UUID.nullable().optional().describe("Item for component invoice lines."),
    taxCodeId: UUID.nullable().optional().describe("Tax code for component invoice lines."),
    isOptional: z.boolean().optional().describe("Whether a customer may omit this component."),
  })
  .describe("A priced component in a subscription plan version.");

const createVersionInput = z
  .object({
    action: z.literal("createVersion").describe("Create a dated version of a subscription plan."),
    planId: UUID.describe("Plan id from list_subscription_plans."),
    effectiveFrom: DATE.describe("Date when this plan version starts applying."),
    components: z
      .array(component)
      .max(500)
      .optional()
      .describe("Version components; each supplied component needs an explicit price."),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional()
      .describe("Uppercase ISO currency; requires Multi-currency when supplied."),
    interval: z
      .enum(["weekly", "monthly", "quarterly", "annually"])
      .optional()
      .describe("Billing cadence for this version."),
    intervalCount: z
      .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
      .optional()
      .describe("Number of cadence units per billing period."),
    billingTiming: z
      .enum(["advance", "arrears"])
      .optional()
      .describe("Whether service is billed in advance or arrears."),
    changeSummary: z
      .string()
      .nullable()
      .optional()
      .describe("Audit summary for this plan version."),
    name: z.string().nullable().optional().describe("Optional version name."),
    description: z.string().nullable().optional().describe("Optional version description."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .describe("Create-version request.");

const amendInput = z
  .object({
    action: z.literal("amend").describe("Amend a subscription's commercial terms."),
    subscriptionId: UUID.describe("Subscription id from get_subscription."),
    type: z
      .enum([
        "add_component",
        "remove_component",
        "change_component",
        "change_term",
        "change_timing",
        "renew",
        "coterm",
        "change_plan",
      ])
      .describe("Amendment type; use renew to extend a term."),
    planVersionId: UUID.nullable()
      .optional()
      .describe("Plan version id from get_advanced_subscription_workspace when changing plan."),
    effectiveOn: DATE.describe("Date the amendment takes effect."),
    quantity: z
      .string()
      .nullable()
      .optional()
      .describe("Exact decimal quantity for the changed component."),
    unitPrice: z
      .string()
      .nullable()
      .optional()
      .describe("Exact decimal unit price for the changed component."),
    renewalTermMonths: z
      .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
      .nullable()
      .optional()
      .describe("Renewal term length in months."),
    reason: z.string().nullable().optional().describe("Reason recorded with the amendment."),
    componentKey: z.string().nullable().optional().describe("Existing or new component key."),
    name: z.string().nullable().optional().describe("New component name when adding a component."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("Component description when changing a component."),
    incomeAccountId: UUID.nullable().optional().describe("Income account for the component."),
    itemId: UUID.nullable().optional().describe("Item for the component."),
    taxCodeId: UUID.nullable().optional().describe("Tax code for the component."),
    termEndsOn: DATE.nullable().optional().describe("New subscription term end date."),
    billingTiming: z
      .enum(["advance", "arrears"])
      .nullable()
      .optional()
      .describe("Billing timing for a term or plan change."),
    anchorSubscriptionId: UUID.nullable()
      .optional()
      .describe("Subscription id used to align a coterm date."),
    idempotencyKey: IDEMPOTENCY_KEY,
  })
  .describe("Subscription amendment request.");

const publishVersionInput = z.object({
  action: z.literal("publishVersion").describe("Publish a drafted subscription plan version."),
  versionId: UUID.describe("Plan version id from get_advanced_subscription_workspace."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const activateLifecycleInput = z.object({
  action: z
    .literal("activateLifecycle")
    .describe("Activate advanced lifecycle tracking on a subscription."),
  subscriptionId: UUID.describe("Subscription id from get_subscription."),
  planVersionId: UUID.describe(
    "Published plan version id from get_advanced_subscription_workspace.",
  ),
  termStartsOn: DATE.describe("Subscription term start."),
  termEndsOn: DATE.nullable()
    .optional()
    .describe("Subscription term end, or null for an open term."),
  trialEndsOn: DATE.nullable().optional().describe("Trial end date, when applicable."),
  renewalPolicy: z
    .enum(["auto", "manual", "none"])
    .optional()
    .describe("Renewal policy for this term."),
  renewalTermMonths: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
    .nullable()
    .optional()
    .describe("Default renewal term length in months."),
  billFromUnbilledBoundary: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether billing may begin at the unbilled service boundary."),
  idempotencyKey: IDEMPOTENCY_KEY,
});

const entitlementRow = z
  .object({
    featureKey: z.string().min(1).max(100).describe("SaaS capability key from list_saas_features."),
    enabled: z.boolean().nullable().optional().describe("Whether this capability is enabled."),
    limit: z
      .string()
      .nullable()
      .optional()
      .describe("Exact decimal usage limit, or null for no limit."),
    customValue: z.string().nullable().optional().describe("Custom entitlement value."),
    overagePolicy: z
      .enum(["block", "allow_and_bill", "alert"])
      .nullable()
      .optional()
      .describe("Action when usage exceeds its limit."),
    meterKey: z
      .string()
      .nullable()
      .optional()
      .describe("Usage meter key for a metered entitlement."),
  })
  .describe("One effective-dated plan entitlement.");
const entitlementInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("saveVersionEntitlements").describe("Set plan-version entitlements."),
    planVersionId: UUID.describe("Plan version id from get_advanced_subscription_workspace."),
    effectiveFrom: DATE.nullable().optional().describe("Date these entitlement values begin."),
    rows: z
      .array(entitlementRow)
      .min(1)
      .max(500)
      .describe("Complete set of entitlement values to save."),
    idempotencyKey: IDEMPOTENCY_KEY,
  }),
  z.object({
    action: z.literal("saveOverride").describe("Set a subscription-specific entitlement override."),
    subscriptionId: UUID.describe("Subscription id from get_subscription."),
    featureKey: z.string().min(1).max(100).describe("Capability key from list_saas_features."),
    enabled: z
      .boolean()
      .nullable()
      .optional()
      .describe("Override whether the capability is enabled."),
    limit: z
      .string()
      .nullable()
      .optional()
      .describe("Exact decimal usage limit, or null for no limit."),
    customValue: z.string().nullable().optional().describe("Custom entitlement value."),
    overagePolicy: z
      .enum(["block", "allow_and_bill", "alert"])
      .nullable()
      .optional()
      .describe("Action when usage exceeds its limit."),
    reason: z.string().min(1).max(1000).describe("Audit reason for the override."),
    effectiveFrom: DATE.nullable().optional().describe("Override start date."),
    effectiveTo: DATE.nullable().optional().describe("Override end date."),
    idempotencyKey: IDEMPOTENCY_KEY,
  }),
  z.object({
    action: z
      .literal("expireOverride")
      .describe("End an existing subscription entitlement override."),
    subscriptionId: UUID.describe("Subscription id from get_subscription."),
    featureKey: z.string().min(1).max(100).describe("Capability key from list_saas_features."),
    effectiveTo: DATE.nullable().optional().describe("Date the override ends."),
    idempotencyKey: IDEMPOTENCY_KEY,
  }),
]);

const renewalGenerateInput = z.object({
  action: z
    .literal("generate")
    .describe("Generate a renewal document for an eligible subscription."),
  subscriptionId: UUID.describe("Subscription id from get_subscription."),
  asOf: z
    .string()
    .max(10)
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isIsoCalendarDate)
    .describe("Valid calendar date used to evaluate renewal eligibility."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const renewalAcceptInput = z.object({
  action: z
    .literal("accept")
    .describe("Accept the commercial terms on a generated renewal document."),
  documentId: UUID.describe("Renewal document id from list_records or get_record."),
  reason: z
    .string()
    .trim()
    .min(8)
    .max(2000)
    .describe("Commercial acceptance reason recorded with the renewal."),
  idempotencyKey: IDEMPOTENCY_KEY,
});

function actionTool<T extends z.ZodType>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  href: string;
  destructive?: boolean;
  execute: (authz: ApplicationContext["authz"], input: z.infer<T>) => Promise<Response>;
}): ApplicationToolDefinition {
  return mutationTool({
    name: args.name,
    title: args.title,
    description: args.description,
    permission: "ar.create",
    featureKey: "advancedSubscriptions",
    inputSchema: args.inputSchema,
    destructive: args.destructive,
    execute: async (context, input) =>
      responseValue(await args.execute(context.authz, input), args.href),
  });
}

export const SUBSCRIPTION_ADVANCED_TOOLS: ApplicationToolDefinition[] = [
  readTool({
    name: "get_advanced_subscription_workspace",
    title: "Get Advanced Subscription Workspace",
    description:
      "Read lifecycle terms, versions and renewal state before changing an advanced subscription. Use get_subscription for the base billing record and this command for advanced plan-version ids.",
    permission: "ar.read",
    featureKey: "advancedSubscriptions",
    inputSchema: z
      .object({})
      .describe("No filters; returns the caller's visible advanced subscription workspace."),
    execute: async (context) => ({
      ok: true,
      ...(await advancedSubscriptionWorkspace(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      )),
      href: "/collections",
    }),
  }),
  readTool({
    name: "list_saas_features",
    title: "List SaaS Features",
    description:
      "List available SaaS capability keys before configuring plan entitlements or overrides. Feature ids are not subscription ids.",
    permission: "ar.read",
    featureKey: "advancedSubscriptions",
    inputSchema: z.object({
      activeOnly: z
        .boolean()
        .optional()
        .describe("Only list capabilities currently active in the organization."),
    }),
    execute: async (context, input) => ({
      ok: true,
      features: await listSaasFeatures(context.authz.user.orgId, input.activeOnly ?? false),
      href: "/collections",
    }),
  }),
  readTool({
    name: "list_plan_version_entitlements",
    title: "List Plan Version Entitlements",
    description:
      "Read effective-dated capabilities for a subscription plan version before saving its entitlement set. Find plan version ids with get_advanced_subscription_workspace.",
    permission: "ar.read",
    featureKey: "advancedSubscriptions",
    inputSchema: z.object({
      planVersionId: UUID.describe("Plan version id from get_advanced_subscription_workspace."),
      at: DATE.optional().describe("Optional date for effective entitlement resolution."),
    }),
    execute: async (context, input) => {
      if (context.authz.allowedSubsidiaryIds !== null)
        throw new ApplicationError("forbidden", "forbidden", 403, {
          permission: "subsidiary.unrestricted",
        });
      return {
        ok: true,
        entitlements: await listPlanVersionEntitlements(
          context.authz.user.orgId,
          input.planVersionId,
          input.at,
        ),
        href: "/collections",
      };
    },
  }),
  readTool({
    name: "get_subscription_entitlement_snapshot",
    title: "Get Subscription Entitlement Snapshot",
    description:
      "Read the resolved plan grants and subscription overrides at a date before editing a subscription entitlement. Find the subscription id with get_subscription.",
    permission: "ar.read",
    featureKey: "advancedSubscriptions",
    inputSchema: z.object({
      subscriptionId: UUID.describe("Subscription id from get_subscription."),
      at: DATE.optional().describe("Optional effective date for the snapshot."),
    }),
    execute: async (context, input) => ({
      ok: true,
      snapshot: await getEntitlementSnapshot(context.authz.user.orgId, input.subscriptionId, {
        at: input.at,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      }),
      href: `/collections?subscription=${input.subscriptionId}`,
    }),
  }),
  actionTool({
    name: "create_subscription_plan_version",
    title: "Create Subscription Plan Version",
    description:
      "Create a dated plan version with exact component prices. Find the plan id with list_subscription_plans; the version starts as a draft.",
    inputSchema: createVersionInput,
    href: "/collections",
    execute: (authz, input) => executeAdvancedSubscriptionAction(authz, input),
  }),
  actionTool({
    name: "publish_subscription_plan_version",
    title: "Publish Subscription Plan Version",
    description:
      "Publish a drafted plan version so it can govern subscription terms. Find the version id with get_advanced_subscription_workspace.",
    inputSchema: publishVersionInput,
    href: "/collections",
    execute: (authz, input) => executeAdvancedSubscriptionAction(authz, input),
  }),
  actionTool({
    name: "activate_subscription_lifecycle",
    title: "Activate Subscription Lifecycle",
    description:
      "Attach a published plan version and term dates to an existing subscription. Find subscription ids with get_subscription and version ids with get_advanced_subscription_workspace.",
    inputSchema: activateLifecycleInput,
    href: "/collections",
    execute: (authz, input) => executeAdvancedSubscriptionAction(authz, input),
  }),
  actionTool({
    name: "amend_subscription",
    title: "Amend Subscription",
    description:
      "Apply an effective-dated component, term, timing, renewal, coterm or plan amendment under the subscription lifecycle rules. Find the subscription and plan-version ids with get_subscription and get_advanced_subscription_workspace.",
    inputSchema: amendInput,
    href: "/collections",
    execute: (authz, input) =>
      executeAdvancedSubscriptionAction(authz, input as z.infer<typeof POSTBodySchema1>),
  }),
  actionTool({
    name: "save_plan_version_entitlements",
    title: "Save Plan Version Entitlements",
    description:
      "Save the effective-dated entitlement set for a plan version. Find the version id with get_advanced_subscription_workspace and capability keys with list_saas_features.",
    inputSchema: entitlementInput.options[0],
    href: "/collections",
    execute: (authz, input) => executeEntitlementAction(authz, input),
  }),
  actionTool({
    name: "save_subscription_entitlement_override",
    title: "Save Subscription Entitlement Override",
    description:
      "Set a dated capability override for one subscription with a required audit reason. Find the subscription id with get_subscription and capability keys with list_saas_features.",
    inputSchema: entitlementInput.options[1],
    href: "/collections",
    execute: (authz, input) => executeEntitlementAction(authz, input),
  }),
  actionTool({
    name: "expire_subscription_entitlement_override",
    title: "Expire Subscription Entitlement Override",
    description:
      "End the current capability override for a subscription. Find the subscription id with get_subscription and review current grants with get_subscription_entitlement_snapshot.",
    inputSchema: entitlementInput.options[2],
    href: "/collections",
    destructive: true,
    execute: (authz, input) => executeEntitlementAction(authz, input),
  }),
  actionTool({
    name: "generate_subscription_renewal",
    title: "Generate Subscription Renewal",
    description:
      "Generate a renewal order or quote when an active advanced subscription is eligible under its dated renewal policy. Find subscription ids and term ends with get_advanced_subscription_workspace.",
    inputSchema: renewalGenerateInput,
    href: "/collections",
    execute: (authz, input) => executeRenewalAction(authz, input),
  }),
  actionTool({
    name: "accept_subscription_renewal",
    title: "Accept Subscription Renewal",
    description:
      "Accept the commercial terms on a generated renewal document after review. Find the document id with list_records or get_record.",
    inputSchema: renewalAcceptInput,
    href: "/collections",
    execute: (authz, input) => executeRenewalAction(authz, input),
  }),
];
