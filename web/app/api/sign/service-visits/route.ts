import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  recordVisitSignature,
  signatureLinkVisit,
  verifyVisitSignatureToken,
} from "@openbooks/engine/service/signatures";
import { uploadAndAttach } from "@/lib/file-cabinet";
import { SERVICE_VISIT_TARGET } from "@/lib/service/files";
import { publicVisitSignBody } from "@/lib/service/schemas";

export const runtime = "nodejs";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * The customer's sign-off of a visit, authenticated by possession of the
 * signing-link token. The drawn signature is stored as a File Cabinet image
 * on the visit and the signature recorded in one transaction, so a refused
 * or raced signing leaves no image behind. Each link signs once.
 */
export const POST = defineRoute({
  public: "token",
  body: publicVisitSignBody,
  handler: async ({ body }) => {
    const claims = verifyVisitSignatureToken(body.token);
    if (!claims)
      return NextResponse.json(
        {
          error: "This signing link is invalid or expired.",
          remedy: "Ask for a new signing link.",
        },
        { status: 401 },
      );
    if (!body.signature.startsWith("data:image/png;base64,"))
      return NextResponse.json({ error: "Draw your signature to sign." }, { status: 422 });
    const bytes = Buffer.from(body.signature.slice("data:image/png;base64,".length), "base64");
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
      return NextResponse.json(
        { error: "The signature image is invalid.", remedy: "Clear the pad and sign again." },
        { status: 422 },
      );
    const signed = await withOrgTransaction(claims.orgId, async () => {
      const visitId = await signatureLinkVisit(claims.orgId, body.token);
      const file = await uploadAndAttach({
        orgId: claims.orgId,
        targetTable: SERVICE_VISIT_TARGET,
        targetId: visitId,
        filename: "Customer-signature.png",
        contentType: "image/png",
        bytes,
        createdBy: null,
      });
      return recordVisitSignature({
        orgId: claims.orgId,
        token: body.token,
        signerName: body.name,
        comment: body.comment ?? null,
        signatureFileId: file.id,
      });
    });
    return NextResponse.json({ signed: true, visitId: signed.visitId }, { status: 201 });
  },
});
