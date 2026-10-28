import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  createWebhookEndpoint,
  readWebhookEndpointActivity,
  redeliverWebhookDelivery,
  rotateWebhookEndpointSecret,
  sendWebhookTestPing,
  setWebhookEndpointStatus,
  updateWebhookEndpoint,
  WebhookEndpointError,
  FANOUT_EVENT_TYPES,
} from "@openbooks/engine/webhooks";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Id returned by list_records for webhook_endpoint.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const EVENT = z
  .string()
  .max(100)
  .refine((event) => FANOUT_EVENT_TYPES.has(event), "event is not subscribable")
  .describe("Supported event type from the webhook event catalog.");

async function assertWebhookFeature(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "outboundWebhooks")))
    throw notFound("route");
}

async function assertUnrestricted(context: ApplicationContext): Promise<void> {
  assertApplicationPermission(context, "webhooks.manage");
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
  await assertWebhookFeature(context);
}

function settleWebhookError(error: unknown): never {
  if (error instanceof WebhookEndpointError) {
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  throw error;
}

export const ADMIN_WEBHOOK_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_webhook_endpoint_activity",
    title: "Get Webhook Endpoint Activity",
    description:
      "Read endpoint configuration and its latest deliveries. Find endpoint ids with list_records for webhook_endpoint; signing secrets are never included in reads.",
    inputSchema: z.object({ endpointId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "webhooks.read"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      assertApplicationPermission(context, "webhooks.read");
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      await assertWebhookFeature(context);
      const activity = await readWebhookEndpointActivity(
        context.authz.user.orgId,
        input.endpointId,
      );
      if (!activity.endpoint) throw notFound("webhook endpoint");
      return { ...activity, href: `/admin/webhooks?endpoint=${input.endpointId}` };
    },
  }),
  definition({
    name: "create_webhook_endpoint",
    title: "Create Webhook Endpoint",
    description:
      "Register an active subscriber endpoint for selected domain events. Choose a stable key and a publicly reachable HTTPS URL; the signing secret is returned once. Use list_records for webhook_endpoint to verify the saved endpoint.",
    inputSchema: z.object({
      key: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Stable endpoint key, lowercase letters, digits, hyphen or underscore."),
      url: z.string().trim().min(1).max(2000).describe("HTTPS subscriber URL."),
      description: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Optional operator description."),
      events: z.array(EVENT).max(500).describe("Event types this endpoint subscribes to."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        const created = await createWebhookEndpoint(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            key: input.key,
            url: input.url,
            description: input.description ?? "",
            events: input.events,
          },
        );
        return {
          ok: true,
          endpointId: created.id,
          secret: created.secret,
          status: "active",
          href: `/admin/webhooks?endpoint=${created.id}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
  definition({
    name: "update_webhook_endpoint",
    title: "Update Webhook Endpoint",
    description:
      "Update a subscriber URL, description or event subscriptions. Find the endpoint id with list_records for webhook_endpoint; this only changes the saved destination and does not send a test event.",
    inputSchema: z
      .object({
        endpointId: UUID,
        url: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .optional()
          .describe("Replacement HTTPS subscriber URL."),
        description: z
          .string()
          .max(500)
          .nullable()
          .optional()
          .describe("Replacement operator description."),
        events: z.array(EVENT).max(500).optional().describe("Replacement event subscriptions."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          input.url !== undefined || input.description !== undefined || input.events !== undefined,
        "provide a field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        await updateWebhookEndpoint(
          context.authz.user.orgId,
          context.authz.user.id,
          input.endpointId,
          {
            url: input.url,
            description: input.description ?? undefined,
            events: input.events,
          },
        );
        return {
          ok: true,
          endpointId: input.endpointId,
          href: `/admin/webhooks?endpoint=${input.endpointId}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
  definition({
    name: "set_webhook_endpoint_status",
    title: "Enable or Disable Webhook Endpoint",
    description:
      "Enable a disabled endpoint or disable an active endpoint with an optional reason. Find endpoint ids with list_records for webhook_endpoint; disabled endpoints receive no deliveries.",
    inputSchema: z.object({
      endpointId: UUID,
      status: z.enum(["active", "disabled"]).describe("Desired endpoint state."),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe("Reason recorded when disabling the endpoint."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        await setWebhookEndpointStatus(
          context.authz.user.orgId,
          context.authz.user.id,
          input.endpointId,
          input.status,
          input.reason,
        );
        return {
          ok: true,
          endpointId: input.endpointId,
          status: input.status,
          href: `/admin/webhooks?endpoint=${input.endpointId}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
  definition({
    name: "rotate_webhook_signing_secret",
    title: "Rotate Webhook Signing Secret",
    description:
      "Rotate one endpoint's signing secret; the new secret is returned once and the current and previous signatures overlap during delivery transition. Find the endpoint id with list_records for webhook_endpoint.",
    inputSchema: z.object({ endpointId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        const rotated = await rotateWebhookEndpointSecret(
          context.authz.user.orgId,
          context.authz.user.id,
          input.endpointId,
        );
        return {
          ok: true,
          endpointId: input.endpointId,
          secret: rotated.secret,
          href: `/admin/webhooks?endpoint=${input.endpointId}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
  definition({
    name: "test_webhook_endpoint",
    title: "Test Webhook Endpoint",
    description:
      "Send and record one endpoint.tested event to an active subscriber endpoint. Find endpoint ids with list_records for webhook_endpoint, then verify the delivery with get_webhook_endpoint_activity.",
    inputSchema: z.object({ endpointId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        const result = await sendWebhookTestPing(
          context.authz.user.orgId,
          context.authz.user.id,
          input.endpointId,
        );
        return {
          ok: true,
          ...result,
          endpointId: input.endpointId,
          href: `/admin/webhooks?endpoint=${input.endpointId}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
  definition({
    name: "redeliver_webhook_event",
    title: "Redeliver Webhook Event",
    description:
      "Retry one recorded delivery to the same endpoint. Use get_webhook_endpoint_activity to find a delivery id and verify its resulting status.",
    inputSchema: z.object({ endpointId: UUID, deliveryId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "webhooks.manage"),
    featureKey: "outboundWebhooks",
    execute: async (context, input) => {
      await assertUnrestricted(context);
      try {
        const result = await redeliverWebhookDelivery(
          context.authz.user.orgId,
          context.authz.user.id,
          input.endpointId,
          input.deliveryId,
        );
        return {
          ok: true,
          ...result,
          endpointId: input.endpointId,
          href: `/admin/webhooks?endpoint=${input.endpointId}`,
        };
      } catch (error) {
        settleWebhookError(error);
      }
    },
  }),
];
