import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import {
  checkWorkOrderCreateReplay,
  createWorkOrder,
  getWorkOrder,
  updateDraftWorkOrder,
  releaseWorkOrder,
  holdWorkOrder,
  resumeWorkOrder,
  startWorkOrder,
  cancelWorkOrder,
  startWorkOrderOperation,
  correctWorkOrderOperationStart,
  pauseWorkOrderOperation,
  resumeWorkOrderOperation,
  readWorkOrderReleaseReadiness,
  type WorkOrderInput,
  type WorkOrderPatch,
} from "@openbooks/engine/manufacturing/work-orders";
import { markWorkOrderDone, waiveMaterial } from "@openbooks/engine/manufacturing/completion";
import { recordNormalScrap } from "@openbooks/engine/manufacturing/scrap";
import { completeWorkOrderOperation } from "@openbooks/engine/manufacturing/materials";
import {
  executeManufacturingCompletionDateCorrection,
  executeManufacturingIssue,
  executeManufacturingReceipt,
} from "@openbooks/engine/manufacturing/execution";
import { proposeProductionLoss } from "@openbooks/engine/manufacturing/loss-disposition";
import { dispatchWorkOrderFlow } from "@/app/api/manufacturing/work-orders/_flows";
import { idempotentManufacturingCreate } from "@/app/api/manufacturing/_idempotent";
import {
  assertPermission,
  assertVisibleSubsidiary,
  runManufacturing,
  UUID,
  DATE,
  DECIMAL,
  IDEMPOTENCY_KEY,
  nativeIdempotencyKey,
  recordHref,
} from "./manufacturing-tools-shared";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const MANAGE = (authz: Parameters<typeof can>[0]) => can(authz, "manufacturing.manage");
const POST_AND_MANAGE = (authz: Parameters<typeof can>[0]) =>
  can(authz, "items.post") && can(authz, "manufacturing.manage");
const REQUEST_URL = "http://openbooks.local/api/manufacturing/work-orders";
const requestForKey = (key: string) =>
  new Request(REQUEST_URL, { headers: { "Idempotency-Key": nativeIdempotencyKey(key) } });

async function requireWorkOrder(context: Parameters<typeof assertPermission>[0], id: string) {
  const order = await getWorkOrder(db, context.authz.user.orgId, id);
  if (!order) throw notFound("work order");
  assertVisibleSubsidiary(context, order.subsidiaryId);
  return order;
}

async function authorizeOrderReplay(context: Parameters<typeof assertPermission>[0], id: string) {
  await runManufacturing(context, async () => {
    await requireWorkOrder(context, id);
  });
}

function orderOutput<T extends { id: string }>(order: T, id = order.id) {
  return { ok: true, ...order, href: recordHref("work-orders", id) };
}

const WORK_ORDER_PATCH = z
  .object({
    quantityOrdered: DECIMAL.optional().describe("Exact ordered quantity as a decimal string."),
    productionMode: z
      .enum(["order", "batch", "continuous"])
      .optional()
      .describe("Production mode."),
    campaignReference: z
      .string()
      .trim()
      .max(100)
      .nullable()
      .optional()
      .describe("Optional production campaign reference."),
    issueLocationId: UUID("Component issue stock-location id").nullable().optional(),
    receiptLocationId: UUID("Finished-goods receipt stock-location id").nullable().optional(),
    plannedStart: DATE.nullable()
      .optional()
      .describe("Planned production start date, or null to clear."),
    plannedEnd: DATE.nullable()
      .optional()
      .describe("Planned production end date, or null to clear."),
    routingId: UUID("Routing id from manufacturing records").nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0)
  .describe("Fields to change on the draft work order.");

export const MANUFACTURING_WORK_ORDER_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_work_order",
    title: "Create Work Order",
    description:
      "Create a draft order or batch for an active manufactured item and legal entity. Use item, routing and manufacturing-option reads for ids; then review the draft and release it when BOM, routing, material and approval requirements are ready.",
    inputSchema: z.object({
      producedItemId: UUID("Produced item id from item reads"),
      quantityOrdered: DECIMAL.describe("Exact production quantity as a decimal string."),
      subsidiaryId: UUID("Legal-entity id from manufacturing options"),
      productionMode: z
        .enum(["order", "batch", "continuous"])
        .optional()
        .describe("Production mode."),
      campaignReference: z
        .string()
        .trim()
        .max(100)
        .nullable()
        .optional()
        .describe("Optional production campaign reference."),
      issueLocationId: UUID("Component issue stock-location id").nullable().optional(),
      receiptLocationId: UUID("Finished-goods receipt stock-location id").nullable().optional(),
      plannedStart: DATE.nullable().optional().describe("Planned production start date."),
      plannedEnd: DATE.nullable().optional().describe("Planned production end date."),
      routingId: UUID("Routing id from list_manufacturing_records").nullable().optional(),
      priority: z
        .enum(["low", "normal", "high", "rush"])
        .optional()
        .describe("Work-order priority."),
      source: z
        .enum(["manual", "sales_order"])
        .optional()
        .describe("Manual order or linked sales-order demand."),
      sourceRefId: UUID("Source sales-order line id").nullable().optional(),
      operatingProfile: z
        .string()
        .nullable()
        .optional()
        .describe("Operating-profile key when explicitly selected."),
      operatingDepartmentId: UUID("Department id from manufacturing options").nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: async (context, input) => {
      await runManufacturing(context, async () => {
        assertVisibleSubsidiary(context, input.subsidiaryId);
        await checkWorkOrderCreateReplay(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          nativeIdempotencyKey(input.idempotencyKey),
          context.authz.allowedSubsidiaryIds,
        );
      });
    },
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertVisibleSubsidiary(context, input.subsidiaryId);
      return runManufacturing(context, async () => {
        const { idempotencyKey, ...payload } = input;
        const orgId = context.authz.user.orgId;
        const row = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(idempotencyKey),
          table: "mfg_work_orders",
          match: payload,
          create: (id, requestId) =>
            createWorkOrder(db, orgId, context.authz.user.id, payload as WorkOrderInput, {
              id,
              requestId,
            }),
          load: () =>
            checkWorkOrderCreateReplay(
              db,
              orgId,
              context.authz.user.id,
              nativeIdempotencyKey(idempotencyKey),
              context.authz.allowedSubsidiaryIds,
            ),
        });
        return orderOutput(row as Record<string, unknown> & { id: string });
      });
    },
  }),
  definition({
    name: "update_draft_work_order",
    title: "Update Draft Work Order",
    description:
      "Change a draft work order's quantity, schedule, production mode, routing or locations. Copy its id from list_manufacturing_records; released, held, pending-approval and completed orders refuse edits.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      patch: WORK_ORDER_PATCH,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return orderOutput(
          await updateDraftWorkOrder(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
            input.patch as WorkOrderPatch,
          ),
        );
      });
    },
  }),
  definition({
    name: "get_work_order_release_readiness",
    title: "Get Work Order Release Readiness",
    description:
      "Check configured materials, routing, approvals, inspections and locations before releasing a draft work order. Copy the id from list_manufacturing_records; every finding includes its supported remedy.",
    inputSchema: z.object({ id: UUID("Work-order id from list_manufacturing_records") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return {
          ok: true,
          ...(await readWorkOrderReleaseReadiness(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
          )),
          href: recordHref("work-orders", input.id),
        };
      });
    },
  }),
  definition({
    name: "release_work_order",
    title: "Release Work Order",
    description:
      "Release a ready draft work order to production, allowing configured approvals to leave it pending. Read the work order and release-readiness result first; provide a reason as required by the native lifecycle.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      reason: z
        .string()
        .trim()
        .max(500)
        .nullable()
        .describe("Reason for releasing the work order, or null when none is needed."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const order = await requireWorkOrder(context, input.id);
        const row = order.pendingApproval
          ? order
          : await releaseWorkOrder(db, context.authz.user.orgId, context.authz.user.id, input.id, {
              reason: input.reason,
            });
        return orderOutput(row as Record<string, unknown> & { id: string });
      });
    },
  }),
  definition({
    name: "hold_work_order",
    title: "Hold Work Order",
    description:
      "Place a released or in-progress work order on hold with a documented reason. Read the order first; the hold may dispatch configured status-change approval flows.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("Quality, material or operating reason for the hold."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const before = await requireWorkOrder(context, input.id);
        if (before.status === "on_hold")
          return orderOutput(before as Record<string, unknown> & { id: string });
        const row = await holdWorkOrder(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.reason,
        );
        await dispatchWorkOrderFlow(
          { kind: "status_change", from: before.status, to: "on_hold" },
          input.id,
          context.authz.user.orgId,
          context.authz.user.id,
        );
        return orderOutput(row);
      });
    },
  }),
  definition({
    name: "resume_work_order",
    title: "Resume Work Order",
    description:
      "Resume a work order from its on-hold state using the retained prior status. Read the order first to confirm the hold reason and current lifecycle state.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return orderOutput(
          await resumeWorkOrder(db, context.authz.user.orgId, context.authz.user.id, input.id),
        );
      });
    },
  }),
  definition({
    name: "start_work_order",
    title: "Start Work Order",
    description:
      "Start a released work order after its materials and routing are ready. Copy its id from list_manufacturing_records; held, draft or terminal orders are refused by the lifecycle service.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return orderOutput(
          await startWorkOrder(db, context.authz.user.orgId, context.authz.user.id, input.id),
        );
      });
    },
  }),
  definition({
    name: "cancel_work_order",
    title: "Cancel Work Order",
    description:
      "Cancel an eligible draft, released or held work order with an explicit reason for released work. Read its postings and child orders first; posted manufacturing history must be reversed through governed inventory actions before cancellation.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      reason: z
        .string()
        .trim()
        .max(500)
        .nullable()
        .describe(
          "Why the work order is being cancelled; required by the service for released work.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return orderOutput(
          await cancelWorkOrder(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.id,
            input.reason,
          ),
        );
      });
    },
  }),
  definition({
    name: "issue_work_order_materials",
    title: "Issue Work Order Materials",
    description:
      "Issue exact component quantities from stock to an in-progress work order, with lot or serial identifiers when required. Use get_manufacturing_record to copy material ids and review remaining demand before posting.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      lines: z
        .array(
          z
            .object({
              materialId: UUID("Material requirement id from get_manufacturing_record"),
              quantity: DECIMAL.describe("Exact quantity to issue as a decimal string."),
              lotId: UUID("Lot id from inventory tracking reads").nullable().optional(),
              serialId: UUID("Serial id from inventory tracking reads").nullable().optional(),
            })
            .strict()
            .describe("One material issue line."),
        )
        .min(1)
        .max(500)
        .describe("Components and quantities to issue."),
      issuedOn: DATE.nullable()
        .optional()
        .describe("Issue date, or null to use the business date."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const result = await executeManufacturingIssue(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          input.id,
          nativeIdempotencyKey(input.idempotencyKey),
          input.lines,
          input.issuedOn ?? null,
        );
        return {
          ok: true,
          ...result.value,
          replayed: result.replayed,
          href: recordHref("work-orders", input.id),
        };
      });
    },
  }),
  definition({
    name: "complete_work_order",
    title: "Report Work Order Production",
    description:
      "Report finished-goods quantity against an in-progress work order, assigning receipt location and required lot, serial, component-selection or by-product valuation evidence. Read the work order first; the native receipt validates stock and accounting policy.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      quantity: DECIMAL.describe("Exact finished quantity as a decimal string."),
      receiptLocationId: UUID("Finished-goods receipt stock-location id").nullable().optional(),
      receivedOn: DATE.nullable()
        .optional()
        .describe("Receipt date, or null to use the business date."),
      lots: z
        .array(
          z
            .object({
              itemId: UUID("Produced or by-product item id").optional(),
              quantity: DECIMAL.describe("Exact quantity for this tracked output."),
              lotNumber: z
                .string()
                .trim()
                .min(1)
                .max(200)
                .optional()
                .describe("New lot number when a lot is created."),
              expiresOn: DATE.nullable().optional().describe("Lot expiration date."),
              serialNumber: z
                .string()
                .trim()
                .min(1)
                .max(200)
                .optional()
                .describe("New serial number when a serial is created."),
            })
            .strict()
            .describe("Lot or serial assignment for a receipt line."),
        )
        .max(200)
        .optional()
        .describe("Tracking assignments for produced output."),
      componentSelections: z
        .array(
          z
            .object({
              movementId: UUID("Unassigned component issue movement id from the work-order read"),
              quantity: DECIMAL.describe("Exact quantity of the issue to allocate."),
            })
            .strict()
            .describe("Component issue allocation."),
        )
        .min(1)
        .max(500)
        .optional()
        .describe("Explicit issue-to-receipt allocations when automatic allocation is ambiguous."),
      byproductValues: z
        .array(
          z
            .object({
              itemId: UUID("By-product item id"),
              nrvUnit: DECIMAL.describe("Exact net realizable value per unit."),
              reason: z
                .string()
                .trim()
                .min(5)
                .max(500)
                .describe("Reason for the by-product value."),
            })
            .strict()
            .describe("Valuation evidence for one by-product."),
        )
        .max(100)
        .optional()
        .describe("Required values for uncosted by-products."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const { id, idempotencyKey, ...payload } = input;
        const result = await executeManufacturingReceipt(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          id,
          nativeIdempotencyKey(idempotencyKey),
          payload,
        );
        return {
          ok: true,
          ...result.value,
          replayed: result.replayed,
          href: recordHref("work-orders", id),
        };
      });
    },
  }),
  definition({
    name: "mark_work_order_done",
    title: "Complete Work Order",
    description:
      "Close production on a work order after receipts and required inspections are complete. Use an explicit short-close reason when output is below the governed completion tolerance; read the work order first.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      shortCloseReason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .nullable()
        .optional()
        .describe("Required explanation when closing below the allowed completion quantity."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        return orderOutput(
          await markWorkOrderDone(db, context.authz.user.orgId, context.authz.user.id, input.id, {
            shortCloseReason: input.shortCloseReason,
          }),
        );
      });
    },
  }),
  definition({
    name: "record_work_order_scrap",
    title: "Record Work Order Scrap",
    description:
      "Record normal in-process scrap before the first finished-goods receipt, with its operation and configured scrap reason. Copy the operation and reason ids from manufacturing reads or setup records; abnormal loss uses the governed production-loss command.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      quantity: DECIMAL.describe("Exact quantity scrapped as a decimal string."),
      reasonId: UUID("Active scrap-reason setup-record id"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await recordNormalScrap(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          input.id,
          nativeIdempotencyKey(input.idempotencyKey),
          { operationId: input.operationId, quantity: input.quantity, reasonId: input.reasonId },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "waive_work_order_material",
    title: "Waive Work Order Material",
    description:
      "Waive a draft work-order material requirement with a documented reason when the native shortage policy permits it. Copy the work order and material ids from get_manufacturing_record.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      materialId: UUID("Material requirement id from get_manufacturing_record"),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason the material requirement is waived."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await waiveMaterial(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.materialId,
          input.reason,
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "start_work_order_operation",
    title: "Start Work Order Operation",
    description:
      "Start one operation on a released or in-progress work order and record the actual start date. Use get_manufacturing_record to copy the operation id and check its predecessor and quality-gate state.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      startedOn: DATE.nullable().describe(
        "Actual operation start date, or null for the current business date.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await startWorkOrderOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.operationId,
          { startedOn: input.startedOn },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "pause_work_order_operation",
    title: "Pause Work Order Operation",
    description:
      "Pause a running work-order operation with a reason. Copy its id from get_manufacturing_record; the order remains in progress and the pause is retained in operation history.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      reason: z.string().trim().min(1).max(500).describe("Reason the operation is paused."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await pauseWorkOrderOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.operationId,
          input.reason,
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "resume_work_order_operation",
    title: "Resume Work Order Operation",
    description:
      "Resume a paused work-order operation after its blocker is addressed. Read the work order and operation first; open inspection and material gates remain enforced by the native service.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await resumeWorkOrderOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.operationId,
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "complete_work_order_operation",
    title: "Report Operation Production",
    description:
      "Report completed quantity, measured quantity, setup time, run time, labor time and completion date for an operation. Copy ids from get_manufacturing_record; predecessor, inspection, capacity and decimal validations remain active.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      doneQty: DECIMAL.describe("Exact completed quantity as a decimal string."),
      measuredQty: DECIMAL.nullable()
        .optional()
        .describe("Exact measured quantity for quality-gated operations."),
      actualSetupMinutes: DECIMAL.nullable().optional().describe("Actual setup minutes."),
      actualRunMinutes: DECIMAL.nullable().optional().describe("Actual run minutes."),
      actualLaborMinutes: DECIMAL.nullable().optional().describe("Actual labor minutes."),
      completedOn: DATE.nullable()
        .optional()
        .describe("Operation completion date, or null for the business date."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const { id, operationId, idempotencyKey: _key, ...payload } = input;
        const row = await completeWorkOrderOperation(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          id,
          operationId,
          payload,
        );
        return { ok: true, ...row, href: recordHref("work-orders", id) };
      });
    },
  }),
  definition({
    name: "correct_work_order_operation_start",
    title: "Correct Work Order Operation Start",
    description:
      "Correct an in-progress operation's recorded start to the earlier date it actually began, with a reason. Use get_manufacturing_record to copy ids and review any later completed operations first.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      startedOn: DATE.describe("Corrected actual start date."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason for correcting the recorded start."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const row = await correctWorkOrderOperationStart(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.operationId,
          { startedOn: input.startedOn, reason: input.reason },
        );
        return { ok: true, ...row, href: recordHref("work-orders", input.id) };
      });
    },
  }),
  definition({
    name: "correct_work_order_completion_date",
    title: "Correct Work Order Completion Date",
    description:
      "Re-date finished-goods receipts to the actual day production finished, with an audit reason. Copy the id from list_manufacturing_records; the service checks receipt history, period status and subsidiary scope before correcting the posting.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      correctedOn: DATE.describe("Actual production completion date."),
      reason: z
        .string()
        .trim()
        .min(5)
        .max(500)
        .describe("Reason the completion date is being corrected."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: POST_AND_MANAGE,
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const result = await executeManufacturingCompletionDateCorrection(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          input.id,
          nativeIdempotencyKey(input.idempotencyKey),
          { correctedOn: input.correctedOn, reason: input.reason },
        );
        return {
          ok: true,
          ...result.value,
          replayed: result.replayed,
          href: recordHref("work-orders", input.id),
        };
      });
    },
  }),
  definition({
    name: "propose_production_loss",
    title: "Propose Production Loss",
    description:
      "Submit an abnormal production-loss proposal with operation, scrap reason, quantity, audit reason and recorded times. Read the work order and operation first; approval and variance accounting remain controlled by the native loss workflow.",
    inputSchema: z.object({
      id: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      reasonId: UUID("Active scrap-reason setup-record id"),
      quantity: DECIMAL.describe("Exact quantity lost as a decimal string."),
      reason: z
        .string()
        .trim()
        .min(8)
        .max(1000)
        .describe("Business reason for the abnormal production loss."),
      times: z
        .array(
          z
            .object({
              operationId: UUID("Operation id from get_manufacturing_record"),
              attemptedQty: DECIMAL.describe("Exact attempted quantity."),
              actualSetupMinutes: DECIMAL.describe("Actual setup time."),
              actualRunMinutes: DECIMAL.describe("Actual run time."),
              actualLaborMinutes: DECIMAL.nullable()
                .optional()
                .describe("Actual labor time, if tracked separately."),
            })
            .strict()
            .describe("Production time evidence for one operation."),
        )
        .max(500)
        .describe("Time evidence for the loss proposal."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.post"),
    authorizeReplay: (context, input) => authorizeOrderReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "items.post");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.id);
        const { id, idempotencyKey, ...payload } = input;
        const row = await proposeProductionLoss(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          id,
          { ...payload, requestKey: nativeIdempotencyKey(idempotencyKey) },
        );
        const changeId = "changeId" in row ? String(row.changeId) : undefined;
        return {
          ok: true,
          ...row,
          href: changeId
            ? `/accounting/changes?change=${encodeURIComponent(changeId)}`
            : recordHref("work-orders", id),
        };
      });
    },
  }),
];
