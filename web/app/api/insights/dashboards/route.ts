import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../lib/list-params";
import { createInsightDashboard } from "@/lib/insight-mutations";

export const runtime = "nodejs";

const layoutBody = z
  .array(
    z.strictObject({
      cardId: uuidString("layout.cardId must be a valid id"),
      x: z.number().int().min(0).max(11),
      y: z.number().int().min(0).max(999),
      w: z.number().int().min(1).max(12),
      h: z.number().int().min(1).max(24),
    }),
    { error: "layout must be an array of card placements" },
  )
  .max(1000, "layout cannot contain more than 1000 cards");
const createDashboardBodySchema = z.strictObject({
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  layout: layoutBody.optional(),
  allowedRoles: z
    .array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys"))
    .nullable()
    .optional(),
});

/**
 * Explicit create for an insight dashboard. The New button opens a LOCAL
 * dialog (name + description, zero writes) and this endpoint runs only on
 * Save: the caller supplies a UUID idempotency key, which becomes the
 * dashboard id, so retrying the same request returns the same dashboard
 * without a duplicate insert or duplicate audit event. Cancel/close writes
 * nothing — there is no draft row.
 */
export const POST = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  body: createDashboardBodySchema,
  handler: async ({ request: req, authz: gate, body: routeBody }) => {
    const requestId = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    return createInsightDashboard(gate, requestId, routeBody);
  },
});
