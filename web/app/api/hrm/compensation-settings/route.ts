import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { guardPermission } from "../../../../lib/authz";
import { isFeatureEnabled } from "../../../../lib/features";
import { compensationErrorResponse } from "../compensation/_lib";

export const runtime = "nodejs";

/**
 * Compensation settings (the orgs.settings compensation document):
 * comparison attribute key, unexplained-gap threshold, pay-information
 * response days, FTE rounding, and the declared burden rate. GET reads
 * through comp.read; PUT writes through comp.manage with every field
 * validated before the document commits. Gated on hrmCompensation.
 * The client checks res.ok before parsing.
 */
const settingsBody = z.object({
  comparisonAttributeKey: z.string().trim().max(120).nullable().optional(),
  gapThresholdPct: z.number().nonnegative().nullable().optional(),
  responseDays: z.number().int().positive().nullable().optional(),
  fteRounding: z.enum(["up_to_whole", "nearest_tenth", "nearest_hundredth"]).nullable().optional(),
  burdenRate: z.string().regex(/^\d+(\.\d+)?$/).nullable().optional(),
});

export async function GET() {
  const gate = await guardPermission("hrm.compensation.read");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const row = (await db.execute<{ settings: Record<string, unknown> | null }>(
    sql`select settings from orgs where id = ${gate.user.orgId}`,
  )).rows[0];
  const compensation = ((row?.settings ?? {}) as Record<string, unknown>).compensation ?? {};
  return NextResponse.json({ settings: compensation });
}

export async function PUT(req: Request) {
  const gate = await guardPermission("hrm.compensation.manage");
  if (gate instanceof NextResponse) return gate;
  if (!(await isFeatureEnabled(gate.user.orgId, "hrmCompensation"))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsedBody = await parseJsonBody(req, settingsBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const current = (await db.execute<{ settings: Record<string, unknown> | null }>(
      sql`select settings from orgs where id = ${gate.user.orgId} for update`,
    )).rows[0]?.settings ?? {};
    const existing = ((current as Record<string, unknown>).compensation ?? {}) as Record<string, unknown>;
    const next = { ...existing };
    if (body.comparisonAttributeKey !== undefined) {
      next.comparisonAttributeKey = body.comparisonAttributeKey?.trim() ? body.comparisonAttributeKey.trim() : null;
    }
    if (body.gapThresholdPct !== undefined) next.gapThresholdPct = body.gapThresholdPct;
    if (body.responseDays !== undefined) next.responseDays = body.responseDays;
    if (body.fteRounding !== undefined) next.fteRounding = body.fteRounding;
    if (body.burdenRate !== undefined) next.burdenRate = body.burdenRate;
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{compensation}', ${JSON.stringify(next)}::jsonb),
             updated_at = now(), updated_by = ${gate.user.id}
       where id = ${gate.user.orgId}`);
    return NextResponse.json({ settings: next });
  } catch (e) {
    return compensationErrorResponse(e);
  }
}
