import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  QUOTE_SUBJECT_TABLE,
  quoteCashPreview,
  requestQuoteSignature,
  voidSignatureRequestsForSubject,
} from "@openbooks/engine/billing/quote-to-cash";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import { deliverQuoteSignature } from "@/lib/quote-to-cash/delivery";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });

const sendBody = z.object({
  signerName: z.string(),
  signerEmail: z.string(),
  expiresInDays: z.number().nullish(),
});

/**
 * Send a quote for signature: the engine mints the signer's link, then the
 * route delivers it (email when the org configured a transport — the link
 * itself is always returned so it can be handed over another channel).
 * GET reports the open or latest request for the drawer's timeline.
 */
export const GET = defineRoute({
  permission: "estimates.read",
  feature: "quoteToCash",
  params,
  handler: async ({ authz, params }) => {
    try {
      const preview = await quoteCashPreview(
        authz.user.orgId,
        params.id,
        authz.allowedSubsidiaryIds,
      );
      return NextResponse.json({ request: preview.signature });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const DELETE = defineRoute({
  permission: "estimates.create",
  feature: "quoteToCash",
  params,
  handler: async ({ authz, params }) => {
    try {
      const result = await withOrgTransaction(authz.user.orgId, () =>
        voidSignatureRequestsForSubject(
          db,
          authz.user.orgId,
          QUOTE_SUBJECT_TABLE,
          params.id,
          authz.allowedSubsidiaryIds,
        ),
      );
      return NextResponse.json(result);
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "estimates.create",
  feature: "quoteToCash",
  params,
  body: sendBody,
  handler: async ({ request: req, authz, params, body }) => {
    try {
      const preview = await quoteCashPreview(
        authz.user.orgId,
        params.id,
        authz.allowedSubsidiaryIds,
      );
      const sent = await requestQuoteSignature({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        quoteId: params.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        signerName: body.signerName,
        signerEmail: body.signerEmail,
        expiresInDays: body.expiresInDays,
      });
      if (sent.status === "pending_approval") return NextResponse.json(sent, { status: 202 });
      const delivery = await deliverQuoteSignature({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        req,
        quoteNumber: preview.quote.documentNumber,
        currency: preview.quote.currency,
        totalContractValue: preview.tcv,
        termMonths: Math.max(0, ...preview.terms.map((t) => t.term.termMonths)),
        token: sent.token,
        signerName: body.signerName,
        signerEmail: body.signerEmail,
        expiresAt: sent.expiresAt,
      });
      return NextResponse.json({
        requestId: sent.requestId,
        expiresAt: sent.expiresAt.toISOString(),
        signUrl: delivery.signUrl,
        emailed: delivery.emailed,
        emailSkippedReason: delivery.emailSkippedReason,
      });
    } catch (e) {
      return apiErrorResponse(e);
    }
  },
});
