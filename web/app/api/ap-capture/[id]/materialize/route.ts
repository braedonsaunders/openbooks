import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  materializeCapture,
  CaptureMaterializationError,
} from "@openbooks/engine/payables/ap-capture-service";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";
import { findVisibleApCapture } from "@/lib/ap-capture-actions";

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
      const visible = await findVisibleApCapture({
        orgId: gate.user.orgId,
        captureItemId: id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      if (!visible) return NextResponse.json({ error: "Capture item not found" }, { status: 422 });
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
