import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cancelRevenueRecognitionForInvoice,
  cancellationDocumentScope,
  RevenueRecognitionCancellationError,
} from "@openbooks/engine/ledger/revenue-recognition-cancellation";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { DocumentVoidError } from "@openbooks/engine/ledger/document-void";
import { guardSubsidiaryScope } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { isoDate, uuidId } from "@/lib/api/json";
import { isDocKindEnabled } from "@/lib/documents";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const cancelRecognitionBody = z.object({
  documentId: z
    .string({ error: "invalid invoice" })
    .refine((v) => uuidId.safeParse(v).success, "invalid invoice"),
  reason: z.string().trim().min(5).max(500),
  reversalDate: isoDate().optional(),
});

export type CancelRecognitionRequest = z.input<typeof cancelRecognitionBody>;

/**
 * Cancel revenue recognition for one invoice: reverse every posted
 * recognition journal with an exact compensating entry, mark the obligations
 * cancelled, then route the invoice through the normal controlled void. This
 * is the dedicated cancellation workflow the invoice-void refusal points at —
 * voiding a revenue-recognition invoice directly stays refused.
 */
export const POST = defineRoute({
  permission: "ar.post",
  feature: "revenueRecognition",
  body: cancelRecognitionBody,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;

    const doc = await cancellationDocumentScope(user.orgId, body.documentId);
    if (!doc) return notFound("record");
    const denied = guardSubsidiaryScope(gate, doc.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(user.orgId, doc.kind))) {
      return notFound("record");
    }

    const reversalDate = body.reversalDate ?? (await businessToday(user.orgId));

    try {
      const result = await cancelRevenueRecognitionForInvoice({
        documentId: body.documentId,
        orgId: user.orgId,
        actorId: user.id,
        reason: body.reason,
        reversalDate,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json(
        { ok: true, ...result },
        { status: result.status === "pending_approval" ? 202 : 200 },
      );
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        return notFound("record");
      }
      if (error instanceof RevenueRecognitionCancellationError) {
        return apiErrorResponse(error, { safeStatus: 422 });
      }
      if (error instanceof DocumentVoidError) {
        return apiErrorResponse(error, { details: { code: error.code } });
      }
      throw error;
    }
  },
});
