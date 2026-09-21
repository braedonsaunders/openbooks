import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { bookSlot, readBookingLink } from "@openbooks/engine/src/hrm/recruiting/scheduling.ts";
import { recruitingErrorResponse } from "../../../hrm/recruiting/_lib";
import { bookSlotBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Public self-booking: NO session (proxy-policy allowlist). The HMAC
 * booking token is the entire grant: it binds ONE interview, and every
 * consumer re-checks liveness (proposed slots, unexpired link). First
 * booking wins; token reuse after expiry and second bookings on taken
 * slots are refused by name.
 *
 *   GET  /api/recruiting/book/[token]  the live proposed slots
 *   POST /api/recruiting/book/[token]  { slotId } → booked (siblings declined)
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const link = await readBookingLink(decodeURIComponent(token));
    return NextResponse.json({ link });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const parsedBody = await parseJsonBody(req, bookSlotBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    const slot = await bookSlot({
      bookingToken: decodeURIComponent(token),
      slotId: parsedBody.data.slotId,
      candidateName: parsedBody.data.candidateName,
    });
    return NextResponse.json({ slot });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
