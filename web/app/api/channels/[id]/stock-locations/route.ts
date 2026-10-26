import { NextResponse } from "next/server";
import { z } from "zod";
import { listChannelStockLocationOptions } from "@openbooks/engine/commerce";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { isUuid } from "@/lib/list-params";
import { guardChannelScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/** Active stock locations as mapping options, labelled with their dimension name. */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    const outOfScope = await guardChannelScope(gate, id);
    if (outOfScope) return outOfScope;
    const rows = await listChannelStockLocationOptions(
      gate.user.orgId,
      id,
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json({ options: rows });
  },
});
