import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { recruitingErrorResponse } from "../../hrm/recruiting/_lib";
import { applyBody } from "./bodies";

export const runtime = "nodejs";

/**
 * Public application: NO session (proxy-policy allowlist). Abuse controls:
 * a honeypot field (filled = silent non-write shaped as success) and an
 * in-process per-IP sliding window (5 applications per minute per posting).
 * The window is single-process by design — a multi-replica deployment
 * should front this with its edge limiter; the service-level guards
 * (one candidacy per opening, published postings only, consent capture)
 * hold regardless.
 *
 * Consent is captured in the same transaction as the application
 * (this_application, plus future_roles when opted in).
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const attempts = new Map<string, number[]>();

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function rateLimited(ip: string, postingId: string): boolean {
  const key = `${ip}|${postingId}`;
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  recent.push(now);
  attempts.set(key, recent);
  // Bound the map: drop keys whose window fully expired on every write.
  if (attempts.size > 10_000) {
    for (const [k, v] of attempts) {
      if (v.every((at) => now - at >= WINDOW_MS)) attempts.delete(k);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

export function __resetApplyRateLimitForTests(): void {
  attempts.clear();
}

export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, applyBody);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  // Honeypot filled: shape success, write nothing.
  if (body.website != null && body.website.length > 0) {
    return NextResponse.json({ received: true }, { status: 201 });
  }
  if (rateLimited(clientIp(req), body.postingId)) {
    return NextResponse.json(
      { error: "too many applications from this address — wait a minute and try again" },
      { status: 429 },
    );
  }
  try {
    // The posting carries its org: resolve it inside the service call
    // through the posting row (no session, no org predicate from outside).
    const { applyViaPostingForOrg } = await import("./_org");
    const result = await applyViaPostingForOrg({
      postingId: body.postingId,
      displayName: body.displayName,
      email: body.email,
      phone: body.phone,
      consentFutureRoles: body.consentFutureRoles,
    });
    return NextResponse.json({ received: true, ...result }, { status: 201 });
  } catch (e) {
    return recruitingErrorResponse(e);
  }
}
