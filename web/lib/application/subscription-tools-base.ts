import "server-only";
import { z } from "zod";
import { SubscriptionActionBody, executeSubscriptionAction } from "@/lib/subscriptions/actions";
import { ApplicationError } from "./errors";
import { DATE, IDEMPOTENCY_KEY, mutationTool, UUID } from "./subscription-tools-shared";
import type { ApplicationContext } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";

function routeResponseError(response: Response, body: Record<string, unknown>): never {
  const message = typeof body.error === "string" ? body.error : "Subscription action was refused.";
  const details: Record<string, unknown> = {};
  for (const key of ["code", "remedy", "field", "periods", "truncated"] as const) {
    if (body[key] !== undefined) details[key] = body[key];
  }
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, details);
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, details);
  if (response.status === 409) throw new ApplicationError("conflict", message, 409, details);
  if (response.status === 400 || response.status === 422)
    throw new ApplicationError("invalid_input", message, response.status, details);
  throw new ApplicationError("internal_error", message, response.status, details);
}

async function invokeSubscriptionAction(
  context: ApplicationContext,
  body: z.infer<typeof SubscriptionActionBody>,
  href: string,
): Promise<Record<string, unknown>> {
  const response = await executeSubscriptionAction(
    context.authz,
    SubscriptionActionBody.parse(body),
  );
  if (!response.ok) {
    const payload = (await response.json()) as Record<string, unknown>;
    routeResponseError(response, payload);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return { ok: true, ...payload, status: payload.status ?? response.status, href };
}

const catchUp = z
  .object({
    mode: z
      .enum(["post_all", "drafts", "skip", "selected"])
      .describe("How to handle past-due subscription periods."),
    dates: z
      .array(DATE)
      .max(120)
      .optional()
      .describe("Period dates selected when mode is selected."),
    post: z.boolean().optional().describe("Whether selected periods should post immediately."),
  })
  .describe("Explicit catch-up choice when multiple billing periods are already due.");
const exactSubscriptionDecimal = z
  .string()
  .max(40)
  .regex(/^-?\d{1,15}(?:\.\d{1,4})?$/)
  .describe("Exact decimal amount or quantity; never a JSON number.");

const createPlanInput = z.object({
  action: z.literal("addPlan").describe("Create a subscription plan."),
  name: z.string().trim().min(1).max(200).describe("Plan name shown to operators and customers."),
  description: z.string().max(2000).nullable().optional().describe("Optional plan description."),
  amount: exactSubscriptionDecimal
    .optional()
    .describe("Exact decimal plan price; never a JSON number."),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional()
    .describe("Optional uppercase ISO currency; requires Multi-currency."),
  interval: z
    .enum(["weekly", "monthly", "quarterly", "annually"])
    .describe("Plan billing cadence."),
  intervalCount: z
    .union([z.number().int(), z.string().regex(/^\d+$/)])
    .optional()
    .describe("Number of cadence units per billing period."),
  incomeAccountId: UUID.nullable()
    .optional()
    .describe("Optional income account for generated invoices."),
  itemId: UUID.nullable().optional().describe("Optional item billed by this plan."),
  taxCodeId: UUID.nullable().optional().describe("Optional tax code for generated invoices."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const updatePlanInput = z.object({
  action: z.literal("updatePlan").describe("Update an existing subscription plan."),
  id: UUID.describe("Plan id from list_subscription_plans."),
  name: z.string().trim().min(1).max(200).describe("Updated plan name."),
  description: z.string().max(2000).nullable().optional().describe("Updated plan description."),
  amount: exactSubscriptionDecimal
    .optional()
    .describe("Exact decimal plan price; never a JSON number."),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullable()
    .optional()
    .describe("Optional uppercase ISO currency; requires Multi-currency."),
  interval: z
    .enum(["weekly", "monthly", "quarterly", "annually"])
    .describe("Updated billing cadence."),
  intervalCount: z
    .union([z.number().int(), z.string().regex(/^\d+$/)])
    .optional()
    .describe("Number of cadence units per billing period."),
  incomeAccountId: UUID.nullable().optional().describe("Income account for generated invoices."),
  itemId: UUID.nullable().optional().describe("Item billed by this plan."),
  taxCodeId: UUID.nullable().optional().describe("Tax code for generated invoices."),
  isActive: z.boolean().optional().describe("Whether new subscriptions may use this plan."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const deletePlanInput = z.object({
  action: z.literal("deletePlan").describe("Delete a subscription plan."),
  planId: UUID.describe("Plan id from list_subscription_plans."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const createSubscriptionInput = z.object({
  action: z.literal("addSubscription").describe("Create a subscription for a customer."),
  customerId: UUID.describe("Customer party id."),
  planId: UUID.describe("Plan id from list_subscription_plans."),
  startOn: DATE.nullable()
    .optional()
    .describe("Service start date; defaults to the business date."),
  firstBillOn: DATE.nullable()
    .optional()
    .describe("First full billing date; defaults to the start date."),
  prorateFirstPeriod: z
    .boolean()
    .optional()
    .describe("Create a prorated first-period invoice when the first full bill is later."),
  autoPost: z.boolean().optional().describe("Post generated invoices automatically."),
  quantity: exactSubscriptionDecimal.optional().describe("Exact decimal subscription quantity."),
  priceOverride: z
    .string()
    .max(40)
    .regex(/^-?\d{1,15}(?:\.\d{1,4})?$/)
    .nullable()
    .optional()
    .describe("Optional exact decimal price override."),
  memo: z.string().max(2000).nullable().optional().describe("Optional subscription memo."),
  catchUp: catchUp.optional(),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const changeSubscriptionInput = z.object({
  action: z.literal("changeSubscription").describe("Change subscription quantity or price."),
  id: UUID.describe("Subscription id from list_subscriptions."),
  quantity: exactSubscriptionDecimal.optional().describe("New exact decimal quantity."),
  priceOverride: z
    .string()
    .max(40)
    .regex(/^-?\d{1,15}(?:\.\d{1,4})?$/)
    .nullable()
    .optional()
    .describe("New exact decimal price override, or null to use the plan price."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
const updateSubscriptionFields = {
  id: UUID.describe("Subscription id from list_subscriptions."),
  canceledOn: DATE.nullable()
    .optional()
    .describe("Cancellation effective date; only valid while canceling."),
  quantity: exactSubscriptionDecimal.optional().describe("Exact decimal quantity."),
  priceOverride: z
    .string()
    .max(40)
    .regex(/^-?\d{1,15}(?:\.\d{1,4})?$/)
    .nullable()
    .optional()
    .describe("Exact decimal price override, or null to restore plan price."),
  autoPost: z.boolean().optional().describe("Whether generated invoices post automatically."),
  nextBillOn: DATE.optional().describe(
    "New next billing date; skipped service needs explicit opt-in and reason.",
  ),
  skipUnbilledService: z
    .boolean()
    .optional()
    .describe("Explicitly allow a forward billing-date jump to skip unbilled service."),
  skipReason: z
    .string()
    .max(500)
    .optional()
    .describe("Audit reason for skipping unbilled service."),
  billToPartyId: UUID.nullable()
    .optional()
    .describe("Customer party override for invoice bill-to, or null to clear."),
  payerPartyId: UUID.nullable()
    .optional()
    .describe("Customer party override for payer, or null to clear."),
  catchUp: catchUp.optional(),
  idempotencyKey: IDEMPOTENCY_KEY,
};
const updateSubscriptionInput = z.object({
  action: z
    .literal("updateSubscription")
    .describe("Update billing and customer settings without changing lifecycle status."),
  ...updateSubscriptionFields,
});
const suspendSubscriptionInput = z.object({
  action: z.literal("updateSubscription").describe("Suspend a subscription."),
  ...updateSubscriptionFields,
});
const cancelSubscriptionInput = z.object({
  action: z.literal("updateSubscription").describe("Cancel a subscription."),
  ...updateSubscriptionFields,
});
const resumeSubscriptionInput = z.object({
  action: z.literal("updateSubscription").describe("Resume a suspended subscription."),
  ...updateSubscriptionFields,
});
const billNowInput = z.object({
  action: z.literal("billNow").describe("Generate a bill for the next subscription period."),
  id: UUID.describe("Subscription id from list_subscriptions."),
  idempotencyKey: IDEMPOTENCY_KEY,
});

function subscriptionBody<T extends { action: string; idempotencyKey: string }>(input: T) {
  const { idempotencyKey: _key, ...body } = input;
  return body as unknown as z.infer<typeof SubscriptionActionBody>;
}

export const SUBSCRIPTION_BASE_TOOLS: ApplicationToolDefinition[] = [
  mutationTool({
    name: "create_subscription_plan",
    title: "Create Subscription Plan",
    description:
      "Create a recurring billing plan before assigning it to a customer. Find existing plans with list_subscription_plans.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: createPlanInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(context, subscriptionBody(input), "/collections"),
  }),
  mutationTool({
    name: "update_subscription_plan",
    title: "Update Subscription Plan",
    description:
      "Change a plan's price, cadence, item, accounts or active status; existing subscriptions retain their recorded terms. Find the plan id with list_subscription_plans.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: updatePlanInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(context, subscriptionBody(input), "/collections"),
  }),
  mutationTool({
    name: "delete_subscription_plan",
    title: "Delete Subscription Plan",
    description:
      "Delete an unused subscription plan; the service refuses while any subscription references it. Find the plan id with list_subscription_plans.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    destructive: true,
    inputSchema: deletePlanInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody({ ...input, id: input.planId }),
        "/collections",
      ),
  }),
  mutationTool({
    name: "create_subscription",
    title: "Create Subscription",
    description:
      "Start recurring billing for a customer under a subscription plan; choose a catch-up mode if multiple periods are already due. Find customer ids with party reads, plans with list_subscription_plans and subscriptions with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: createSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(context, subscriptionBody(input), "/collections"),
  }),
  mutationTool({
    name: "change_subscription",
    title: "Change Subscription Quantity or Price",
    description:
      "Change a subscription's quantity or price override through its native amendment and billing rules. Find the subscription id with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: changeSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody(input),
        `/collections?subscription=${input.id}`,
      ),
  }),
  mutationTool({
    name: "update_subscription_billing",
    title: "Update Subscription Billing",
    description:
      "Update quantity, price, bill-to or payer, auto-posting, or next billing date while preserving the subscription's current lifecycle status. Find the subscription id with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: updateSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody(input),
        `/collections?subscription=${input.id}`,
      ),
  }),
  mutationTool({
    name: "suspend_subscription",
    title: "Suspend Subscription",
    description:
      "Pause recurring billing for an active subscription. Find the subscription id and current status with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: suspendSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody({ ...input, status: "paused" }),
        `/collections?subscription=${input.id}`,
      ),
  }),
  mutationTool({
    name: "resume_subscription",
    title: "Resume Subscription",
    description:
      "Resume a paused subscription; provide an explicit catch-up choice if multiple periods are already due. Find the subscription id with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: resumeSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody({ ...input, status: "active" }),
        `/collections?subscription=${input.id}`,
      ),
  }),
  mutationTool({
    name: "cancel_subscription",
    title: "Cancel Subscription",
    description:
      "Cancel recurring billing using the paid-through boundary; an arrears subscription cannot be canceled on a chosen date. Find the subscription id and billing state with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    destructive: true,
    inputSchema: cancelSubscriptionInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody({ ...input, status: "canceled" }),
        `/collections?subscription=${input.id}`,
      ),
  }),
  mutationTool({
    name: "bill_subscription_now",
    title: "Bill Subscription Now",
    description:
      "Generate the next bill for an eligible subscription using its configured billing terms. Find the subscription id and next billing date with list_subscriptions.",
    permission: "ar.create",
    featureKey: "subscriptionBilling",
    inputSchema: billNowInput,
    execute: async (context, input) =>
      invokeSubscriptionAction(
        context,
        subscriptionBody(input),
        `/collections?subscription=${input.id}`,
      ),
  }),
];
