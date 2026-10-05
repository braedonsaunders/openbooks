import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CommerceError,
  listInventoryConflicts,
  listLocationSyncStates,
  listSyncPairs,
  loadShopifyChannel,
  pushInventoryPair,
  resolveAllInventoryConflicts,
  resolveInventoryConflict,
  upsertItemInventoryPolicy,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const resolutionSchema = z.enum(["pushed_openbooks", "accepted_shopify"]);

const inventoryBodySchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("resolve"),
    conflictId: z.string().uuid(),
    resolution: resolutionSchema,
  }),
  z.strictObject({
    action: z.literal("resolve-all"),
    resolution: resolutionSchema,
  }),
  z.strictObject({
    action: z.literal("push-now"),
    stockLocationId: z.string().uuid().nullish(),
    itemId: z.string().uuid().nullish(),
  }),
  z.strictObject({
    action: z.literal("set-policy"),
    itemId: z.string().uuid(),
    bufferQuantity: z.string().trim().min(1).max(30).nullish(),
    stopSellingAtZero: z.boolean().nullish(),
    syncInventory: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("clear-policy"),
    itemId: z.string().uuid(),
  }),
]);

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      const [states, conflicts] = await Promise.all([
        listLocationSyncStates(gate.user.orgId, id),
        listInventoryConflicts(gate.user.orgId, id),
      ]);
      return NextResponse.json({ states, conflicts });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: inventoryBodySchema,
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      if (body.action === "resolve") {
        const result = await resolveInventoryConflict(
          gate.user.orgId,
          gate.user.id,
          body.conflictId,
          body.resolution,
        );
        return NextResponse.json({ resolved: result });
      }
      if (body.action === "resolve-all") {
        const result = await resolveAllInventoryConflicts(
          gate.user.orgId,
          gate.user.id,
          id,
          body.resolution,
        );
        return NextResponse.json({ resolved: result.resolved, failed: result.failed });
      }
      if (body.action === "set-policy") {
        await upsertItemInventoryPolicy(gate.user.orgId, gate.user.id, {
          channelId: id,
          itemId: body.itemId,
          bufferQuantity: body.bufferQuantity ?? null,
          stopSellingAtZero: body.stopSellingAtZero ?? null,
          syncInventory: body.syncInventory,
        });
        return NextResponse.json({ saved: true });
      }
      if (body.action === "clear-policy") {
        await upsertItemInventoryPolicy(gate.user.orgId, gate.user.id, {
          channelId: id,
          itemId: body.itemId,
          bufferQuantity: null,
          stopSellingAtZero: null,
          syncInventory: true,
        });
        return NextResponse.json({ saved: true });
      }
      const access = await loadShopifyChannel(gate.user.orgId, id);
      const pairs = (await listSyncPairs(gate.user.orgId, id)).filter(
        (pair) =>
          (!body.stockLocationId || pair.stockLocationId === body.stockLocationId) &&
          (!body.itemId || pair.itemId === body.itemId),
      );
      const outcomes: { itemId: string; stockLocationId: string; result: string; quantity?: number }[] = [];
      for (const pair of pairs) {
        const outcome = await pushInventoryPair(gate.user.orgId, gate.user.id, access, pair);
        outcomes.push({
          itemId: pair.itemId,
          stockLocationId: pair.stockLocationId,
          result: outcome.result,
          ...(outcome.result === "pushed" || outcome.result === "converged"
            ? { quantity: outcome.quantity }
            : {}),
        });
      }
      return NextResponse.json({ outcomes });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});
