import { defineRoute } from '@/lib/api/route';
import { NextResponse } from "next/server";
import { authRequestContext, networkAddressEvidenceHash } from "../../../../../lib/auth-policy";
import {
  declineOfferSigning,
  readOfferForSigning,
  signOffer,
} from "@openbooks/engine/src/hrm/recruiting/offers-signing.ts";
import { recruitingErrorResponse } from "../../../hrm/recruiting/_lib";
import { signOfferBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Public offer signing: NO session (proxy-policy allowlist). The HMAC
 * signing token is the entire grant: it binds ONE offer, view records
 * viewed, sign seals the HMAC evidence (signer name, timestamp, IP hash,
 * document hash), decline names its reason. Signed offers stay signed —
 * token reuse changes nothing.
 *
 *   GET  /api/recruiting/offer/[token]  the offer view (records viewed)
 *   POST /api/recruiting/offer/[token]  { action: sign | decline, ... }
 */
export const GET = defineRoute({
  public: 'token',
  handler: async ({ request: _req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { token: string });
    const { token } = await params;
    try {
        const offer = await readOfferForSigning(decodeURIComponent(token));
        return NextResponse.json({ offer });
      } catch (e) {
        return recruitingErrorResponse(e);
      }
  },
});

export const POST = defineRoute({
  public: 'token',
  body: signOfferBody,
  handler: async ({ request: req, params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { token: string });
    const { token } = await params;

    const body = routeBody;
    const ipHash = networkAddressEvidenceHash(authRequestContext(req));
    try {
        if (body.action === "decline") {
          const declined = await declineOfferSigning({ signingToken: decodeURIComponent(token), reason: body.reason });
          return NextResponse.json({ declined });
        }
        const signed = await signOffer({
          signingToken: decodeURIComponent(token),
          signerName: body.signerName,
          ipHash,
          documentHash: body.documentHash,
          renderedFileId: body.renderedFileId,
        });
        return NextResponse.json({ signed });
      } catch (e) {
        return recruitingErrorResponse(e);
      }
  },
});
