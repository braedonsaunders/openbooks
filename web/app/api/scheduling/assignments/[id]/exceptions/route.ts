import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { recordPatternException } from "@openbooks/engine/schedule-boards/pattern-store";

const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** Omit an occurrence, or choose the real instants of a clock time a clock change repeats. */
export const POST = defineRoute({
  permission: "hrm.shifts.manage",
  feature: "hrmShiftPlanning",
  params: z.object({ id: uuidString() }),
  body: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("omit"),
      occursOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slotIndex: z.number().int().min(0).max(999),
      reason: z.string().trim().min(1).max(2000),
    }),
    z.strictObject({
      kind: z.literal("select_instant"),
      occursOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      slotIndex: z.number().int().min(0).max(999),
      startsAt: instant,
      endsAt: instant,
      reason: z.string().trim().min(1).max(2000),
    }),
  ]),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await recordPatternException({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        assignmentId: params.id,
        ...body,
      }),
    ),
});
