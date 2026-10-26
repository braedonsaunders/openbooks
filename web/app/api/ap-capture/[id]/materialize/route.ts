import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  materializeCapture,
  CaptureMaterializationError,
} from "@openbooks/engine/payables/ap-capture-service";
import { isUuid } from "@/lib/list-params";
import { apCaptureSubsidiaryScope } from "@openbooks/engine/records/file-cabinet-access";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const materializeBodySchema = z.strictObject({ priceOverride: z.boolean().optional() }).optional();

export const POST = defineRoute({
  permission: "ap.create",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  params: z.object({ id: z.string() }),
  body: materializeBodySchema,
  handler: async ({ authz: gate, params: { id }, body }) => {
    try {
      // Existing callers may omit the body; only an explicit true requests
      // the AP-approved purchase-order price override.
      const priceOverride = body?.priceOverride === true;
      // The engine binds the id into a uuid column without validating it; a
      // malformed id must 404 here instead of escaping as a cast-error 500.
      if (!isUuid(id)) return notFound("record");
      const visible = await db.execute<{ id: string }>(
        sql`
        select ci.id
          from ap_capture_items ci
          left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
          left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
         where ci.org_id = ${gate.user.orgId} and ci.id = ${id}
         ${apCaptureSubsidiaryScope(gate.allowedSubsidiaryIds)}
      `,
        "objects",
      );
      if (!visible[0])
        return NextResponse.json({ error: "Capture item not found" }, { status: 422 });
      return NextResponse.json(
        await materializeCapture({
          orgId: gate.user.orgId,
          captureItemId: id,
          actorId: gate.user.id,
          priceOverride,
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        }),
      );
    } catch (error) {
      if (error instanceof CaptureMaterializationError) return apiErrorResponse(error);
      throw error;
    }
  },
});
