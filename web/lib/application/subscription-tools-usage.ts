import "server-only";
import { z } from "zod";
import {
  listStripeBillingCustomers,
  listUsageRatingSettings,
  saveUsageRatingSchedule,
} from "@openbooks/engine/billing";
import {
  closeSubscriptionUsageLink,
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  getUsageRatingPlanVersionWithBands,
  listSubscriptionUsageLinks,
  listUsageRatingPlans,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
  retireUsageRatingPlan,
} from "@openbooks/engine/billing/usage/rating-plans";
import {
  createUsageMeter,
  deactivateUsageMeter,
  ingestUsageRecords,
  listUsageMeters,
  listUsageRecords,
  reactivateUsageMeter,
  reverseUsageRecord,
  updateUsageMeter,
} from "@openbooks/engine/billing/usage/records";
import { createPrepaidGrant, listPrepaidGrants } from "@openbooks/engine/billing/usage/prepaid";
import {
  commitRateRun,
  getRateRun,
  listRateRuns,
  previewRateRun,
  voidAndRebillRateRun,
} from "@openbooks/engine/billing/usage/rate-run";
import {
  importStripeBilling,
  getStripeBillingOverview,
  linkStripeCustomer,
  linkStripeSubscription,
  saveStripeBillingSchedule,
  skipStripeObject,
  unskipStripeObject,
} from "@openbooks/engine/sync";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  DATE,
  IDEMPOTENCY_KEY,
  mutationTool,
  readTool,
  requireUnrestrictedScope,
  UUID,
} from "./subscription-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";

const meterAggregation = z
  .enum(["sum", "count", "max", "last", "unique_count"])
  .describe("How records for this meter are aggregated.");
const meterInput = z.object({
  key: z.string().trim().min(1).max(120).describe("Stable machine key used by usage ingest."),
  name: z.string().trim().min(1).max(200).describe("Operator facing meter name."),
  unit: z.string().trim().min(1).max(80).describe("Unit represented by each recorded quantity."),
  aggregation: meterAggregation,
  itemId: UUID.nullable().optional().describe("Optional item billed for usage on this meter."),
});
const meterPatch = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe("Stable machine key used by usage ingest."),
    name: z.string().trim().min(1).max(200).optional().describe("Operator facing meter name."),
    unit: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("Unit represented by each recorded quantity."),
    aggregation: meterAggregation.optional(),
    itemId: UUID.nullable().optional().describe("Optional item billed for usage on this meter."),
  })
  .refine((value) => Object.keys(value).length > 0, "Supply at least one meter field to update.");

const ratingBand = z.object({
  meterId: UUID.describe("Meter used by this pricing band."),
  kind: z
    .enum(["graduated", "volume", "package", "overage", "commit_shortfall", "prepaid_drawdown"])
    .describe("Rating behavior for this band."),
  seq: z.number().int().positive().describe("Band order, starting at one."),
  upToQty: z
    .string()
    .max(40)
    .regex(/^-?\d+(?:\.\d{1,8})?$/)
    .nullable()
    .describe("Inclusive upper quantity bound, or null for the final band."),
  unitPrice: z
    .string()
    .max(40)
    .regex(/^-?\d+(?:\.\d{1,4})?$/)
    .describe("Exact decimal price per unit."),
  flatAmount: z
    .string()
    .max(40)
    .regex(/^-?\d+(?:\.\d{1,4})?$/)
    .optional()
    .describe("Exact decimal flat charge for this band."),
  includedQty: z
    .string()
    .max(40)
    .regex(/^\d+(?:\.\d{1,8})?$/)
    .optional()
    .describe("Exact decimal included quantity."),
  packageSize: z
    .string()
    .max(40)
    .regex(/^\d+(?:\.\d{1,8})?$/)
    .nullable()
    .optional()
    .describe("Exact decimal quantity in each package."),
  packageRounding: z
    .enum(["up", "down"])
    .nullable()
    .optional()
    .describe("Package quantity rounding rule."),
});

const usageRecordInput = z.object({
  meterKey: z.string().trim().min(1).max(120).describe("Meter key from list_usage_meters."),
  customerId: UUID.describe("Customer party id."),
  subscriptionId: UUID.nullable()
    .optional()
    .describe("Subscription that generated the usage, when applicable."),
  occurredOn: DATE,
  quantity: z
    .string()
    .max(40)
    .regex(/^-?\d+(?:\.\d{1,8})?$/)
    .describe("Exact decimal usage quantity; never a JSON number."),
  distinctKey: z
    .string()
    .nullable()
    .optional()
    .describe("Optional distinct-count identity for this record."),
  source: z
    .enum(["api", "import", "connector_stripe", "manual"])
    .describe("Origin of this usage record."),
  sourceRef: z.string().nullable().optional().describe("External source reference, if available."),
  idempotencyKey: IDEMPOTENCY_KEY.describe("Stable key for this individual usage record."),
});

export const SUBSCRIPTION_USAGE_TOOLS: ApplicationToolDefinition[] = [
  readTool({
    name: "list_usage_meters",
    title: "List Usage Meters",
    description:
      "List active and inactive usage meters and their keys. Use the returned meter id or key when configuring plans and ingesting records.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      meters: await listUsageMeters(context.authz.user.orgId),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "create_usage_meter",
    title: "Create Usage Meter",
    description:
      "Create a usage meter before adding it to a rating plan or ingesting records. Find existing meters with list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: meterInput.extend({ idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const { idempotencyKey: _key, ...body } = input;
      const meter = await createUsageMeter(context.authz.user.orgId, context.authz.user.id, body);
      return { ok: true, meter, status: "active", href: "/collections" };
    },
  }),
  mutationTool({
    name: "update_usage_meter",
    title: "Update Usage Meter",
    description:
      "Change a meter's key, name, unit, aggregation or billed item. Use list_usage_meters to find the meter id.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: meterPatch.extend({ meterId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const { meterId, idempotencyKey: _key, ...patch } = input;
      const meter = await updateUsageMeter(
        context.authz.user.orgId,
        context.authz.user.id,
        meterId,
        patch,
      );
      return {
        ok: true,
        meter,
        status: meter.isActive ? "active" : "inactive",
        href: "/collections",
      };
    },
  }),
  mutationTool({
    name: "deactivate_usage_meter",
    title: "Deactivate Usage Meter",
    description:
      "Deactivate a meter that should no longer accept usage records. Find its id with list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ meterId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const meter = await deactivateUsageMeter(
        context.authz.user.orgId,
        context.authz.user.id,
        input.meterId,
      );
      return { ok: true, meter, status: "inactive", href: "/collections" };
    },
  }),
  mutationTool({
    name: "reactivate_usage_meter",
    title: "Reactivate Usage Meter",
    description: "Reactivate a previously deactivated meter. Find its id with list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ meterId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const meter = await reactivateUsageMeter(
        context.authz.user.orgId,
        context.authz.user.id,
        input.meterId,
      );
      return { ok: true, meter, status: "active", href: "/collections" };
    },
  }),
  readTool({
    name: "list_usage_rating_plans",
    title: "List Usage Rating Plans",
    description:
      "List usage rating plans and their current versions. Use these ids when creating versions or subscription usage links.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      plans: await listUsageRatingPlans(context.authz.user.orgId),
      href: "/collections",
    }),
  }),
  readTool({
    name: "get_stripe_billing_overview",
    title: "Get Stripe Billing Overview",
    description:
      "Read the connected Stripe account, import schedule and synchronization status before linking or importing billing records. Use list_stripe_billing_customers for native customer ids.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      ...(await getStripeBillingOverview(context.authz.user.orgId)),
      href: "/sync",
    }),
  }),
  readTool({
    name: "list_stripe_billing_customers",
    title: "List Stripe Billing Customers",
    description:
      "List active native customers visible to this user for Stripe Billing linking. Find Stripe account and import state with get_stripe_billing_overview.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      customers: await listStripeBillingCustomers(db, {
        orgId: context.authz.user.orgId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      }),
      href: "/sync",
    }),
  }),
  mutationTool({
    name: "create_usage_rating_plan",
    title: "Create Usage Rating Plan",
    description:
      "Create a rating plan before defining its versions and bands. Find existing plans with list_usage_rating_plans.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      name: z.string().trim().min(1).max(200).describe("Plan name shown to operators."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Uppercase ISO 4217 currency code."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const { idempotencyKey: _key, ...body } = input;
      const plan = await createUsageRatingPlan(
        context.authz.user.orgId,
        context.authz.user.id,
        body,
      );
      return { ok: true, plan, status: plan.status, href: "/collections" };
    },
  }),
  mutationTool({
    name: "retire_usage_rating_plan",
    title: "Retire Usage Rating Plan",
    description:
      "Retire an active rating plan that should no longer be assigned. Find the plan id with list_usage_rating_plans.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ planId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const plan = await retireUsageRatingPlan(
        context.authz.user.orgId,
        context.authz.user.id,
        input.planId,
      );
      return { ok: true, plan, status: plan.status, href: "/collections" };
    },
  }),
  mutationTool({
    name: "create_usage_rating_plan_version",
    title: "Create Usage Rating Plan Version",
    description:
      "Create a draft effective-dated version for a rating plan. Find the plan id with list_usage_rating_plans.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ planId: UUID, effectiveFrom: DATE, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const { idempotencyKey: _key, ...body } = input;
      const version = await createUsageRatingPlanVersion(
        context.authz.user.orgId,
        context.authz.user.id,
        body,
      );
      return { ok: true, version, status: version.status, href: "/collections" };
    },
  }),
  readTool({
    name: "get_usage_rating_plan_version",
    title: "Get Usage Rating Plan Version",
    description:
      "Read a rating-plan version and its bands before publishing it. Find version ids from list_usage_rating_plans.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({ versionId: UUID }),
    execute: async (context, input) => ({
      ok: true,
      version: await getUsageRatingPlanVersionWithBands(context.authz.user.orgId, input.versionId),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "replace_usage_rating_bands",
    title: "Replace Usage Rating Bands",
    description:
      "Replace all draft pricing bands on a usage-plan version; published versions are immutable. Read version and meter ids with get_usage_rating_plan_version and list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      versionId: UUID,
      bands: z
        .array(ratingBand)
        .max(500)
        .describe("Complete replacement band set for this draft version."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const bands = await replaceUsageRatingBands(
        context.authz.user.orgId,
        context.authz.user.id,
        input.versionId,
        input.bands,
      );
      return { ok: true, versionId: input.versionId, bands, status: "draft", href: "/collections" };
    },
  }),
  mutationTool({
    name: "publish_usage_rating_plan_version",
    title: "Publish Usage Rating Plan Version",
    description:
      "Publish a configured draft usage-plan version after its meters and bands are complete. Find version ids with list_usage_rating_plans.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ versionId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const version = await publishUsagePlanVersion(
        context.authz.user.orgId,
        context.authz.user.id,
        input.versionId,
      );
      return { ok: true, version, status: version.status, href: "/collections" };
    },
  }),
  readTool({
    name: "list_subscription_usage_links",
    title: "List Subscription Usage Links",
    description:
      "List usage-plan assignments for one subscription or one customer. Find subscription ids with list_subscriptions and customer ids with party reads.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z
      .object({ subscriptionId: UUID.optional(), customerId: UUID.optional() })
      .refine(
        (value) => (value.subscriptionId === undefined) !== (value.customerId === undefined),
        "Supply exactly one subscriptionId or customerId.",
      ),
    execute: async (context, input) => ({
      ok: true,
      links: await listSubscriptionUsageLinks(
        context.authz.user.orgId,
        input,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "create_subscription_usage_link",
    title: "Assign Usage Plan to Subscription",
    description:
      "Assign published usage pricing to a subscription for an effective date range. Find ids with list_subscriptions, list_usage_rating_plans and list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      subscriptionId: UUID,
      customerId: UUID,
      planVersionId: UUID,
      meterIds: z.array(UUID).min(1).max(500).describe("Meters included in this assignment."),
      effectiveFrom: DATE,
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Last effective day, or null for an open-ended assignment."),
      commitAmount: z
        .string()
        .nullable()
        .optional()
        .describe("Exact decimal recurring commitment amount."),
      commitPeriod: z
        .enum(["monthly", "annual"])
        .nullable()
        .optional()
        .describe("Commitment billing period."),
      allowOverage: z
        .boolean()
        .optional()
        .describe("Whether rated usage may exceed the commitment."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const link = await createSubscriptionUsageLink(
        context.authz.user.orgId,
        context.authz.user.id,
        body,
        context.authz.allowedSubsidiaryIds,
      );
      return {
        ok: true,
        link,
        status: link.effectiveTo === null ? "active" : "closed",
        href: "/collections",
      };
    },
  }),
  mutationTool({
    name: "close_subscription_usage_link",
    title: "Close Subscription Usage Link",
    description:
      "End an open usage-plan assignment after the final billable date. Find link ids with list_subscription_usage_links.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({ linkId: UUID, effectiveTo: DATE, idempotencyKey: IDEMPOTENCY_KEY }),
    destructive: true,
    execute: async (context, input) => {
      const link = await closeSubscriptionUsageLink(
        context.authz.user.orgId,
        context.authz.user.id,
        input.linkId,
        input.effectiveTo,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, link, status: "closed", href: "/collections" };
    },
  }),
  readTool({
    name: "list_usage_records",
    title: "List Usage Records",
    description:
      "Read ingested usage for a date range, optionally filtered by meter and customer. Find meter and customer ids with the native list commands.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({
      from: DATE,
      to: DATE,
      meterId: UUID.optional(),
      customerId: UUID.optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum records to return."),
      offset: z.number().int().min(0).optional().describe("Number of matching records to skip."),
    }),
    execute: async (context, input) => ({
      ok: true,
      records: await listUsageRecords(
        context.authz.user.orgId,
        input,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "ingest_usage_records",
    title: "Ingest Usage Records",
    description:
      "Record measured usage for rating; each row also needs its stable record-level idempotency key. Read existing rows with list_usage_records and meter keys with list_usage_meters.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      records: z.array(usageRecordInput).min(1).max(500).describe("Usage records to ingest."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const records = await ingestUsageRecords(
        context.authz.user.orgId,
        context.authz.user.id,
        input.records,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, records, count: records.length, href: "/collections" };
    },
  }),
  mutationTool({
    name: "reverse_usage_record",
    title: "Reverse Usage Record",
    description:
      "Reverse a recorded usage row with an audit reason; the original remains immutable. Find the record id with list_usage_records.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      recordId: UUID,
      reason: z.string().trim().min(1).max(1000).describe("Reason for the correcting reversal."),
      occurredOn: DATE.optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    destructive: true,
    execute: async (context, input) => {
      const record = await reverseUsageRecord(
        context.authz.user.orgId,
        context.authz.user.id,
        input.recordId,
        input.reason,
        input.occurredOn,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, record, status: "reversed", href: "/collections" };
    },
  }),
  readTool({
    name: "preview_usage_rating_run",
    title: "Preview Usage Rating Run",
    description:
      "Preview rated usage and invoice lines for a subscription usage link and billing window before committing the run. Find link ids with list_subscription_usage_links.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({ linkId: UUID, periodStart: DATE, periodEnd: DATE }),
    execute: async (context, input) => ({
      ok: true,
      preview: await previewRateRun(
        context.authz.user.orgId,
        input.linkId,
        input.periodStart,
        input.periodEnd,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  readTool({
    name: "list_usage_rating_runs",
    title: "List Usage Rating Runs",
    description:
      "List usage rating runs and their outcomes, optionally scoped to a customer or usage link. Use returned ids to correct a committed run.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({
      customerId: UUID.optional(),
      linkId: UUID.optional(),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum runs to return."),
      offset: z.number().int().min(0).optional().describe("Number of runs to skip."),
    }),
    execute: async (context, input) => ({
      ok: true,
      runs: await listRateRuns(context.authz.user.orgId, input, context.authz.allowedSubsidiaryIds),
      href: "/collections",
    }),
  }),
  readTool({
    name: "get_usage_rating_run",
    title: "Get Usage Rating Run",
    description:
      "Read one usage rating run and its invoice outcome before correcting it. Find run ids with list_usage_rating_runs.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({ runId: UUID }),
    execute: async (context, input) => ({
      ok: true,
      run: await getRateRun(
        context.authz.user.orgId,
        input.runId,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "commit_usage_rating_run",
    title: "Commit Usage Rating Run",
    description:
      "Rate a usage link for a closed billing window and create its invoice run. Preview first with preview_usage_rating_run and inspect prior runs with list_usage_rating_runs.",
    permission: "usage.bill",
    featureKey: "usageBilling",
    inputSchema: z.object({
      linkId: UUID,
      periodStart: DATE,
      periodEnd: DATE,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const result = await commitRateRun(
        context.authz.user.orgId,
        context.authz.user.id,
        input.linkId,
        input.periodStart,
        input.periodEnd,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, result, status: "committed", href: "/collections" };
    },
  }),
  mutationTool({
    name: "void_and_rebill_usage_run",
    title: "Void and Rebill Usage Run",
    description:
      "Void a previously committed usage run and rate it again after corrected inputs; the original invoice history stays auditable. Find run ids with list_usage_rating_runs and include a reason when needed.",
    permission: "usage.bill",
    featureKey: "usageBilling",
    inputSchema: z.object({
      runId: UUID,
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe("Audit reason; defaults to the native usage-inputs-changed reason."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    destructive: true,
    execute: async (context, input) => {
      const result = await voidAndRebillRateRun(
        context.authz.user.orgId,
        context.authz.user.id,
        input.runId,
        input.reason,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, result, status: "rebilled", href: "/collections" };
    },
  }),
  readTool({
    name: "get_usage_rating_schedule",
    title: "Get Usage Rating Schedule",
    description:
      "Read the default and subscription-specific usage rating schedule settings before changing rating cadence or automatic commit behavior.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({}),
    execute: async (context) => ({
      ok: true,
      schedules: await listUsageRatingSettings(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "save_usage_rating_schedule",
    title: "Save Usage Rating Schedule",
    description:
      "Change the default or one subscription link's rating cadence, grace days or commit mode. Read current settings with get_usage_rating_schedule.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      linkId: UUID.nullable()
        .optional()
        .describe(
          "Link id for a scoped schedule; omit or null to update the organization default.",
        ),
      cadence: z
        .enum(["billing_period", "monthly", "paused"])
        .optional()
        .describe("When to rate usage."),
      graceDays: z
        .number()
        .int()
        .min(0)
        .max(30)
        .optional()
        .describe("Days after period end before rating."),
      mode: z
        .enum(["draft", "auto_commit"])
        .optional()
        .describe("Whether the run stays draft or commits automatically."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (input.linkId == null) requireUnrestrictedScope(context);
      const { idempotencyKey: _key, ...body } = input;
      const setting = await saveUsageRatingSchedule(
        context.authz.user.orgId,
        context.authz.user.id,
        {
          linkId: body.linkId ?? null,
          cadence: body.cadence,
          graceDays: body.graceDays,
          mode: body.mode,
        },
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, setting, href: "/collections" };
    },
  }),
  readTool({
    name: "list_prepaid_usage_grants",
    title: "List Prepaid Usage Grants",
    description:
      "Read prepaid usage grants and remaining balances. Omit asOf to use the organization's current business date.",
    permission: "usage.read",
    featureKey: "usageBilling",
    inputSchema: z.object({ asOf: DATE.optional() }),
    execute: async (context, input) => ({
      ok: true,
      grants: await listPrepaidGrants(
        context.authz.user.orgId,
        input.asOf ?? (await businessToday(context.authz.user.orgId)),
        context.authz.allowedSubsidiaryIds,
      ),
      href: "/collections",
    }),
  }),
  mutationTool({
    name: "create_prepaid_usage_grant",
    title: "Create Prepaid Usage Grant",
    description:
      "Grant a customer prepaid usage value against a source document line, optionally with an expiry date. Find customer and source-line ids with party and document reads.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      customerId: UUID,
      sourceDocumentLineId: UUID,
      amount: z
        .string()
        .max(40)
        .regex(/^\d+(?:\.\d{1,4})?$/)
        .describe("Exact decimal prepaid amount; never a JSON number."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .describe("Uppercase ISO 4217 currency code."),
      expiresOn: DATE.nullable().optional().describe("Optional final day the grant can be used."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const grant = await createPrepaidGrant(
        context.authz.user.orgId,
        context.authz.user.id,
        body,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, grant, status: "active", href: "/collections" };
    },
  }),
  mutationTool({
    name: "import_stripe_billing_history",
    title: "Import Stripe Billing History",
    description:
      "Import Stripe customers, subscriptions and usage records for an inclusive date window after the Stripe account is connected. This calls Stripe; use Stripe billing overview and import reads to review the result.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    openWorld: true,
    inputSchema: z.object({ since: DATE, until: DATE, idempotencyKey: IDEMPOTENCY_KEY }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const result = await importStripeBilling(context.authz.user.orgId, context.authz.user.id, {
        since: input.since,
        until: input.until,
      });
      return { ok: true, result, status: "completed", href: "/sync" };
    },
  }),
  mutationTool({
    name: "link_stripe_billing_record",
    title: "Link Stripe Billing Record",
    description:
      "Link one Stripe customer or subscription id to its native party or subscription after verifying the match. Find native ids through party reads or list_subscriptions.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      objectType: z.enum(["customer", "subscription"]).describe("Kind of native record to link."),
      stripeId: z
        .string()
        .min(1)
        .max(255)
        .describe("Customer or subscription id returned by Stripe."),
      nativeId: UUID.describe("Native party or subscription id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      if (input.objectType === "customer")
        await linkStripeCustomer(
          context.authz.user.orgId,
          context.authz.user.id,
          input.stripeId,
          input.nativeId,
          context.authz.allowedSubsidiaryIds,
        );
      else
        await linkStripeSubscription(
          context.authz.user.orgId,
          context.authz.user.id,
          input.stripeId,
          input.nativeId,
          context.authz.allowedSubsidiaryIds,
        );
      return {
        ok: true,
        objectType: input.objectType,
        stripeId: input.stripeId,
        nativeId: input.nativeId,
        href: "/sync",
      };
    },
  }),
  mutationTool({
    name: "save_stripe_billing_import_schedule",
    title: "Save Stripe Billing Import Schedule",
    description:
      "Set automatic Stripe Billing import cadence to off, hourly or daily. This changes organization-wide configuration; the schedule is shown on the Sync page.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      cadence: z.enum(["off", "hourly", "daily"]).describe("Automatic import cadence."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      const cadence = await saveStripeBillingSchedule(
        context.authz.user.orgId,
        context.authz.user.id,
        input.cadence,
      );
      return { ok: true, cadence, href: "/sync" };
    },
  }),
  mutationTool({
    name: "skip_stripe_billing_record",
    title: "Skip Stripe Billing Record",
    description:
      "Exclude a Stripe customer or subscription from billing-history import with an optional audit reason. Use Stripe billing overview to find the Stripe account id.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    inputSchema: z.object({
      objectType: z.enum(["customer", "subscription"]).describe("Stripe object kind."),
      stripeId: z.string().min(1).max(255).describe("Stripe object id."),
      stripeAccount: z
        .string()
        .min(1)
        .max(255)
        .describe("Stripe account id from the billing overview."),
      reason: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Optional reason for excluding this object."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      await skipStripeObject(
        context.authz.user.orgId,
        context.authz.user.id,
        input.stripeAccount,
        input.objectType,
        input.stripeId,
        input.reason ?? null,
      );
      return { ok: true, stripeId: input.stripeId, status: "skipped", href: "/sync" };
    },
  }),
  mutationTool({
    name: "unskip_stripe_billing_record",
    title: "Unskip Stripe Billing Record",
    description:
      "Remove a prior exclusion so a Stripe customer or subscription can be imported again. Use Stripe billing overview to find the Stripe account and record ids.",
    permission: "usage.manage",
    featureKey: "usageBilling",
    destructive: true,
    inputSchema: z.object({
      objectType: z.enum(["customer", "subscription"]).describe("Stripe object kind."),
      stripeId: z.string().min(1).max(255).describe("Stripe object id."),
      stripeAccount: z
        .string()
        .min(1)
        .max(255)
        .describe("Stripe account id from the billing overview."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      requireUnrestrictedScope(context);
      await unskipStripeObject(
        context.authz.user.orgId,
        context.authz.user.id,
        input.stripeAccount,
        input.objectType,
        input.stripeId,
      );
      return { ok: true, stripeId: input.stripeId, status: "eligible", href: "/sync" };
    },
  }),
];
