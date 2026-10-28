import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { readLandedCostVouchers } from "../inventory-advanced-reads";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  createTransferOrder,
  receiveTransferOrder,
  shipTransferOrder,
} from "@openbooks/engine/inventory/transfer-orders";
import {
  postLandedCostVoucher,
  reverseLandedCostVoucher,
} from "@openbooks/engine/inventory/landed-cost";
import { executeIdempotentInventoryAction } from "@openbooks/engine/inventory/action-idempotency";
import {
  defaultPostingSubsidiaryId,
  loadSubsidiaryContext,
  SubsidiaryError,
} from "@openbooks/engine/organization/subsidiaries";
import { can } from "../authz";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  settleInventoryRefusal,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { forbidden, invalidInput, notFound } from "./errors";
import { z } from "zod";

const AMOUNT = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Exact non-negative decimal string; never use a JSON number.");
const visibleRead = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.read");
const visiblePost = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.post");

async function postingSubsidiary(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  requested?: string,
): Promise<string> {
  let subsidiaryId = requested;
  if (!subsidiaryId) {
    try {
      subsidiaryId = defaultPostingSubsidiaryId(
        await loadSubsidiaryContext(db, context.authz.user.orgId),
      );
    } catch (error) {
      if (error instanceof SubsidiaryError)
        throw invalidInput("No subsidiary is configured for this inventory action.", {
          remedy: "Configure a subsidiary in Company Settings before posting inventory.",
        });
      throw error;
    }
  }
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed !== null && !allowed.has(subsidiaryId)) throw forbidden("subsidiary.restricted");
  return subsidiaryId;
}

async function executeMovement<T>(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  operation: string,
  idempotencyKey: string,
  request: unknown,
  execute: () => Promise<T>,
) {
  try {
    const outcome = await executeIdempotentInventoryAction(
      context.authz.user.orgId,
      context.authz.user.id,
      { operation, idempotencyKey, request, execute },
    );
    return { ok: true, replayed: outcome.replayed, ...(outcome.value as Record<string, unknown>) };
  } catch (error) {
    settleInventoryRefusal(error);
  }
}

export const INVENTORY_TRANSFER_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_inventory_transfer_orders",
    title: "List Inventory Transfer Orders",
    description:
      "List transfer orders visible to the caller before shipping or receiving. Use the returned id with ship_inventory_transfer_order or receive_inventory_transfer_order.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visibleRead,
    featureKey: "inventory",
    execute: async (context) => {
      assertApplicationPermission(context, "items.read");
      const allowed = context.authz.allowedSubsidiaryIds;
      const scope =
        allowed === null
          ? sql``
          : allowed.size === 0
            ? sql`and false`
            : sql`and t.subsidiary_id in (${sql.join(
                [...allowed].map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`;
      const transfers = await db.execute(
        sql`
        select t.id, t.document_number as "documentNumber", t.status, t.ordered_on as "orderedOn",
               t.shipped_on as "shippedOn", t.received_on as "receivedOn", t.memo,
               sf.code as "fromCode", st.code as "toCode"
          from transfer_orders t
          left join stock_locations sf on sf.id = t.from_stock_location_id and sf.org_id = t.org_id
          left join stock_locations st on st.id = t.to_stock_location_id and st.org_id = t.org_id
         where t.org_id = ${context.authz.user.orgId} ${scope}
         order by t.ordered_on desc, t.created_at desc limit 50
      `,
        "objects",
      );
      return { transfers, href: "/inventory?view=transfers" };
    },
  }),
  definition({
    name: "list_landed_cost_vouchers",
    title: "List Landed Cost Vouchers",
    description:
      "List posted or reversed landed-cost vouchers visible to the caller before reviewing or reversing one. Use a returned id with reverse_landed_cost_voucher.",
    inputSchema: z.object({
      status: z
        .enum(["posted", "void", "all"])
        .optional()
        .describe("Voucher lifecycle filter; defaults to all."),
      search: z.string().max(120).optional().describe("Search the voucher number or memo."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum voucher rows in this page; defaults to 50."),
      cursor: z
        .string()
        .max(500)
        .optional()
        .describe("Next-page cursor returned by the prior read."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visibleRead,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      const response = await readLandedCostVouchers(
        context.authz.user.orgId,
        context.authz.allowedSubsidiaryIds === null
          ? null
          : [...context.authz.allowedSubsidiaryIds],
        {
          status: input.status === "all" ? null : (input.status ?? null),
          limit: input.limit === undefined ? null : String(input.limit),
          search: input.search ?? null,
          cursor: input.cursor ?? null,
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof result.error === "string" ? result.error : "Voucher inquiry was refused.";
        throw invalidInput(message, result);
      }
      return { ...result, href: "/inventory?view=landed" };
    },
  }),
  definition({
    name: "create_inventory_transfer_order",
    title: "Create Inventory Transfer Order",
    description:
      "Create a draft transfer order for one or more stocked items moving between locations; stock moves when it is shipped. Find locations, items and the owning subsidiary through inventory reads, then verify with list_inventory_transfer_orders.",
    inputSchema: z.object({
      fromStockLocationId: UUID.describe("Source stock location."),
      toStockLocationId: UUID.describe("Destination stock location."),
      subsidiaryId: UUID.optional().describe(
        "Legal entity owning the stock; omitted uses the configured default entity.",
      ),
      orderedOn: DATE.optional().describe(
        "Order date; omitted uses the organization's current business date.",
      ),
      inTransitAccountId: UUID.nullable()
        .optional()
        .describe("Optional balance-sheet account for inventory value in transit."),
      transitStockLocationId: UUID.nullable()
        .optional()
        .describe(
          "Optional transit stock location; the engine otherwise resolves the configured default.",
        ),
      memo: z.string().max(500).nullable().optional().describe("Transfer purpose or notes."),
      lines: z
        .array(
          z
            .object({
              itemId: UUID.describe("Item id."),
              quantity: AMOUNT.describe("Positive exact base-unit quantity."),
              lotId: UUID.nullable().optional().describe("Lot id when tracked."),
              serialId: UUID.nullable().optional().describe("Serial id when tracked."),
            })
            .describe("One transfer order line."),
        )
        .min(1)
        .max(2000)
        .describe("Items and quantities to transfer."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const request = {
        fromStockLocationId: input.fromStockLocationId,
        toStockLocationId: input.toStockLocationId,
        subsidiaryId,
        orderedOn: input.orderedOn ?? (await businessToday(context.authz.user.orgId)),
        inTransitAccountId: input.inTransitAccountId ?? null,
        transitStockLocationId: input.transitStockLocationId ?? null,
        memo: input.memo ?? null,
        lines: input.lines.map((line) => ({
          itemId: line.itemId,
          quantity: line.quantity,
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        })),
      };
      const result = await executeMovement(
        context,
        "inventory.transfer-order.create",
        input.idempotencyKey,
        request,
        () => createTransferOrder(context.authz.user.orgId, context.authz.user.id, request),
      );
      return { ...result, href: "/inventory?view=transfers" };
    },
  }),
  definition({
    name: "ship_inventory_transfer_order",
    title: "Ship Inventory Transfer Order",
    description:
      "Ship a draft transfer order from its source location into the configured in-transit location. Find its id with list_inventory_transfer_orders and verify the in-transit status there.",
    inputSchema: z.object({
      transferOrderId: UUID.describe("Transfer order id from list_inventory_transfer_orders."),
      date: DATE.optional().describe(
        "Shipment business date; omitted uses the organization's current business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const orgId = context.authz.user.orgId;
      const request = { id: input.transferOrderId, date: input.date };
      try {
        const result = await withOrgTransaction(orgId, async () => {
          const row = (
            await db.execute<{ subsidiaryId: string | null }>(
              sql`select subsidiary_id as "subsidiaryId" from transfer_orders where org_id = ${orgId} and id = ${input.transferOrderId} for update`,
              "objects",
            )
          )[0];
          if (
            !row?.subsidiaryId ||
            (context.authz.allowedSubsidiaryIds !== null &&
              !context.authz.allowedSubsidiaryIds.has(row.subsidiaryId))
          )
            throw notFound("transfer order");
          return executeMovement(
            context,
            "inventory.transfer-order.ship",
            input.idempotencyKey,
            request,
            () =>
              shipTransferOrder(orgId, context.authz.user.id, input.transferOrderId, input.date),
          );
        });
        return { ...result, href: "/inventory?view=transfers" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "receive_inventory_transfer_order",
    title: "Receive Inventory Transfer Order",
    description:
      "Receive an in-transit transfer order at its destination warehouse. Find its id with list_inventory_transfer_orders and verify the received status there.",
    inputSchema: z.object({
      transferOrderId: UUID.describe("Transfer order id from list_inventory_transfer_orders."),
      date: DATE.optional().describe(
        "Receipt business date; omitted uses the organization's current business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const orgId = context.authz.user.orgId;
      const request = { id: input.transferOrderId, date: input.date };
      try {
        const result = await withOrgTransaction(orgId, async () => {
          const row = (
            await db.execute<{ subsidiaryId: string | null }>(
              sql`select subsidiary_id as "subsidiaryId" from transfer_orders where org_id = ${orgId} and id = ${input.transferOrderId} for update`,
              "objects",
            )
          )[0];
          if (
            !row?.subsidiaryId ||
            (context.authz.allowedSubsidiaryIds !== null &&
              !context.authz.allowedSubsidiaryIds.has(row.subsidiaryId))
          )
            throw notFound("transfer order");
          return executeMovement(
            context,
            "inventory.transfer-order.receive",
            input.idempotencyKey,
            request,
            () =>
              receiveTransferOrder(orgId, context.authz.user.id, input.transferOrderId, input.date),
          );
        });
        return { ...result, href: "/inventory?view=transfers" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "post_landed_cost_voucher",
    title: "Post Landed Cost Voucher",
    description:
      "Post freight or another landed cost across multiple stocked item locations using value, quantity, weight or manually supplied exact amounts. Find the account and target positions through inventory reads, then verify with list_landed_cost_vouchers.",
    inputSchema: z.object({
      freightAccountId: UUID.describe("Credit account for the landed cost."),
      amount: AMOUNT.describe("Exact total landed cost."),
      basis: z
        .enum(["value", "quantity", "weight", "manual"])
        .optional()
        .describe("How the amount is allocated; defaults to value."),
      subsidiaryId: UUID.optional().describe(
        "Legal entity owning the target stock; omitted uses the configured default entity.",
      ),
      voucherDate: DATE.optional().describe(
        "Voucher date; omitted uses the organization's current business date.",
      ),
      sourceDocumentLineId: UUID.nullable()
        .optional()
        .describe("Receipt source line when this cost belongs to a specific receipt."),
      memo: z.string().max(500).nullable().optional().describe("Voucher memo."),
      targets: z
        .array(
          z
            .object({
              itemId: UUID.describe("Target item id."),
              stockLocationId: UUID.describe("Target stock location id."),
              manualAmount: AMOUNT.nullable()
                .optional()
                .describe("Exact allocation when basis is manual."),
            })
            .describe("One landed cost allocation target."),
        )
        .min(1)
        .max(2000)
        .describe("Stock positions that receive the capitalized cost."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const request = {
        amount: input.amount,
        basis: input.basis ?? "value",
        freightAccountId: input.freightAccountId,
        subsidiaryId,
        voucherDate: input.voucherDate ?? (await businessToday(context.authz.user.orgId)),
        sourceDocumentLineId: input.sourceDocumentLineId ?? null,
        memo: input.memo ?? null,
        targets: input.targets.map((target) => ({
          itemId: target.itemId,
          stockLocationId: target.stockLocationId,
          manualAmount: target.manualAmount ?? null,
        })),
      };
      const result = await executeMovement(
        context,
        "inventory.landed-voucher.post",
        input.idempotencyKey,
        request,
        () => postLandedCostVoucher(context.authz.user.orgId, context.authz.user.id, request),
      );
      return { ...result, href: "/inventory?view=landed" };
    },
  }),
  definition({
    name: "reverse_landed_cost_voucher",
    title: "Reverse Landed Cost Voucher",
    description:
      "Reverse a posted landed-cost voucher only when its exact allocations remain reversible, preserving the original voucher and journal. Find the voucher id with list_landed_cost_vouchers and verify the reversal there.",
    inputSchema: z.object({
      voucherId: UUID.describe("Posted voucher id from list_landed_cost_vouchers."),
      date: DATE.describe("Reversal business date."),
      reason: z.string().min(5).max(500).describe("Reason for reversing the voucher."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.reverse"),
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.reverse");
      const orgId = context.authz.user.orgId;
      const request = { id: input.voucherId, date: input.date, reason: input.reason };
      try {
        const row = (
          await db.execute<{ subsidiaryId: string | null }>(
            sql`select subsidiary_id as "subsidiaryId" from landed_cost_vouchers where org_id = ${orgId} and id = ${input.voucherId}`,
            "objects",
          )
        )[0];
        if (
          !row?.subsidiaryId ||
          (context.authz.allowedSubsidiaryIds !== null &&
            !context.authz.allowedSubsidiaryIds.has(row.subsidiaryId))
        )
          throw notFound("landed-cost voucher");
        const result = await executeMovement(
          context,
          "inventory.landed-voucher.reverse",
          input.idempotencyKey,
          request,
          () =>
            reverseLandedCostVoucher(orgId, context.authz.user.id, {
              voucherId: input.voucherId,
              reversalDate: input.date,
              reason: input.reason,
            }),
        );
        return { ...result, href: "/inventory?view=landed" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
