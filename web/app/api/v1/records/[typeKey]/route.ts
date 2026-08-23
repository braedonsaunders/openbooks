import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  logKeyEvent,
  resolveApiKeyAuth,
  type ApiKeyAuth,
} from "../../../../../lib/api-auth";
import { applicationContextFromApiKey } from "../../../../../lib/application/context";
import { ApplicationError } from "../../../../../lib/application/errors";
import {
  createApplicationRecord,
  listRecords,
} from "../../../../../lib/application/records";
import { clamp } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/** GET /api/v1/records/[typeKey] — same application query used by MCP. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const start = Date.now();
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth, request, start);
  if (limited) return limited;
  const { typeKey } = await params;
  const url = new URL(request.url);
  try {
    const result = await listRecords(context(auth, request), {
      typeKey,
      query: url.searchParams.get("q")?.trim() || undefined,
      page: clamp(Number(url.searchParams.get("page") ?? "1"), 1, 10_000),
      perPage: clamp(Number(url.searchParams.get("perPage") ?? "25"), 5, 100),
      subsidiaryId: url.searchParams.get("subsidiaryId") || undefined,
    });
    done(request, start, 200, auth);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(request, start, auth, error);
  }
}

/** POST /api/v1/records/[typeKey] — exactly-once application command. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const start = Date.now();
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth, request, start);
  if (limited) return limited;
  const { typeKey } = await params;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    done(request, start, 400, auth);
    return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    const parsed = parsedBody.data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    done(request, start, 400, auth);
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const result = await createApplicationRecord(context(auth, request), {
      typeKey,
      body,
      idempotencyKey,
    });
    done(request, start, result.status, auth);
    return NextResponse.json(result.result, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        "idempotency-replayed": String(result.replayed),
      },
    });
  } catch (error) {
    return failure(request, start, auth, error);
  }
}

function context(auth: ApiKeyAuth, request: Request) {
  return applicationContextFromApiKey(
    auth,
    "api",
    request.headers.get("x-request-id") || randomUUID(),
  );
}

function failure(request: Request, start: number, auth: ApiKeyAuth, error: unknown): NextResponse {
  if (error instanceof ApplicationError) {
    done(request, start, error.status, auth, error.code);
    return NextResponse.json(
      { error: error.code, message: error.message, details: error.details },
      { status: error.status },
    );
  }
  console.error("[api/v1/records] application operation failed", error);
  done(request, start, 500, auth, "internal_error");
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}

function done(request: Request, start: number, status: number, auth: ApiKeyAuth, error?: string): void {
  logKeyEvent({
    orgId: auth.user.orgId,
    keyId: auth.keyId,
    method: request.method,
    path: new URL(request.url).pathname,
    statusCode: status,
    durationMs: Date.now() - start,
    req: request,
    error,
  });
}
