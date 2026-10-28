import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { INSIGHT_VIZ_TYPES, validateInsightQuery } from "@openbooks/analytics";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../lib/list-params";
import { createInsightCard } from "@/lib/insight-mutations";

export const runtime = "nodejs";

const insightQueryBody = z.json().refine((value) => {
  try {
    validateInsightQuery(value);
    return true;
  } catch {
    return false;
  }
}, "query must follow the insight query schema");
const createCardBodySchema = z.strictObject({
  name: z.string().trim().max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  query: insightQueryBody.optional(),
  vizType: z
    .enum(INSIGHT_VIZ_TYPES, { error: "vizType must be a supported visualization type" })
    .optional(),
  vizSettings: z.record(z.string().min(1), z.json()).optional(),
  allowedRoles: z
    .array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys"))
    .nullable()
    .optional(),
});

/**
 * Explicit create for an insight card. The New button opens an UNSAVED studio
 * (`?card=new`) and this endpoint runs only on Save: the caller supplies a
 * UUID idempotency key, which becomes the card id, so retrying the same
 * request returns the same card without a duplicate insert or duplicate
 * audit event. Cancel/close writes nothing — there is no draft row.
 */
export const POST = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  body: createCardBodySchema,
  handler: async ({ request: req, authz: gate, body: routeBody }) => {
    const requestId = req.headers.get("Idempotency-Key")?.trim() ?? "";
    if (!isUuid(requestId)) {
      return NextResponse.json({ error: "invalid_idempotency_key" }, { status: 400 });
    }
    return createInsightCard(gate, requestId, routeBody);
  },
});
