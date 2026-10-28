import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { BillingError } from "@openbooks/engine/documents/billing";
import { createInvoiceFromBillingRequest as createDraftInvoice } from "@/lib/billing-request-invoice";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** Generate a draft customer_invoice from an open billing request. */
async function createInvoiceFromBillingRequest(gate: Authz, id: string) {
  if (!isUuid(id)) return notFound("record");
  try {
    const result = await createDraftInvoice({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      requestId: id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    });
    return NextResponse.json({
      documentId: result.id,
      documentNumber: result.documentNumber,
      backup: result.backup,
    });
  } catch (e) {
    if (e instanceof BillingError && e.message === "Billing request not found")
      return notFound("record");
    if (e instanceof BillingError && e.message === "Inventory is disabled") {
      return notFound("record");
    }
    if (e instanceof BillingError && e.message === "Equipment is disabled") {
      return notFound("record");
    }
    return apiErrorResponse(e);
  }
}

export const POST = defineRoute({
  permission: "ar.create",
  feature: "projects",
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => createInvoiceFromBillingRequest(authz, params.id),
});
