import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { createPaymentDocument } from "@openbooks/engine/payments/payment-documents";
import { can, getAuthz } from "@/lib/authz";
import { paymentErrorResponse, paymentPermission } from "../lib";

export const runtime = "nodejs";

const draftBody = z.object({
  kind: z.enum(["vendor_payment", "customer_payment"], {
    error: "kind must be vendor_payment or customer_payment",
  }),
});

export const POST = defineRoute({
  authorize: async ({ request }) => {
    let kind: unknown;
    try {
      kind = ((await request.clone().json()) as { kind?: unknown }).kind;
    } catch {
      /* body parser handles malformed JSON below */
    }
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (
      (kind === "vendor_payment" || kind === "customer_payment") &&
      !can(authz, paymentPermission(kind))
    ) {
      return NextResponse.json(
        { error: `missing permission: ${paymentPermission(kind)}` },
        { status: 403 },
      );
    }
    return authz;
  },
  feature: { none: "Draft payment permission is selected from the validated payment kind." },
  body: draftBody,
  /** Instant-into-draft: create an empty draft payment/receipt, return its id. */
  handler: async ({ authz: gate, body }) => {
    const user = gate.user;
    try {
      const doc = await createPaymentDocument({
        orgId: user.orgId,
        kind: body.kind,
        createdBy: user.id,
        // A restricted caller defaults to their own subsidiary, or a named
        // refusal — never the org root.
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json(doc);
    } catch (e) {
      return paymentErrorResponse(e);
    }
  },
});
