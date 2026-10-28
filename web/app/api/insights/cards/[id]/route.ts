import { defineRoute } from "@/lib/api/route";
import { deleteInsightCard, updateInsightCard } from "@/lib/insight-mutations";
import { z } from "zod";
import { INSIGHT_VIZ_TYPES, validateInsightQuery } from "@openbooks/analytics";
import { NextResponse } from "next/server";
import { isUuid } from "../../../../../lib/list-params";
import { loadCard } from "../../_lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const insightQueryBody = z.json().refine((value) => {
  try {
    validateInsightQuery(value);
    return true;
  } catch {
    return false;
  }
}, "query must follow the insight query schema");
const revisionBody = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    "expectedUpdatedAt must be the exact card revision",
  )
  .refine(
    (value) => !Number.isNaN(new Date(value).getTime()),
    "expectedUpdatedAt must be a valid timestamp",
  );

export const GET = defineRoute({
  permission: "insights.read",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const card = await loadCard(id, gate.user.orgId);
    if (!card) return notFound("record");
    return NextResponse.json(card);
  },
});

interface PatchBody {
  name?: string;
  description?: string | null;
  query?: unknown;
  vizType?: string;
  vizSettings?: unknown;
  allowedRoles?: unknown;
  expectedUpdatedAt?: string;
}

/** Autosave for the card studio: name, query plan, viz type + settings, gating. */
export const PATCH = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: z
    .strictObject({
      name: z.string().trim().min(1, "name cannot be empty").max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      query: insightQueryBody.optional(),
      vizType: z.enum(INSIGHT_VIZ_TYPES).optional(),
      vizSettings: z.record(z.string().min(1), z.json()).optional(),
      allowedRoles: z
        .array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys"))
        .nullable()
        .optional(),
      // Optional at the schema so a missing token reaches the handler's 409
      // (reload remedy) instead of failing as a faceless schema refusal.
      expectedUpdatedAt: revisionBody.optional(),
    })
    .refine(
      (body) => Object.keys(body).some((key) => key !== "expectedUpdatedAt"),
      "provide at least one card field to update",
    ),
  handler: async ({ authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    return updateInsightCard(gate, id, routeBody as PatchBody);
  },
});

export const DELETE = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    return deleteInsightCard(gate, id);
  },
});
