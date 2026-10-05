import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { CommerceError, similarCatalogEntries } from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

/** Entries decidable together with this one (siblings and same-SKU rows). */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const entryId = new URL(request.url).searchParams.get("entryId") ?? "";
    if (!isUuid(entryId)) return notFound("record");
    try {
      return NextResponse.json({ entryIds: await similarCatalogEntries(gate.user.orgId, id, entryId) });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_not_found") return notFound("channel");
      throw error;
    }
  },
});
