import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  bulkDecideCatalogMatches,
  CommerceError,
  decideCatalogMatch,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

const decisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("match"), nativeTable: z.enum(["items", "item_families"]), nativeId: z.string().uuid() }),
  z.strictObject({
    kind: z.literal("create_item"),
    itemKind: z.string().optional(),
    code: z.string().optional(),
    name: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("create_family"), familyKind: z.string().optional(), code: z.string().optional() }),
  z.strictObject({ kind: z.literal("ignore"), reason: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal("unmatch"), reason: z.string().trim().min(1) }),
]);

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

/** Apply one match decision on one queue entry. */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ entryId: z.string().uuid(), decision: decisionSchema }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      return NextResponse.json(
        await decideCatalogMatch(gate.user.orgId, gate.user.id, id, body.entryId, body.decision),
      );
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

/** Apply one decision across many entries; failures report per row. */
export const PUT = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ entryIds: z.array(z.string().uuid()).max(200), decision: decisionSchema }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    try {
      return NextResponse.json(
        await bulkDecideCatalogMatches(gate.user.orgId, gate.user.id, id, body.entryIds, body.decision),
      );
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});
