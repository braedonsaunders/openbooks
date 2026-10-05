import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listInboundEvents } from "@openbooks/engine/src/commerce/inbound.ts";
import { isUuid } from "@/lib/list-params";

export const runtime = "nodejs";

function readLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");
  if (raw == null || raw.trim() === "") return 100;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 100;
  return Math.min(parsed, 500);
}

export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ request, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("channel");
    // An unknown channel reads as an empty activity list: the channel GET
    // above already answers 404, so this list never oracles existence.
    const events = await listInboundEvents(gate.user.orgId, id, readLimit(request));
    return NextResponse.json({ events });
  },
});
