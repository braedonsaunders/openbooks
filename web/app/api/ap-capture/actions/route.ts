import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  CaptureMaterializationError,
  materializeCapture,
  type ActivatedCaptureRule,
} from "@openbooks/engine/payables/ap-capture-service";
import { parseBulkActionIds } from "@/lib/api/bulk-ids";
import {
  ApCaptureActionRefusal,
  findVisibleApCapture,
  rejectApCapture,
  reprocessApCapture,
} from "@/lib/ap-capture-actions";

const captureIds = z.array(uuidString()).min(1).max(50);
const requestBodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("reject"), ids: captureIds }),
  z.strictObject({
    action: z.literal("materialize"),
    ids: captureIds,
    priceOverride: z.boolean().optional(),
  }),
  z.strictObject({
    action: z.literal("reprocess"),
    ids: captureIds,
    confirmDiscardCorrections: z.boolean().optional(),
  }),
]);

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "ap.create",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  body: requestBodySchema,
  handler: async ({ authz: gate, body: parsedBodyData }) => {
    const parsed = parseBulkActionIds(parsedBodyData);
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: parsed.error === "not_found" ? 404 : 400 },
      );
    }
    const action = parsed.action;
    const ids = parsed.ids;
    const results: Array<{
      id: string;
      ok: boolean;
      error?: string;
      errorCode?: string;
      details?: Record<string, unknown>;
      corrections?: number;
      documentId?: string;
      rulesActivated?: ActivatedCaptureRule[];
    }> = [];
    for (const id of ids) {
      try {
        if (action === "reject") {
          await rejectApCapture({
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            captureItemId: id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          });
          results.push({ id, ok: true });
        } else if (action === "reprocess") {
          await reprocessApCapture({
            orgId: gate.user.orgId,
            actorId: gate.user.id,
            captureItemId: id,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            confirmDiscardCorrections:
              parsedBodyData.action === "reprocess" &&
              parsedBodyData.confirmDiscardCorrections === true,
          });
          results.push({ id, ok: true });
        } else {
          if (
            !(await findVisibleApCapture({
              orgId: gate.user.orgId,
              captureItemId: id,
              allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
            }))
          ) {
            throw new Error("Capture item not found");
          }
          const created = await materializeCapture({
            orgId: gate.user.orgId,
            captureItemId: id,
            actorId: gate.user.id,
            priceOverride:
              parsedBodyData.action === "materialize" && parsedBodyData.priceOverride === true,
            allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
          });
          results.push({
            id,
            ok: true,
            documentId: created.documentId,
            rulesActivated: created.rulesActivated,
          });
        }
      } catch (error) {
        const captureError = error instanceof CaptureMaterializationError ? error : null;
        const actionError = error instanceof ApCaptureActionRefusal ? error : null;
        results.push({
          id,
          ok: false,
          error: error instanceof Error ? error.message : "failed",
          errorCode:
            captureError?.code ??
            (actionError?.code === "confirm_required" ? actionError.code : undefined),
          details: captureError?.details,
          corrections: actionError?.corrections,
        });
      }
    }
    return NextResponse.json({ results });
  },
});
