import "server-only";
import { db } from "@openbooks/engine/platform/db";
import {
  cancelStockCount,
  createStockCount,
  executeScopedStockCountAction,
  postStockCount,
  recordCountedQuantity,
  recountStockCountLine,
  returnStockCountToCounting,
  setStockCountDate,
  startStockCount,
  submitStockCountForReview,
} from "@openbooks/engine/inventory/stock-counts";
import { recordSecondCount } from "@openbooks/engine/inventory";
import {
  getStockCountDetail,
  listStockCounts,
  stockCountSubsidiary,
} from "@openbooks/engine/inventory/stock-count-queries";
import { executeIdempotentInventoryAction } from "@openbooks/engine/inventory/action-idempotency";
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
import { z, type ZodTypeAny } from "zod";

const visibleRead = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.read");
const visiblePost = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "items.post");
const COUNT_HREF = (id?: string) =>
  id ? `/inventory/counts?count=${encodeURIComponent(id)}` : "/inventory/counts";
const QTY = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Exact counted quantity string; never use a JSON number.");

async function withCountScope(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  countId: string,
) {
  const orgId = context.authz.user.orgId;
  const subsidiaryId = await stockCountSubsidiary(orgId, countId);
  if (!subsidiaryId) throw notFound("stock count");
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed !== null && !allowed.has(subsidiaryId)) throw notFound("stock count");
  return subsidiaryId;
}

async function runCountAction<T>(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  input: { countId: string; idempotencyKey: string },
  operation: string,
  request: unknown,
  execute: () => Promise<T>,
): Promise<{ ok: true; replayed: boolean } & Record<string, unknown>> {
  assertApplicationPermission(context, "items.post");
  await withCountScope(context, input.countId);
  try {
    const outcome = await executeScopedStockCountAction({
      orgId: context.authz.user.orgId,
      actorId: context.authz.user.id,
      countId: input.countId,
      allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      operation,
      idempotencyKey: input.idempotencyKey,
      request,
      execute,
    });
    return { ok: true, replayed: outcome.replayed, ...(outcome.value as Record<string, unknown>) };
  } catch (error) {
    settleInventoryRefusal(error);
  }
}

function countMutation<T extends ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  destructive?: boolean;
  execute: (
    context: Parameters<ApplicationToolDefinition["execute"]>[0],
    input: z.infer<T>,
  ) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    ...args,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: visiblePost,
    featureKey: "inventory",
  });
}

export const INVENTORY_COUNT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_stock_counts",
    title: "List Stock Counts",
    description:
      "List cycle counts visible to the caller before starting or counting one. Use a returned id with get_stock_count.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).optional().describe("Maximum rows to return."),
      search: z.string().max(200).optional().describe("Search count number or memo."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visibleRead,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      return {
        ...(await listStockCounts(context.authz.user.orgId, {
          subsidiaryIds:
            context.authz.allowedSubsidiaryIds === null
              ? null
              : [...context.authz.allowedSubsidiaryIds],
          limit: input.limit,
          search: input.search,
        })),
        href: COUNT_HREF(),
      };
    },
  }),
  definition({
    name: "get_stock_count",
    title: "Get Stock Count",
    description:
      "Read a cycle count's status, expected quantities and recorded observations before acting. Find the count id with list_stock_counts; use list_approvals to find its review decision after submission.",
    inputSchema: z.object({ countId: UUID.describe("Count id from list_stock_counts.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: visibleRead,
    featureKey: "inventory",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      try {
        return {
          ok: true,
          ...(await getStockCountDetail(
            context.authz.user.orgId,
            input.countId,
            context.authz.allowedSubsidiaryIds,
          )),
          href: COUNT_HREF(input.countId),
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "create_stock_count",
    title: "Create Stock Count",
    description:
      "Open a draft cycle count with explicit item, stock location, lot or serial subjects. Find item and location ids through inventory reads; verify the snapshot with get_stock_count.",
    inputSchema: z.object({
      locationId: UUID.describe("Business location where the cycle count takes place."),
      subsidiaryId: UUID.optional().describe(
        "Owning subsidiary; omitted uses the same configured default as the inventory route.",
      ),
      date: DATE.describe("Count business date."),
      memo: z.string().max(500).nullable().optional().describe("Count purpose or notes."),
      blind: z
        .boolean()
        .optional()
        .describe("Hide expected quantities from counters; defaults to true."),
      lines: z
        .array(
          z
            .object({
              itemId: UUID.describe("Item id to count."),
              stockLocationId: UUID.describe("Stock location to count."),
              lotId: UUID.nullable().optional().describe("Lot id for a lot-tracked subject."),
              serialId: UUID.nullable()
                .optional()
                .describe("Serial id for a serial-tracked subject."),
            })
            .describe("One item/location/tracking subject."),
        )
        .min(1)
        .max(2000)
        .describe("Items and stock locations included in this count."),
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
      let subsidiaryId = input.subsidiaryId;
      try {
        if (!subsidiaryId)
          subsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
      } catch (error) {
        if (error instanceof SubsidiaryError)
          throw invalidInput("No subsidiary is configured for stock counts.", {
            remedy: "Configure a subsidiary in Company Settings before creating a count.",
          });
        throw error;
      }
      if (
        context.authz.allowedSubsidiaryIds !== null &&
        !context.authz.allowedSubsidiaryIds.has(subsidiaryId)
      )
        throw forbidden("subsidiary.restricted");
      const request = {
        locationId: input.locationId,
        subsidiaryId,
        countedOn: input.date,
        memo: input.memo ?? null,
        blind: input.blind ?? true,
        lines: input.lines.map((line) => ({
          itemId: line.itemId,
          stockLocationId: line.stockLocationId,
          lotId: line.lotId ?? null,
          serialId: line.serialId ?? null,
        })),
      };
      try {
        const outcome = await executeIdempotentInventoryAction(orgId, context.authz.user.id, {
          operation: "inventory.stock-count.create",
          idempotencyKey: input.idempotencyKey,
          request,
          execute: () => createStockCount(orgId, context.authz.user.id, request),
        });
        return {
          ok: true,
          replayed: outcome.replayed,
          ...outcome.value,
          href: COUNT_HREF(outcome.value.id),
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  countMutation({
    name: "start_stock_count",
    title: "Start Stock Count",
    description:
      "Start a draft cycle count so counters can record observations. Find the count id with list_stock_counts and verify its status with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => ({
      ...(await runCountAction(
        context,
        input,
        "inventory.stock-count.start",
        { countId: input.countId },
        () => startStockCount(context.authz.user.orgId, context.authz.user.id, input.countId),
      )),
      href: COUNT_HREF(input.countId),
    }),
  }),
  countMutation({
    name: "record_stock_count_quantity",
    title: "Record Stock Count Quantity",
    description:
      "Record an observed quantity for a count line while the count is in counting status. Find the line id and expected quantity with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      lineId: UUID.describe("Count line id from get_stock_count."),
      countedQuantity: QTY,
      memo: z.string().max(500).nullable().optional().describe("Counting note or reason."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const request = {
        countId: input.countId,
        lineId: input.lineId,
        countedQuantity: input.countedQuantity,
        reason: input.memo ?? null,
      };
      return {
        ...(await runCountAction(context, input, "inventory.stock-count.record", request, () =>
          recordCountedQuantity(context.authz.user.orgId, context.authz.user.id, request),
        )),
        href: COUNT_HREF(input.countId),
      };
    },
  }),
  countMutation({
    name: "record_second_stock_count",
    title: "Record Second Stock Count",
    description:
      "Record the independent second observation required when the count policy flags a variance. Find the line id and policy state with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      lineId: UUID.describe("Count line id from get_stock_count."),
      countedQuantity: QTY,
      memo: z
        .string()
        .max(500)
        .nullable()
        .optional()
        .describe("Reason for the second observation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const request = {
        countId: input.countId,
        lineId: input.lineId,
        countedQuantity: input.countedQuantity,
        reason: input.memo ?? null,
      };
      return {
        ...(await runCountAction(context, input, "inventory.stock-count.second", request, () =>
          recordSecondCount(context.authz.user.orgId, context.authz.user.id, request),
        )),
        href: COUNT_HREF(input.countId),
      };
    },
  }),
  countMutation({
    name: "request_stock_count_recount",
    title: "Request Stock Count Recount",
    description:
      "Request a fresh observation for one count line before submitting it for review. Find the line id with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      lineId: UUID.describe("Count line id from get_stock_count."),
      memo: z.string().max(500).nullable().optional().describe("Reason for the recount."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const request = { countId: input.countId, lineId: input.lineId, reason: input.memo ?? null };
      return {
        ...(await runCountAction(context, input, "inventory.stock-count.recount", request, () =>
          recountStockCountLine(context.authz.user.orgId, context.authz.user.id, request),
        )),
        href: COUNT_HREF(input.countId),
      };
    },
  }),
  countMutation({
    name: "submit_stock_count_for_review",
    title: "Submit Stock Count for Review",
    description:
      "Submit a completed count for its configured approval workflow; all required observations must be recorded first. Find the count id with list_stock_counts, then use list_approvals and decide_approval to complete review.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => ({
      ...(await runCountAction(
        context,
        input,
        "inventory.stock-count.submit",
        { countId: input.countId },
        () =>
          submitStockCountForReview(context.authz.user.orgId, context.authz.user.id, input.countId),
      )),
      href: COUNT_HREF(input.countId),
    }),
  }),
  countMutation({
    name: "return_stock_count_to_counting",
    title: "Return Stock Count to Counting",
    description:
      "Return a submitted count to counting when the approval workflow allows corrections. Find the count id with list_stock_counts and verify with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => ({
      ...(await runCountAction(
        context,
        input,
        "inventory.stock-count.return",
        { countId: input.countId },
        () =>
          returnStockCountToCounting(
            context.authz.user.orgId,
            context.authz.user.id,
            input.countId,
          ),
      )),
      href: COUNT_HREF(input.countId),
    }),
  }),
  countMutation({
    name: "set_stock_count_date",
    title: "Set Stock Count Date",
    description:
      "Change a count's business date while its lifecycle permits the change. Find the count id with list_stock_counts and verify with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      date: DATE.describe("New count business date."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      const request = { countId: input.countId, countedOn: input.date };
      return {
        ...(await runCountAction(context, input, "inventory.stock-count.set-date", request, () =>
          setStockCountDate(context.authz.user.orgId, context.authz.user.id, request),
        )),
        href: COUNT_HREF(input.countId),
      };
    },
  }),
  countMutation({
    name: "post_stock_count",
    title: "Post Stock Count",
    description:
      "Post an approved cycle count's variances through the inventory costing and journal path. Find the count id and any unresolved found-cost items with get_stock_count; then verify with the same read.",
    inputSchema: z.object({
      countId: UUID.describe("Approved count id from list_stock_counts."),
      foundUnitCosts: z
        .record(
          UUID,
          z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .describe("Exact unit-cost decimal string."),
        )
        .optional()
        .describe("Required unit costs for found quantities with no available cost basis."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.post");
      await withCountScope(context, input.countId);
      try {
        const outcome = await executeScopedStockCountAction({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          countId: input.countId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          operation: "inventory.stock-count.post",
          idempotencyKey: input.idempotencyKey,
          request: { countId: input.countId, foundUnitCosts: input.foundUnitCosts ?? {} },
          execute: () =>
            postStockCount(context.authz.user.orgId, context.authz.user.id, input.countId, {
              foundUnitCosts: input.foundUnitCosts,
            }),
        });
        return {
          ok: true,
          replayed: outcome.replayed,
          ...(outcome.value as Record<string, unknown>),
          href: COUNT_HREF(input.countId),
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  countMutation({
    name: "cancel_stock_count",
    title: "Cancel Stock Count",
    description:
      "Cancel an unposted stock count when its lifecycle allows cancellation; posted history cannot be deleted. Find the count id with list_stock_counts and verify the status with get_stock_count.",
    inputSchema: z.object({
      countId: UUID.describe("Count id from list_stock_counts."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    destructive: true,
    execute: async (context, input) => ({
      ...(await runCountAction(
        context,
        input,
        "inventory.stock-count.cancel",
        { countId: input.countId },
        () => cancelStockCount(context.authz.user.orgId, context.authz.user.id, input.countId),
      )),
      href: COUNT_HREF(input.countId),
    }),
  }),
];
