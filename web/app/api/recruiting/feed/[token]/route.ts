import { NextResponse } from "next/server";
import { listFeedPostings, resolveFeedOrg } from "@openbooks/engine/src/hrm/recruiting/postings.ts";
import { recruitingErrorResponse } from "../../../hrm/recruiting/_lib";

export const runtime = "nodejs";

/**
 * Public job feed: NO session (proxy-policy allowlist). The signed feed
 * token (issued per org from the posting surface) is the entire grant.
 * Serves published postings of open requisitions as JSON, or as a generic
 * XML feed with ?format=xml. Aggregate only — no candidate PII ever rides
 * this shape. Named boards are connectors behind sync connections; this
 * route IS the generic feed board.
 */
function escXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const orgId = await resolveFeedOrg(decodeURIComponent(token));
    const postings = await listFeedPostings(orgId);
    const format = new URL(req.url).searchParams.get("format");
    if (format === "xml") {
      const items = postings
        .map(
          (posting) =>
            `  <job><id>${escXml(posting.postingId)}</id><requisition>${escXml(posting.requisitionNumber)}</requisition><title>${escXml(posting.title)}</title><published>${escXml(posting.publishedAt ?? "")}</published></job>`,
        )
        .join("\n");
      return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>\n<jobs>\n${items}\n</jobs>`, {
        headers: { "content-type": "application/xml; charset=utf-8" },
      });
    }
    return NextResponse.json({ jobs: postings });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
