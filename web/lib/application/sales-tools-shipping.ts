import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  connectShippingAccount,
  disconnectShippingAccount,
  getShipmentLabels,
  importBillingAdjustments,
  listAdjustmentsByCarrier,
  listShippingAccounts,
  postBillingAdjustment,
  rotateShippingRelaySecret,
  testShippingConnection,
  ShippingRefusal,
} from "@openbooks/engine/sales/shipping-labels";
import { fulfillmentDocumentScope } from "@openbooks/engine/sales/fulfillment";
import {
  bulkBuyBody,
  bulkPreviewBody,
  buyBulkShipmentLabels,
  listBulkShipmentCandidates,
  previewBulkShipmentLabels,
} from "../shipping/bulk";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a carrier account, shipment, handling unit, or adjustment read.");
const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const visible = (permission: string) => (authz: Parameters<typeof can>[0]) =>
  can(authz, permission);

function assertUnrestricted(context: Parameters<typeof assertApplicationPermission>[0]) {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleShipping(error: unknown): never {
  if (error instanceof ShippingRefusal) {
    const details: Record<string, unknown> = { code: error.code };
    if (error.remedy) details.remedy = error.remedy;
    if (error.status === 404) throw notFound(error.message);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export const SALES_SHIPPING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_shipping_accounts",
    title: "List Shipping Accounts",
    description:
      "List connected carrier accounts, their mode, status, and default selection without revealing stored API keys. Shipping account access is organization-wide.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: (authz) => can(authz, "shipping.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context) => {
      assertApplicationPermission(context, "shipping.manage");
      assertUnrestricted(context);
      try {
        return {
          ok: true,
          accounts: await listShippingAccounts(db, context.authz.user.orgId),
          href: "/admin/setup/shipping",
        };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "list_bulk_shipment_candidates",
    title: "List Bulk Shipment Candidates",
    description:
      "List draft shipments and packed handling units that are ready for bulk rate shopping. Use returned ids in preview_bulk_shipment_rates.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context) => {
      assertApplicationPermission(context, "orders.fulfill");
      const candidates = await listBulkShipmentCandidates(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds,
      );
      return { ok: true, candidates, href: "/shipping/bulk" };
    },
  }),
  definition({
    name: "preview_bulk_shipment_rates",
    title: "Preview Bulk Shipment Rates",
    description:
      "Rate each packed shipment and choose a carrier service by cheapest, fastest, or promised-date policy. Find candidates with list_bulk_shipment_candidates; review every refusal row before purchase.",
    inputSchema: bulkPreviewBody,
    readOnly: true,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const result = await previewBulkShipmentLabels(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        input,
      );
      return { ok: true, ...result, href: "/shipping/bulk" };
    },
  }),
  definition({
    name: "buy_bulk_shipment_labels",
    title: "Buy Bulk Shipment Labels",
    description:
      "Purchase the selected carrier labels for packed shipments, one parcel at a time, and collect downloaded labels into a print-ready PDF. Review preview_bulk_shipment_rates first; provider failures are returned per parcel.",
    inputSchema: bulkBuyBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      const { idempotencyKey: _key, ...body } = input;
      const result = await buyBulkShipmentLabels(
        context.authz.user.orgId,
        context.authz.user.id,
        context.authz.allowedSubsidiaryIds,
        body,
      );
      return { ok: true, ...result, href: "/shipping/labels" };
    },
  }),
  definition({
    name: "connect_shipping_account",
    title: "Connect Shipping Account",
    description:
      "Connect or reconnect an EasyPost or Shippo account and make it the default if requested. The API key is sealed, and a new relay secret is returned once; access is organization-wide.",
    inputSchema: z.object({
      accountId: UUID.nullable()
        .optional()
        .describe("Existing shipping-account UUID to reconnect; omit to create one."),
      name: z.string().min(1).max(120).describe("Operator-facing carrier account name."),
      provider: z.enum(["easypost", "shippo"]).describe("Carrier aggregation provider."),
      mode: z.enum(["test", "live"]).describe("Provider API environment."),
      apiKey: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Provider API key; stored sealed and never returned."),
      makeDefault: z.boolean().optional().describe("Make this the default account for new labels."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: (authz) => can(authz, "shipping.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      assertUnrestricted(context);
      try {
        const { idempotencyKey: _key, ...body } = input;
        const connected = await db.transaction((tx) =>
          connectShippingAccount(tx, context.authz.user.orgId, context.authz.user.id, body),
        );
        return { ok: true, connected, href: "/admin/setup/shipping" };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "test_shipping_account",
    title: "Test Shipping Account",
    description:
      "Test a connected carrier account over its sealed API key before buying labels. Find the account id with list_shipping_accounts; access is organization-wide.",
    inputSchema: z.object({ accountId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: (authz) => can(authz, "shipping.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      assertUnrestricted(context);
      try {
        const test = await db.transaction((tx) =>
          testShippingConnection(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            input.accountId,
          ),
        );
        return { ok: true, test, href: "/admin/setup/shipping" };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "rotate_shipping_relay_secret",
    title: "Rotate Shipping Relay Secret",
    description:
      "Issue a new one-time relay secret for signed carrier tracking callbacks; the previous secret stops working. Find the account id with list_shipping_accounts; access is organization-wide.",
    inputSchema: z.object({ accountId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: (authz) => can(authz, "shipping.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      assertUnrestricted(context);
      try {
        const connected = await db.transaction((tx) =>
          rotateShippingRelaySecret(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            input.accountId,
          ),
        );
        if (!connected) throw notFound("shipping account");
        return { ok: true, connected, href: "/admin/setup/shipping" };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "disconnect_shipping_account",
    title: "Disconnect Shipping Account",
    description:
      "Disable a carrier account while preserving its labels, quotes, and cost history. Find the account id with list_shipping_accounts; access is organization-wide.",
    inputSchema: z.object({ accountId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: (authz) => can(authz, "shipping.manage") && authz.allowedSubsidiaryIds === null,
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      assertUnrestricted(context);
      try {
        await db.transaction((tx) =>
          disconnectShippingAccount(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            input.accountId,
          ),
        );
        return {
          ok: true,
          disconnected: true,
          accountId: input.accountId,
          href: "/admin/setup/shipping",
        };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "list_shipment_labels",
    title: "List Shipment Labels",
    description:
      "List purchased and voided carrier labels for a shipment. Find shipment ids with get_shipment.",
    inputSchema: z.object({ shipmentId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("orders.fulfill"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "orders.fulfill");
      const scope = await fulfillmentDocumentScope(
        db,
        context.authz.user.orgId,
        input.shipmentId,
        "shipment",
      );
      if (!scope) throw notFound("shipment");
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        (scope.subsidiaryId === null || !context.authz.allowedSubsidiaryIds.has(scope.subsidiaryId))
      ) {
        throw notFound("shipment");
      }
      try {
        return {
          ok: true,
          labels: await getShipmentLabels(db, context.authz.user.orgId, input.shipmentId),
          href: listRecordDrawerHref("shipment", input.shipmentId),
        };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "import_carrier_billing_adjustments",
    title: "Import Carrier Billing Adjustments",
    description:
      "Import carrier invoice adjustments against bought labels, deduplicated by provider adjustment identity. Find the connected account with list_shipping_accounts and provide provider ids from its invoice.",
    inputSchema: z.object({
      accountId: UUID,
      items: z
        .array(
          z.object({
            providerAdjustmentId: z
              .string()
              .min(1)
              .max(200)
              .describe("Stable adjustment id from the carrier invoice."),
            providerShipmentId: z
              .string()
              .min(1)
              .max(200)
              .describe("Carrier shipment id matching a bought label."),
            kind: z
              .enum([
                "weight_correction",
                "dimension_correction",
                "address_correction",
                "fuel",
                "duplicate",
                "other",
              ])
              .describe("Carrier adjustment reason."),
            amount: z.string().min(1).max(40).describe("Exact adjustment amount as decimal text."),
            currency: z.string().length(3).describe("Three-letter adjustment currency."),
            reason: z
              .string()
              .max(500)
              .nullable()
              .optional()
              .describe("Carrier's adjustment explanation."),
            occurredAt: z
              .string()
              .max(30)
              .nullable()
              .optional()
              .describe("Carrier event timestamp."),
          }),
        )
        .min(1)
        .max(500)
        .describe("Carrier billing adjustments to import."),
      idempotencyKey: KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      try {
        const adjustments = await db.transaction((tx) =>
          importBillingAdjustments(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            input.accountId,
            input.items,
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return { ok: true, adjustments, href: "/shipping/adjustments" };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "post_carrier_billing_adjustment",
    title: "Post Carrier Billing Adjustment",
    description:
      "Post an imported carrier adjustment to the general ledger after reviewing its label, amount, and account mapping. Find adjustment ids in the shipping adjustment reads.",
    inputSchema: z.object({ adjustmentId: UUID, idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      try {
        const posted = await db.transaction((tx) =>
          postBillingAdjustment(
            tx,
            context.authz.user.orgId,
            context.authz.user.id,
            input.adjustmentId,
            context.authz.allowedSubsidiaryIds,
          ),
        );
        return { ok: true, posted, href: "/shipping/adjustments" };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
  definition({
    name: "list_posted_carrier_adjustments",
    title: "List Posted Carrier Adjustments",
    description:
      "Read posted carrier invoice adjustments by posting date for the primary book. Use adjustment ids from the imported adjustment command for individual posting actions.",
    inputSchema: z.object({
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start posting date, inclusive, in YYYY-MM-DD format."),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End posting date, inclusive, in YYYY-MM-DD format."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "shippingHub",
    visibleTo: visible("shipping.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "shipping.manage");
      try {
        return {
          ok: true,
          adjustments: await listAdjustmentsByCarrier(db, context.authz.user.orgId, input),
          href: "/shipping/adjustments",
        };
      } catch (error) {
        settleShipping(error);
      }
    },
  }),
];
