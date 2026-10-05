import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import {
  catalogQueueCounts,
  CommerceError,
  importShopifyCatalog,
  listCatalogQueue,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

const querySchema = z.object({
  status: z.enum(["queued", "matched", "ignored"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

function notFoundWhenMissing(error: unknown) {
  if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
  throw error;
}

/** The Products match queue with its status counts. */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      const url = new URL(request.url);
      const query = querySchema.parse({
        status: url.searchParams.get("status") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        offset: url.searchParams.get("offset") ?? undefined,
      });
      const [queue, counts] = await Promise.all([
        listCatalogQueue(gate.user.orgId, id, query),
        catalogQueueCounts(gate.user.orgId, id),
      ]);
      return NextResponse.json({ ...queue, counts });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});

/** Re-import the catalog from the storefront (idempotent). */
export const POST = defineRoute({
  permission: "channels.manage",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  body: z.strictObject({ mode: z.enum(["auto", "paginated", "bulk"]).optional() }),
  handler: async ({ authz: gate, params, body }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      const result = await importShopifyCatalog(gate.user.orgId, gate.user.id, id, { mode: body.mode });
      const counts = await catalogQueueCounts(gate.user.orgId, id);
      return NextResponse.json({ ...result, counts });
    } catch (error) {
      return notFoundWhenMissing(error);
    }
  },
});
