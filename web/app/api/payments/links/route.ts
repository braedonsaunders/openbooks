import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import {
  PaymentAcceptanceError,
  createPaymentLink,
  listPaymentLinks,
} from "@openbooks/engine/payments/acceptance/operations";
import {
  paymentLinkDocumentScope,
  paymentLinkProviderOptions,
} from "@openbooks/engine/payments/payment-queries";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { guardPermission, type Authz } from "@/lib/authz";
import { guardSubsidiaryScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { nullableUuidId, uuidId } from "@/lib/api/json";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

const createLinkBody = z.object({
  provider: z.enum(["stripe", "adyen", "gocardless"], {
    error: "provider must be stripe, adyen or gocardless",
  }),
  documentId: z
    .string({ error: "documentId is required" })
    .refine((v) => uuidId.safeParse(v).success, "documentId is required"),
  bankAccountId: nullableUuidId.optional(),
  expiresOn: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
});

/**
 * Payment-link list/mint is a document-record boundary: the invoice's
 * subsidiary is loaded with the org probe, then the shared gate runs
 * before tokens are listed or minted. Out-of-scope invoices read exactly
 * like a missing one — the same 404 as /api/documents/[id].
 */
async function denyOutsideDocumentScope(
  authz: Authz,
  documentId: string,
): Promise<NextResponse | null> {
  const owned = await paymentLinkDocumentScope(authz.user.orgId, documentId);
  if (!owned) return notFound("record");
  return guardSubsidiaryScope(authz, owned.subsidiaryId);
}

async function listPaymentLinksRoute(req: Request, gate: Authz) {
  const documentId = new URL(req.url).searchParams.get("documentId");
  if (!documentId || !isUuid(documentId)) {
    return NextResponse.json({ error: "documentId is required" }, { status: 400 });
  }
  const denied = await denyOutsideDocumentScope(gate, documentId);
  if (denied) return denied;
  try {
    const [links, providers] = await Promise.all([
      listPaymentLinks(gate.user.orgId, documentId, gate.allowedSubsidiaryIds),
      paymentLinkProviderOptions(gate.user.orgId),
    ]);
    return NextResponse.json({ links, providers: providers.map((r) => r.provider) });
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    throw e;
  }
}

async function createPaymentLinkRoute(gate: Authz, body: z.infer<typeof createLinkBody>) {
  const denied = await denyOutsideDocumentScope(gate, body.documentId);
  if (denied) return denied;
  try {
    const link = await createPaymentLink(
      gate.user.orgId,
      gate.user.id,
      {
        documentId: body.documentId,
        provider: body.provider,
        bankAccountId: body.bankAccountId ?? null,
        expiresOn: body.expiresOn ?? null,
        memo: body.memo ?? null,
      },
      gate.allowedSubsidiaryIds,
    );
    return NextResponse.json(link, { status: 201 });
  } catch (e) {
    if (e instanceof ScopeNotFoundError) return notFound("record");
    if (e instanceof PaymentAcceptanceError) return apiErrorResponse(e, { safeStatus: 422 });
    return apiErrorResponse(e);
  }
}

export const GET = defineRoute({
  authorize: () => guardPermission("ar.read"),
  feature: "onlinePayments",
  handler: async ({ request, authz }) => listPaymentLinksRoute(request, authz),
});
export const POST = defineRoute({
  authorize: () => guardPermission("ar.create"),
  feature: "onlinePayments",
  body: createLinkBody,
  handler: async ({ authz, body }) => createPaymentLinkRoute(authz, body),
});
