import { z } from "zod";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { proposeHolidayObligation } from "@openbooks/engine/src/payroll/holiday-obligations.ts";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { uuidId } from "@/lib/api/json-schema";
import { accessAtLeast, fileAccessLevel } from "@/lib/file-cabinet";
import { fileViewer } from "@/app/api/file-cabinet/lib";

const body = z.strictObject({
  instruction: z.strictObject({
    employeePartyId: uuidId, holidayDates: z.array(z.string()).min(1), hours: z.string(),
    assessedOn: z.string(), wageBasisDate: z.string(), paymentDate: z.string(),
    instructionKey: z.string().min(1).max(200), sourceReference: z.string().min(1).max(2000),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/i),
  }),
  source: z.strictObject({ fileId: uuidId, versionId: uuidId }), employmentId: uuidId,
  reason: z.string().trim().min(8).max(1000), idempotencyKey: z.string().min(1).max(120),
});

export const runtime = "nodejs";
export const POST = defineRoute({
  permission: "payroll.run", feature: "payroll", body,
  handler: async ({ authz, body: input }) => {
    try {
      return NextResponse.json(await proposeHolidayObligation({ ...input,
        orgId: authz.user.orgId, actorId: authz.user.id,
        authorizeFile: async fileId => accessAtLeast(await fileAccessLevel(authz.user.orgId, fileViewer(authz), fileId, db), "viewer"),
      }));
    } catch (error) { return apiErrorResponse(error); }
  },
});
