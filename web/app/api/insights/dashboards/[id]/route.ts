import { defineRoute } from "@/lib/api/route";
import { deleteInsightDashboard, updateInsightDashboard } from "@/lib/insight-mutations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";
import { loadDashboard } from "../../_lib";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

// cardId stays a plain string here on purpose: a malformed reference must
// reach the domain check below (normalizeLayout) so the caller gets the
// usable 422 board refusal. Rejecting it in the schema would answer 400 and
// erase that domain refusal.
const layoutBody = z
  .array(
    z.strictObject({
      cardId: z.string(),
      x: z.number().int().min(0).max(11),
      y: z.number().int().min(0).max(999),
      w: z.number().int().min(1).max(12),
      h: z.number().int().min(1).max(24),
    }),
  )
  .max(1000, "layout cannot contain more than 1000 cards");
const revisionBody = z
  .string({ error: "expectedUpdatedAt is required; reload and review the latest revision" })
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    "expectedUpdatedAt must be the exact dashboard revision",
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
    const dashboard = await loadDashboard(id, gate.user.orgId);
    if (!dashboard) return notFound("record");
    return NextResponse.json(dashboard);
  },
});

interface PatchBody {
  /** Exact `updated_at` token returned by GET; required for every autosave. */
  expectedUpdatedAt?: unknown;
  name?: string;
  description?: string | null;
  layout?: unknown;
  allowedRoles?: unknown;
}

export const PATCH = defineRoute({
  permission: "insights.create",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: z
    .strictObject({
      expectedUpdatedAt: revisionBody,
      name: z.string().trim().min(1, "name cannot be empty").max(200).optional(),
      description: z.string().trim().max(2000).nullable().optional(),
      layout: layoutBody.optional(),
      allowedRoles: z
        .array(z.string().trim().min(1, "allowedRoles cannot contain blank role keys"))
        .nullable()
        .optional(),
    })
    .refine(
      (body) => Object.keys(body).some((key) => key !== "expectedUpdatedAt"),
      "provide at least one dashboard field to update",
    ),
  handler: async ({ authz: gate, params, body: routeBody }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    return updateInsightDashboard(gate, id, routeBody as PatchBody);
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
    return deleteInsightDashboard(gate, id);
  },
});
