import { createHash } from "node:crypto";
import { parseJsonBody } from "../../../../../lib/api/json";
import { NextResponse } from "next/server";
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
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const offer = await readOfferForSigning(decodeURIComponent(token));
    return NextResponse.json({ offer });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsedBody = await parseJsonBody(req, signOfferBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  // The IP is hashed, never stored: the evidence carries proof of presence
  // without retaining an identifier the product does not need.
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = createHash("sha256").update(forwarded).digest("hex").slice(0, 32);
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
}
