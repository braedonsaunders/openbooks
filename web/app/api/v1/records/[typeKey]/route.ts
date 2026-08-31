import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  resolveApiKeyAuth,
  type ApiKeyAuth,
} from "../../../../../lib/api-auth";
import {
  insertApiKeyEvent,
  takeClaimedCommandEvidence,
  transportEvent,
} from "../../../../../lib/application/api-key-audit";
import { applicationContextFromApiKey } from "../../../../../lib/application/context";
import { ApplicationError } from "../../../../../lib/application/errors";
import {
  createApplicationRecord,
  listRecords,
} from "../../../../../lib/application/records";
import { clamp } from "../../../../../lib/list-params";

export const runtime = "nodejs";

/**
 * Durably evidence one finished request attempt. Material commands already
 * committed their atomic event inside their claim transaction (the consumed
 * marker says so); every other outcome writes its row here — awaited, so a
 * failing audit write fails the response closed instead of dropping the trail.
 * Returns a plain 500 to return directly when the event cannot be persisted.
 */
async function emitExecutionEvent(status: number, auth: ApiKeyAuth, error?: string): Promise<NextResponse | null> {
  try {
    if (!takeClaimedCommandEvidence(auth.audit)) {
      await insertApiKeyEvent(transportEvent(
        auth.audit,
        { orgId: auth.user.orgId, keyId: auth.keyId },
        { statusCode: status, error: error ?? null },
      ));
    }
    return null;
  } catch (cause) {
    console.error("[api/v1/records] execution evidence unavailable", cause);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

/** GET /api/v1/records/[typeKey] — same application query used by MCP. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
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
    const tail = await emitExecutionEvent(200, auth);
    if (tail) return tail;
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(auth, error);
  }
}

/** POST /api/v1/records/[typeKey] — exactly-once application command. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ typeKey: string }> },
): Promise<NextResponse> {
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
  if (limited) return limited;
  const { typeKey } = await params;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    const tail = await emitExecutionEvent(400, auth);
    if (tail) return tail;
    return NextResponse.json({ error: "Idempotency-Key header is required" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    const parsedBody = await parseJsonBody(request, jsonObject);
    if (!parsedBody.ok) {
      const tail = await emitExecutionEvent(parsedBody.response.status, auth, "invalid_input");
      if (tail) return tail;
      return parsedBody.response;
    }
    const parsed = parsedBody.data;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return failure(auth, new ApplicationError("invalid_input", "invalid JSON body", 400));
  }
  try {
    const result = await createApplicationRecord(context(auth, request), {
      typeKey,
      body,
      idempotencyKey,
    });
    const tail = await emitExecutionEvent(result.status, auth);
    if (tail) return tail;
    return NextResponse.json(result.result, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        "idempotency-replayed": String(result.replayed),
      },
    });
  } catch (error) {
    return failure(auth, error);
  }
}

function context(auth: ApiKeyAuth, request: Request) {
  return applicationContextFromApiKey(
    auth,
    "api",
    request.headers.get("x-request-id") || randomUUID(),
  );
}

async function failure(auth: ApiKeyAuth, error: unknown): Promise<NextResponse> {
  if (error instanceof ApplicationError) {
    const tail = await emitExecutionEvent(error.status, auth, error.code);
    return tail ?? NextResponse.json(
      { error: error.code, message: error.message, details: error.details },
      { status: error.status },
    );
  }
  console.error("[api/v1/records] application operation failed", error);
  const tail = await emitExecutionEvent(500, auth, "internal_error");
  return tail ?? NextResponse.json({ error: "internal_error" }, { status: 500 });
}
