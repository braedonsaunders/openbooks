import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import {
  createOperationInspection,
  recordQualityInspection,
  registerInspectionIdentifier,
} from "@openbooks/engine/manufacturing/quality-execution";
import { disposeQualityInspection } from "@openbooks/engine/manufacturing/quality-disposition";
import { readManufacturingInspection } from "@openbooks/engine/manufacturing/quality-workspace";
import { assertManufacturingInspectionScope } from "@openbooks/engine/manufacturing/quality-workspace";
import { inventoryTrackingOptions } from "@openbooks/engine/inventory/tracking-options";
import { getWorkOrder } from "@openbooks/engine/manufacturing/work-orders";
import {
  assertPermission,
  assertVisibleSubsidiary,
  runManufacturing,
  UUID,
  DATE,
  DECIMAL,
  IDEMPOTENCY_KEY,
  nativeIdempotencyKey,
  qualityHref,
} from "./manufacturing-tools-shared";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const MANAGE = (authz: Parameters<typeof can>[0]) => can(authz, "manufacturing.manage");
const READ = (authz: Parameters<typeof can>[0]) => can(authz, "manufacturing.read");

async function requireWorkOrder(context: Parameters<typeof assertPermission>[0], id: string) {
  const row = await getWorkOrder(db, context.authz.user.orgId, id);
  if (!row) throw notFound("work order");
  assertVisibleSubsidiary(context, row.subsidiaryId);
  return row;
}

async function authorizeInspectionReplay(
  context: Parameters<typeof assertPermission>[0],
  id: string,
) {
  await runManufacturing(context, async () => {
    await assertManufacturingInspectionScope(
      db,
      context.authz.user.orgId,
      id,
      context.authz.allowedSubsidiaryIds,
    );
  });
}

export const MANUFACTURING_QUALITY_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_operation_inspection",
    title: "Create Operation Inspection",
    description:
      "Create a pending quality inspection for a work-order operation and quantity. Copy work-order and operation ids from manufacturing reads; the order must be in an eligible state and its quality plan is snapshotted by the native service.",
    inputSchema: z.object({
      workOrderId: UUID("Work-order id from list_manufacturing_records"),
      operationId: UUID("Operation id from get_manufacturing_record"),
      quantity: DECIMAL.describe("Exact quantity presented for inspection."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: async (context, input) =>
      runManufacturing(context, async () => {
        await requireWorkOrder(context, input.workOrderId);
        await assertManufacturingInspectionScope(
          db,
          context.authz.user.orgId,
          nativeIdempotencyKey(input.idempotencyKey),
          context.authz.allowedSubsidiaryIds,
        );
      }),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        await requireWorkOrder(context, input.workOrderId);
        const row = await createOperationInspection(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.workOrderId,
          input.operationId,
          { id: nativeIdempotencyKey(input.idempotencyKey), quantity: input.quantity },
        );
        return { ok: true, ...row, href: qualityHref(String(row.id)) };
      });
    },
  }),
  definition({
    name: "record_quality_inspection",
    title: "Record Quality Inspection",
    description:
      "Record pass or fail measurements and an audit reason for a pending inspection. Copy the inspection id from list_manufacturing_inspections; required measurements, tracked quantities and inspection state are validated by the quality service.",
    inputSchema: z.object({
      id: UUID("Inspection id from list_manufacturing_inspections"),
      outcome: z.enum(["pass", "fail"]).describe("Inspection outcome."),
      measurements: z
        .record(z.string(), DECIMAL.describe("Exact measured value as a decimal string."))
        .describe("Measurement key to exact measured value."),
      reason: z.string().trim().min(5).max(500).describe("Reason for the inspection result."),
      quantity: DECIMAL.optional().describe(
        "Exact inspected quantity when the inspection supports partial quantity.",
      ),
      lotId: UUID("Lot id from inventory tracking reads").nullable().optional(),
      serialId: UUID("Serial id from inventory tracking reads").nullable().optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeInspectionReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const row = await recordQualityInspection(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          {
            command: "inspect",
            outcome: input.outcome,
            measurements: input.measurements,
            reason: input.reason,
            quantity: input.quantity,
            lotId: input.lotId,
            serialId: input.serialId,
          },
        );
        return { ok: true, ...row, href: qualityHref(input.id) };
      });
    },
  }),
  definition({
    name: "dispose_quality_inspection",
    title: "Dispose Quality Inspection",
    description:
      "Resolve a failed inspection as use-as-is, scrap or rework with an audit reason and idempotency key. Copy the inspection and optional routing or scrap-reason ids from manufacturing reads; native quality and inventory controls govern each disposition.",
    inputSchema: z.object({
      id: UUID("Inspection id from list_manufacturing_inspections"),
      action: z
        .enum(["use_as_is", "scrap", "rework"])
        .describe("Disposition for the failed inspection."),
      reason: z.string().trim().min(5).max(500).describe("Reason for the inspection disposition."),
      scrapReasonId: UUID("Active scrap-reason setup-record id").optional(),
      reworkRoutingId: UUID("Active routing id from list_manufacturing_records").optional(),
      reworkSequence: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Operation sequence on the selected rework routing."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeInspectionReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const row = await disposeQualityInspection(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          {
            command: "dispose",
            action: input.action,
            reason: input.reason,
            requestKey: nativeIdempotencyKey(input.idempotencyKey),
            scrapReasonId: input.scrapReasonId,
            reworkRoutingId: input.reworkRoutingId,
            reworkSequence: input.reworkSequence,
          },
        );
        return { ok: true, ...row, href: qualityHref(input.id) };
      });
    },
  }),
  definition({
    name: "register_inspection_identifier",
    title: "Register Inspection Identifier",
    description:
      "Register a lot or serial number against an inspection when inventory tracking requires a new identifier. Use get_manufacturing_inspection and its tracking choices first; existing identifiers should be selected rather than duplicated.",
    inputSchema: z.object({
      id: UUID("Inspection id from list_manufacturing_inspections"),
      kind: z.enum(["lot", "serial"]).describe("Identifier kind."),
      number: z.string().trim().min(1).max(200).describe("Lot or serial number to register."),
      expiresOn: DATE.nullable()
        .optional()
        .describe("Expiration date for a lot, or null when not applicable."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizeInspectionReplay(context, input.id),
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const row = await registerInspectionIdentifier(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          {
            kind: input.kind,
            number: input.number,
            expiresOn: input.expiresOn,
          },
        );
        return { ok: true, ...row, href: qualityHref(input.id) };
      });
    },
  }),
  definition({
    name: "get_inspection_tracking_options",
    title: "Get Inspection Tracking Options",
    description:
      "Find existing lot or serial identifiers and registration choices for an inspection's item. Copy the inspection id from list_manufacturing_inspections before selecting a tracked identifier.",
    inputSchema: z.object({
      id: UUID("Inspection id from list_manufacturing_inspections"),
      query: z.string().max(200).optional().describe("Search existing lot or serial numbers."),
      lotId: UUID("Selected lot id from a prior tracking-options read").optional(),
      selectedLotId: UUID("Selected lot id from a prior tracking-options read").optional(),
      selectedSerialId: UUID("Selected serial id from a prior tracking-options read").optional(),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: READ,
    featureKey: "manufacturing",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.read");
      return runManufacturing(context, async () => {
        const inspection = await readManufacturingInspection(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
        );
        const data = await inventoryTrackingOptions(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            itemId: inspection.itemId,
            q: input.query ?? "",
            lotId: input.lotId,
            selectedLotId: input.selectedLotId,
            selectedSerialId: input.selectedSerialId,
          },
        );
        return { ok: true, ...data, href: qualityHref(input.id) };
      });
    },
  }),
];
