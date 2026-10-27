import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { db } from "@openbooks/engine/platform/db";
import {
  confirmPlannedOrder,
  dismissPlannedOrder,
  findMrpRunRecord,
  getPlannedOrder,
  runMrp,
} from "@openbooks/engine/manufacturing/mrp";
import { idempotentManufacturingCreate } from "@/app/api/manufacturing/_idempotent";
import { convertManufacturingPlannedOrder } from "@/lib/manufacturing/planned-order-conversion";
import {
  assertPermission,
  assertVisibleSubsidiary,
  runManufacturing,
  UUID,
  IDEMPOTENCY_KEY,
  nativeIdempotencyKey,
} from "./manufacturing-tools-shared";
import { notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const MANAGE = (authz: Parameters<typeof can>[0]) => can(authz, "manufacturing.manage");
const REQUEST_URL = "http://openbooks.local/api/manufacturing/mrp/runs";
const requestForKey = (key: string) =>
  new Request(REQUEST_URL, { headers: { "Idempotency-Key": nativeIdempotencyKey(key) } });

async function plannedOrder(context: Parameters<typeof assertPermission>[0], id: string) {
  const row = await getPlannedOrder(db, context.authz.user.orgId, id);
  assertVisibleSubsidiary(context, row.subsidiaryId);
  return row;
}

async function authorizePlannedOrderReplay(
  context: Parameters<typeof assertPermission>[0],
  id: string,
) {
  await runManufacturing(context, async () => {
    await plannedOrder(context, id);
  });
}

function plannedOrderHref(runId: string | undefined) {
  return runId ? `/manufacturing/mrp?record=${encodeURIComponent(runId)}` : "/manufacturing/mrp";
}

export const MANUFACTURING_MRP_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "run_manufacturing_mrp",
    title: "Run Manufacturing MRP",
    description:
      "Calculate material and capacity requirements for one legal entity over the requested horizon and save its planned orders. Read item policies, stock and supply before running; use list_mrp_runs to find the saved run and suggestions.",
    inputSchema: z.object({
      subsidiaryId: UUID("Legal-entity id from manufacturing options"),
      horizonDays: z
        .number()
        .int()
        .min(1)
        .max(366)
        .optional()
        .describe("Planning horizon in days; defaults to 90."),
      capacityCheck: z
        .boolean()
        .optional()
        .describe("Include work-center capacity constraints; defaults to true."),
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
        const row = await findMrpRunRecord(
          db,
          context.authz.user.orgId,
          nativeIdempotencyKey(input.idempotencyKey),
          context.authz.user.id,
        );
        if (!row) throw notFound("MRP run");
        assertVisibleSubsidiary(context, String(row.parameters.subsidiaryId ?? ""));
      });
    },
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      assertVisibleSubsidiary(context, input.subsidiaryId);
      return runManufacturing(context, async () => {
        const orgId = context.authz.user.orgId;
        const match = {
          subsidiaryId: input.subsidiaryId,
          horizonDays: input.horizonDays ?? 90,
          capacityCheck: input.capacityCheck ?? true,
        };
        const run = await idempotentManufacturingCreate({
          orgId,
          actorId: context.authz.user.id,
          request: requestForKey(input.idempotencyKey),
          table: "mfg_mrp_runs",
          match,
          create: (id) => runMrp(db, orgId, context.authz.user.id, match, { id }),
          load: () =>
            findMrpRunRecord(
              db,
              orgId,
              nativeIdempotencyKey(input.idempotencyKey),
              context.authz.user.id,
            ),
        });
        return {
          ok: true,
          ...run,
          href: `/manufacturing/mrp?record=${encodeURIComponent(String(run.id))}`,
        };
      });
    },
  }),
  definition({
    name: "confirm_mrp_planned_order",
    title: "Firm MRP Planned Order",
    description:
      "Firm a suggested MRP planned order so it is retained for conversion. Copy the id from get_mrp_run; only a suggested order can be confirmed, and its legal-entity scope is checked before the change.",
    inputSchema: z.object({
      id: UUID("Planned-order id from get_mrp_run"),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizePlannedOrderReplay(context, input.id),
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const before = await plannedOrder(context, input.id);
        const row = await confirmPlannedOrder(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
        );
        return { ok: true, ...row, href: plannedOrderHref(before.run_id) };
      });
    },
  }),
  definition({
    name: "dismiss_mrp_planned_order",
    title: "Dismiss MRP Planned Order",
    description:
      "Dismiss an MRP suggestion that will not be converted and retain the decision reason. Copy the id from get_mrp_run; only an eligible suggested or confirmed order can be dismissed.",
    inputSchema: z.object({
      id: UUID("Planned-order id from get_mrp_run"),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe("Why the planned order is being dismissed."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: (context, input) => authorizePlannedOrderReplay(context, input.id),
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const before = await plannedOrder(context, input.id);
        const row = await dismissPlannedOrder(
          db,
          context.authz.user.orgId,
          context.authz.user.id,
          input.id,
          input.reason,
        );
        return { ok: true, ...row, href: plannedOrderHref(before.run_id) };
      });
    },
  }),
  definition({
    name: "convert_mrp_planned_order",
    title: "Convert MRP Planned Order",
    description:
      "Convert a saved make suggestion to a work order, a buy suggestion to a purchase-order draft, or a transfer suggestion to a transfer order. Copy the id from get_mrp_run; buy orders require a vendor and purchase_orders.create, while transfers require two distinct locations.",
    inputSchema: z.object({
      id: UUID("Planned-order id from get_mrp_run"),
      vendorId: UUID("Vendor id from manufacturing options").optional(),
      fromLocationId: UUID("Source stock-location id from manufacturing options").optional(),
      toLocationId: UUID("Destination stock-location id from manufacturing options").optional(),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: MANAGE,
    authorizeReplay: async (context, input) => {
      await runManufacturing(context, async () => {
        const suggestion = await plannedOrder(context, input.id);
        if (suggestion.action === "buy") assertPermission(context, "purchase_orders.create");
      });
    },
    featureKey: "manufacturingMrp",
    execute: async (context, input) => {
      assertPermission(context, "manufacturing.manage");
      return runManufacturing(context, async () => {
        const suggestion = await plannedOrder(context, input.id);
        if (suggestion.action === "buy") assertPermission(context, "purchase_orders.create");
        const result = await convertManufacturingPlannedOrder(context.authz, input.id, {
          vendorId: input.vendorId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
        });
        const href =
          result.action === "make"
            ? `/manufacturing/work-orders?record=${encodeURIComponent(result.id)}`
            : result.action === "buy"
              ? `/purchasing/purchase-orders?record=${encodeURIComponent(result.id)}`
              : `/inventory/transfers?record=${encodeURIComponent(result.id)}`;
        return { ok: true, ...result, href };
      });
    },
  }),
];
