import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  getQuoteSignatureStatus,
  sendQuoteSignatureRequest,
  voidQuoteSignatureRequest,
} from "@/lib/quote-to-cash/signature-actions";

export const runtime = "nodejs";

const params = z.object({ id: z.string() });
const sendBody = z.object({
  signerName: z.string(),
  signerEmail: z.string(),
  expiresInDays: z.number().nullish(),
});

export const GET = defineRoute({
  permission: "estimates.read",
  feature: "quoteToCash",
  params,
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(await getQuoteSignatureStatus(authz, params.id));
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

export const DELETE = defineRoute({
  permission: "estimates.create",
  feature: "quoteToCash",
  params,
  handler: async ({ authz, params }) => {
    try {
      return NextResponse.json(await voidQuoteSignatureRequest(authz, params.id));
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});

export const POST = defineRoute({
  permission: "estimates.create",
  feature: "quoteToCash",
  params,
  body: sendBody,
  handler: async ({ request, authz, params, body }) => {
    try {
      const result = await sendQuoteSignatureRequest({
        authz,
        quoteId: params.id,
        signerName: body.signerName,
        signerEmail: body.signerEmail,
        expiresInDays: body.expiresInDays,
        request,
      });
      return NextResponse.json(result, {
        status: "status" in result && result.status === "pending_approval" ? 202 : 200,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
