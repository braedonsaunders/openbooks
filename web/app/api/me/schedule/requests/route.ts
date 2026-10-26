import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import {
  createOwnShiftRequest,
  listOwnShiftRequests,
} from "@openbooks/engine/schedule-boards/requests";
import { deliverScheduleNotices } from "@/lib/scheduling/notify";

const clock = z.string().regex(/^\d{2}:\d{2}$/);

/** The signed-in person's shift requests and the swaps colleagues offered them. */
export const GET = defineRoute({
  permission: "hrm.self.read",
  feature: "hrmShiftPlanning",
  handler: async ({ authz }) =>
    NextResponse.json({
      requests: await listOwnShiftRequests({ orgId: authz.user.orgId, actorId: authz.user.id }),
    }),
});

/** Ask to release, change or swap one of the person's own published shifts. */
export const POST = defineRoute({
  permission: "hrm.self.request",
  feature: "hrmShiftPlanning",
  body: z.strictObject({
    id: uuidString(),
    entryId: uuidString(),
    expectedRevision: z.number().int().positive(),
    kind: z.enum(["release", "change", "swap"]),
    change: z
      .strictObject({ starts: clock, ends: clock, breakMinutes: z.number().int().min(0).max(240) })
      .nullable()
      .optional(),
    counterpartEntryId: uuidString().nullable().optional(),
    counterpartRevision: z.number().int().positive().nullable().optional(),
    reason: z.string().trim().min(1).max(2000),
  }),
  handler: async ({ authz, body }) => {
    const result = await createOwnShiftRequest({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      ...body,
    });
    // A request no approval Flow gates applies at once; its notices follow the committed change.
    const delivery = await deliverScheduleNotices({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardName: result.boardName,
      notices: [...result.notices],
    });
    return NextResponse.json({
      request: result.request,
      delivery,
      distributionRefusals: result.distributionRefusals,
    });
  },
});
