import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import {
  acknowledgeDocument,
  declineTokenDocument,
  readTokenDocument,
  signTokenDocument,
} from "@openbooks/engine/src/hrm/documents/documents.ts";
import { hrmDocumentsErrorResponse } from "../../../hrm/documents/_lib";
import { signActionBody } from "../../../hrm/documents/bodies";

/**
 * Public signing endpoint — possession-authenticated by the HMAC token,
 * no session. GET returns the document metadata (title, status, signer
 * timeline without tokens) or the current PDF with ?format=pdf. POST
 * signs, declines, or acknowledges. Every use re-validates the row:
 * cryptographic validity alone never authorizes — voided, expired, and
 * consumed links are refused by name. No feature-gate here: a link HR
 * sent must explain itself even after the switch flips (the service
 * answers, and answers refusals, link by link).
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const { document, signers, bytes } = await readTokenDocument(token);
    if (new URL(req.url).searchParams.get("format") === "pdf") {
      return new NextResponse(bytes as unknown as BodyInit, {
        headers: { "content-type": "application/pdf" },
      });
    }
    return NextResponse.json({
      document: {
        id: document.id,
        title: document.title,
        status: document.status,
        sentAt: document.sentAt,
        completedAt: document.completedAt,
        expiresAt: document.expiresAt,
      },
      signers: signers.map((s) => ({
        ord: s.ord,
        role: s.role,
        status: s.status,
        signedAt: s.signedAt,
      })),
    });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const parsedBody = await parseJsonBody(req, signActionBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  try {
    const { token } = await ctx.params;
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = forwarded ? forwarded.split(",")[0]!.trim() : null;
    const userAgent = req.headers.get("user-agent");
    if (body.action === "sign") {
      const document = await signTokenDocument({ token, name: body.name, ip, userAgent });
      return NextResponse.json({ document });
    }
    if (body.action === "decline") {
      const document = await declineTokenDocument({ token, reason: body.reason });
      return NextResponse.json({ document });
    }
    const document = await acknowledgeDocument({ token });
    return NextResponse.json({ document });
  } catch (e) {
    return hrmDocumentsErrorResponse(e);
  }
}
