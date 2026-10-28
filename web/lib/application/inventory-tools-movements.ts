import "server-only";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  receiveInventory,
  issueInventory,
  adjustInventory,
} from "@openbooks/engine/inventory/movements";
import { transferInventory } from "@openbooks/engine/inventory/transfers";
import { buildAssembly } from "@openbooks/engine/inventory/assembly";
import {
  disassembleAssembly,
  reverseAssemblyDisassembly,
  moveConsignment,
  setStockHold,
} from "@openbooks/engine/inventory";
import { postLandedCostVoucher } from "@openbooks/engine/inventory/landed-cost";
import { reverseInventoryMovement } from "@openbooks/engine/inventory/reversal";
import { reverseAssemblyBuild } from "@openbooks/engine/inventory/assembly";
import { inventoryMovementReversalScope } from "@openbooks/engine/inventory/movement-queries";
import { reverseMaterialIssue } from "@openbooks/engine/manufacturing/completion";
import { executeIdempotentInventoryAction } from "@openbooks/engine/inventory/action-idempotency";
import { ensureLot, ensureSerial } from "@openbooks/engine/inventory/tracking";
import {
  SubsidiaryError,
  defaultPostingSubsidiaryId,
  loadSubsidiaryContext,
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
  .describe("Exact non-negative decimal string with up to four places.");
const SIGNED_AMOUNT = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact signed decimal string with up to four places.");
const visiblePost = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.post");
const visibleManage = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.manage");

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
        throw invalidInput("No subsidiary is configured for inventory posting.", {
          remedy: "Configure a subsidiary in Company Settings before posting inventory.",
        });
      throw error;
    }
  }
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed !== null && !allowed.has(subsidiaryId)) throw forbidden("subsidiary.restricted");
  return subsidiaryId;
}

async function runMovement<T extends object>(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  operation: string,
  idempotencyKey: string,
  request: unknown,
  execute: () => Promise<T>,
): Promise<{ ok: true; replayed: boolean } & T> {
  try {
    const outcome = await executeIdempotentInventoryAction(
      context.authz.user.orgId,
      context.authz.user.id,
      { operation, idempotencyKey, request, execute },
    );
    return { ok: true, replayed: outcome.replayed, ...outcome.value };
  } catch (error) {
    settleInventoryRefusal(error);
  }
}

function movementTool<T extends z.ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  execute: (
    context: Parameters<ApplicationToolDefinition["execute"]>[0],
    input: z.infer<T>,
  ) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    ...args,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
  });
}

const commonMovement = {
  itemId: UUID.describe("Item id from search_items or get_item."),
  stockLocationId: UUID.describe("Stock location id from inventory reads."),
  subsidiaryId: UUID.optional().describe(
    "Legal entity that owns the stock; omitted uses the configured default entity.",
  ),
  date: DATE.optional().describe(
    "Business date; omitted uses the organization's current business date.",
  ),
  quantity: AMOUNT.describe("Positive base-unit quantity as an exact decimal string."),
  lotId: UUID.nullable().optional().describe("Lot id for a lot-tracked item."),
  serialId: UUID.nullable().optional().describe("Serial id for a serial-tracked item."),
  memo: z.string().max(500).nullable().optional().describe("Audit memo for the movement."),
};

export const INVENTORY_MOVEMENT_TOOLS: ApplicationToolDefinition[] = [
  movementTool({
    name: "receive_inventory_stock",
    title: "Receive Inventory Stock",
    description:
      "Post a valued stock receipt to a location using the item's costing method. Find the item, stock location, account and legal entity through native reads, then verify the movement in inventory history.",
    inputSchema: z.object({
      ...commonMovement,
      unitCost: AMOUNT.describe("Exact unit cost for the received base-unit quantity."),
      offsetAccountId: UUID.describe("Credit account for the receipt."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        quantity: input.quantity,
        unitCost: input.unitCost,
        subsidiaryId,
        offsetAccountId: input.offsetAccountId,
        date,
        lotId: input.lotId ?? undefined,
        serialId: input.serialId ?? undefined,
        memo: input.memo ?? null,
      };
      const result = await runMovement(
        context,
        "inventory.receive",
        input.idempotencyKey,
        request,
        () => receiveInventory(context.authz.user.orgId, context.authz.user.id, request),
      );
      return {
        ...result,
        href: `/inventory?movement=${encodeURIComponent(String(result.movementId))}`,
      };
    },
  }),
  movementTool({
    name: "issue_inventory_stock",
    title: "Issue Inventory Stock",
    description:
      "Post a stock issue to consume the item's carried cost against its COGS account or a supplied offset. Find item and stock location ids through inventory reads, then verify the movement in inventory history.",
    inputSchema: z.object({
      ...commonMovement,
      offsetAccountId: UUID.nullable()
        .optional()
        .describe("Optional debit account; omitted uses the item's COGS account."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        quantity: input.quantity,
        subsidiaryId,
        offsetAccountId: input.offsetAccountId ?? undefined,
        date,
        lotId: input.lotId ?? undefined,
        serialId: input.serialId ?? undefined,
        memo: input.memo ?? null,
      };
      const result = await runMovement(
        context,
        "inventory.issue",
        input.idempotencyKey,
        request,
        () => issueInventory(context.authz.user.orgId, context.authz.user.id, request),
      );
      return {
        ...result,
        href: `/inventory?movement=${encodeURIComponent(String(result.movementId))}`,
      };
    },
  }),
  movementTool({
    name: "adjust_inventory_stock",
    title: "Adjust Inventory Stock",
    description:
      "Post a signed stock quantity adjustment against the item's configured adjustment or COGS account. Use a positive decimal to increase stock and a negative decimal to reduce it; verify the result in inventory history.",
    inputSchema: z.object({
      itemId: commonMovement.itemId,
      stockLocationId: commonMovement.stockLocationId,
      subsidiaryId: commonMovement.subsidiaryId,
      date: commonMovement.date,
      quantityDelta: SIGNED_AMOUNT.describe("Signed base-unit quantity change; zero is refused."),
      unitCost: AMOUNT.optional().describe(
        "Exact unit cost for a positive adjustment when no cost basis exists.",
      ),
      lotId: commonMovement.lotId,
      serialId: commonMovement.serialId,
      memo: commonMovement.memo,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        quantityDelta: input.quantityDelta,
        unitCost: input.unitCost,
        subsidiaryId,
        date,
        lotId: input.lotId ?? undefined,
        serialId: input.serialId ?? undefined,
        memo: input.memo ?? null,
      };
      const result = await runMovement(
        context,
        "inventory.adjust",
        input.idempotencyKey,
        request,
        () => adjustInventory(context.authz.user.orgId, context.authz.user.id, request),
      );
      return {
        ...result,
        href: `/inventory?movement=${encodeURIComponent(String(result.movementId))}`,
      };
    },
  }),
  movementTool({
    name: "transfer_inventory_stock",
    title: "Transfer Inventory Stock",
    description:
      "Move on-hand stock between two stock locations while preserving its carried value. Find source and destination location ids through inventory reads and verify both movement legs in inventory history.",
    inputSchema: z.object({
      itemId: commonMovement.itemId,
      stockLocationId: commonMovement.stockLocationId,
      toStockLocationId: UUID.describe("Destination stock location id."),
      subsidiaryId: commonMovement.subsidiaryId,
      date: commonMovement.date,
      quantity: commonMovement.quantity,
      lotId: commonMovement.lotId,
      serialId: commonMovement.serialId,
      memo: commonMovement.memo,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        itemId: input.itemId,
        fromStockLocationId: input.stockLocationId,
        toStockLocationId: input.toStockLocationId,
        quantity: input.quantity,
        lotId: input.lotId ?? undefined,
        serialId: input.serialId ?? undefined,
        subsidiaryId,
        date,
        memo: input.memo ?? null,
      };
      const result = await runMovement(
        context,
        "inventory.transfer",
        input.idempotencyKey,
        request,
        () => transferInventory(context.authz.user.orgId, context.authz.user.id, request),
      );
      return { ...result, href: "/inventory" };
    },
  }),
  movementTool({
    name: "build_assembly_stock",
    title: "Build Assembly Stock",
    description:
      "Build an assembly quantity from its effective bill of materials and capitalize the consumed component cost. Find the assembly and location through inventory reads, then verify the resulting movement in inventory history.",
    inputSchema: z.object({
      itemId: UUID.describe("Assembly item id from get_item."),
      stockLocationId: UUID.describe("Stock location where the assembly is built."),
      subsidiaryId: UUID.optional().describe(
        "Legal entity that owns the stock; omitted uses the configured default entity.",
      ),
      date: DATE.optional().describe(
        "Business date; omitted uses the organization's current business date.",
      ),
      quantity: AMOUNT.describe("Positive number of assemblies as an exact decimal string."),
      memo: z.string().max(500).nullable().optional().describe("Build memo."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const date = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        assemblyItemId: input.itemId,
        quantity: input.quantity,
        stockLocationId: input.stockLocationId,
        subsidiaryId,
        date,
        memo: input.memo ?? null,
      };
      const result = await runMovement(
        context,
        "inventory.build",
        input.idempotencyKey,
        request,
        () => buildAssembly(context.authz.user.orgId, context.authz.user.id, request),
      );
      return {
        ...result,
        href: `/inventory?movement=${encodeURIComponent(String(result.movementId))}`,
      };
    },
  }),
  movementTool({
    name: "post_landed_cost_adjustment",
    title: "Post Landed Cost Adjustment",
    description:
      "Capitalize freight or another landed cost onto one stocked item and location using value or quantity allocation. Find the freight account, stock location and item through native reads, then verify the posted voucher in inventory history.",
    inputSchema: z.object({
      itemId: UUID.describe("Target item id."),
      stockLocationId: UUID.describe("Target stock location id."),
      subsidiaryId: UUID.optional().describe(
        "Legal entity that owns the stock; omitted uses the configured default entity.",
      ),
      date: DATE.optional().describe(
        "Voucher business date; omitted uses the organization's current business date.",
      ),
      amount: AMOUNT.describe("Exact total amount to capitalize."),
      basis: z
        .enum(["value", "quantity"])
        .optional()
        .describe("Allocation basis; defaults to value."),
      freightAccountId: UUID.describe("Credit account for the landed cost."),
      memo: z.string().max(500).nullable().optional().describe("Voucher memo."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      const subsidiaryId = await postingSubsidiary(context, input.subsidiaryId);
      const voucherDate = input.date ?? (await businessToday(context.authz.user.orgId));
      const request = {
        amount: input.amount,
        basis: input.basis ?? "value",
        freightAccountId: input.freightAccountId,
        subsidiaryId,
        voucherDate,
        memo: input.memo ?? null,
        targets: [{ itemId: input.itemId, stockLocationId: input.stockLocationId }],
      };
      const result = await runMovement(
        context,
        "inventory.landed",
        input.idempotencyKey,
        request,
        () => postLandedCostVoucher(context.authz.user.orgId, context.authz.user.id, request),
      );
      return { ...result, voucherId: result.id, href: "/inventory?view=landed" };
    },
  }),
  definition({
    name: "disassemble_assembly_stock",
    title: "Disassemble Assembly Stock",
    description:
      "Disassemble a previously posted assembly build and recover its component stock through the native reversal and cost allocation path. Find the build movement id in inventory history and verify the generated movements there.",
    inputSchema: z.object({
      buildMovementId: UUID.describe("Posted assembly build movement id."),
      date: DATE.describe("Reversal business date."),
      quantity: AMOUNT.describe("Positive assembly quantity to disassemble."),
      reason: z.string().min(5).max(500).describe("Reason for disassembling the build."),
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
      try {
        const outcome = await disassembleAssembly(context.authz.user.orgId, context.authz.user.id, {
          buildMovementId: input.buildMovementId,
          quantity: input.quantity,
          date: input.date,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        });
        return { ok: true, replayed: outcome.replayed, ...outcome.value, href: "/inventory" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "reverse_inventory_movement",
    title: "Reverse Inventory Movement",
    description:
      "Reverse a posted inventory movement through its governed stock and journal correction path. Find the movement id in inventory history and provide a reason and business date; verify the reversal in the same history.",
    inputSchema: z.object({
      movementId: UUID.describe("Posted movement id from inventory history."),
      date: DATE.describe("Reversal business date."),
      reason: z.string().min(5).max(500).describe("Reason for correcting the posted movement."),
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
      const source = await inventoryMovementReversalScope(orgId, input.movementId);
      const subsidiaryId = source?.subsidiary_id ?? null;
      if (
        !source ||
        (context.authz.allowedSubsidiaryIds !== null &&
          (!subsidiaryId || !context.authz.allowedSubsidiaryIds.has(subsidiaryId)))
      )
        throw notFound("inventory movement");
      const manufacturing = source.origin === "manufacturing";
      if (manufacturing) assertApplicationPermission(context, "manufacturing.manage");
      const assemblyLeg = source.kind === "assembly_build" || source.kind === "assembly_consume";
      const request = {
        movementId: input.movementId,
        reversalDate: input.date,
        reason: input.reason,
      };
      try {
        const result = await runMovement(
          context,
          "inventory.reverse",
          input.idempotencyKey,
          request,
          () => {
            if (source.kind === "assembly_disassembly" || source.kind === "assembly_recovery")
              return reverseAssemblyDisassembly(orgId, context.authz.user.id, request);
            if (manufacturing) return reverseMaterialIssue(orgId, context.authz.user.id, request);
            return assemblyLeg
              ? reverseAssemblyBuild(orgId, context.authz.user.id, request)
              : reverseInventoryMovement(orgId, context.authz.user.id, request);
          },
        );
        return { ...result, href: "/inventory" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "ensure_item_lot",
    title: "Ensure Item Lot",
    description:
      "Register or resolve one lot identity for an item before receiving or counting lot-tracked stock. Find the item id with get_item and verify the lot through inventory reads.",
    inputSchema: z.object({
      itemId: UUID.describe("Item id from get_item."),
      lotNumber: z.string().trim().min(1).max(200).describe("Lot number to register."),
      expiresOn: DATE.nullable()
        .optional()
        .describe("Lot expiry date, or null when it has no expiry."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visibleManage,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      try {
        const id = await ensureLot(
          context.authz.user.orgId,
          input.itemId,
          input.lotNumber,
          input.expiresOn ?? null,
          context.authz.user.id,
        );
        return { ok: true, lotId: id, href: "/inventory?view=lots" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "ensure_item_serial",
    title: "Ensure Item Serial",
    description:
      "Register or resolve one serial identity before receiving or counting serial-tracked stock. Find the item and stock location ids with inventory reads, then verify the serial through the lot and serial inventory view.",
    inputSchema: z.object({
      itemId: UUID.describe("Item id from get_item."),
      serialNumber: z.string().trim().min(1).max(200).describe("Serial number to register."),
      stockLocationId: UUID.nullable()
        .optional()
        .describe("Current stock location for the serial, if known."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visibleManage,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      try {
        const id = await ensureSerial(
          context.authz.user.orgId,
          input.itemId,
          input.serialNumber,
          input.stockLocationId ?? null,
          context.authz.user.id,
        );
        return { ok: true, serialId: id, href: "/inventory?view=lots" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "set_stock_hold",
    title: "Set Stock Hold",
    description:
      "Place a lot or serial on hold, or release a manual hold, with an audited reason. Find its id in inventory tracking reads; inspection holds require the inspection disposition workflow.",
    inputSchema: z.object({
      kind: z.enum(["lot", "serial"]).describe("Tracked stock identifier type."),
      id: UUID.describe("Lot or serial id from inventory tracking reads."),
      held: z.boolean().describe("true applies a manual hold; false releases it."),
      reason: z.string().min(5).max(500).describe("Reason for applying or releasing the hold."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visibleManage,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      const request = { kind: input.kind, id: input.id, held: input.held, reason: input.reason };
      try {
        const outcome = await executeIdempotentInventoryAction(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            operation: "inventory.hold",
            idempotencyKey: input.idempotencyKey,
            request,
            execute: () => setStockHold(context.authz.user.orgId, context.authz.user.id, request),
          },
        );
        return {
          ok: true,
          ...outcome.value,
          replayed: outcome.replayed,
          href: "/inventory?view=holds",
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "move_consignment_stock",
    title: "Move Consignment Stock",
    description:
      "Receive, transfer, return, or take ownership of stock held in vendor or customer consignment. Find the consignment stock, item, location, legal entity and accounts in inventory reads; verify the updated custody and any posted movement there.",
    inputSchema: z.object({
      action: z
        .enum(["receive", "transfer", "return", "take_ownership"])
        .describe("Consignment custody or ownership action."),
      stockId: UUID.optional().describe(
        "Existing consignment stock id for transfer, return or ownership-taking.",
      ),
      itemId: UUID.optional().describe("Item id for a new consignment receipt."),
      stockLocationId: UUID.optional().describe("Consignment stock location id."),
      subsidiaryId: UUID.optional().describe("Legal entity that owns the physical stock."),
      toStockLocationId: UUID.optional().describe(
        "Destination consignment stock location for a transfer.",
      ),
      quantity: AMOUNT.describe("Exact positive quantity string."),
      date: DATE.describe("Business date of the custody action."),
      reason: z.string().min(5).max(500).describe("Reason for the custody or ownership action."),
      lotId: UUID.nullable().optional().describe("Lot id when the item is lot-tracked."),
      serialId: UUID.nullable().optional().describe("Serial id when the item is serial-tracked."),
      unitCost: AMOUNT.optional().describe(
        "Exact unit cost when taking ownership creates owned inventory.",
      ),
      offsetAccountId: UUID.optional().describe(
        "Offset account required when ownership is recognized.",
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
      const request = {
        action: input.action,
        stockId: input.stockId,
        itemId: input.itemId,
        stockLocationId: input.stockLocationId,
        subsidiaryId: input.subsidiaryId,
        toStockLocationId: input.toStockLocationId,
        quantity: input.quantity,
        date: input.date,
        reason: input.reason,
        lotId: input.lotId ?? null,
        serialId: input.serialId ?? null,
        unitCost: input.unitCost,
        offsetAccountId: input.offsetAccountId,
      };
      try {
        const outcome = await executeIdempotentInventoryAction(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            operation: "inventory.consignment",
            idempotencyKey: input.idempotencyKey,
            request,
            execute: () =>
              moveConsignment(context.authz.user.orgId, context.authz.user.id, request),
          },
        );
        return {
          ok: true,
          ...outcome.value,
          replayed: outcome.replayed,
          href: "/inventory?view=consignment",
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
