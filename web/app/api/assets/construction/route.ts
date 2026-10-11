import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { createCipRecord } from "@openbooks/engine/assets/asset-cip";
import { calendarDate, id, optionalText, scopeOf } from "../_depth";

export const runtime = "nodejs";

const body = z.strictObject({
  subsidiaryId: id,
  categoryId: id,
  name: z.string().trim().min(1, "name is required").max(200),
  description: optionalText(4000),
  cipAccountId: id,
  startedOn: calendarDate("startedOn").nullable().optional(),
  departmentId: id.nullable().optional(),
  projectId: id.nullable().optional(),
  locationId: id.nullable().optional(),
});

/** Open a construction-in-progress record on its CIP account. */
export const POST = defineRoute({
  permission: "assets.capitalize",
  feature: "constructionInProgress",
  body,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body: input }) => {
    const created = await createCipRecord(gate.user.orgId, {
      ...input,
      description: input.description ?? null,
      startedOn: input.startedOn ?? null,
      departmentId: input.departmentId ?? null,
      projectId: input.projectId ?? null,
      locationId: input.locationId ?? null,
      actorId: gate.user.id,
      allowedSubsidiaryIds: scopeOf(gate),
    });
    return NextResponse.json(created, { status: 201 });
  },
});
