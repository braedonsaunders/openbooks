import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  logKeyEvent,
  resolveApiKeyAuth,
  type ApiKeyAuth,
} from "../../../../../../lib/api-auth";
import { applicationContextFromApiKey } from "../../../../../../lib/application/context";
import { ApplicationError } from "../../../../../../lib/application/errors";
import {
  deleteApplicationRecord,
  getRecord,
  updateApplicationRecord,
} from "../../../../../../lib/application/records";

export const runtime = "nodejs";

export async function GET(request: Request, route: RouteContext): Promise<NextResponse> {
  return withAuth(request, route, async (auth, typeKey, id) => {
    const record = await getRecord(context(auth, request), { typeKey, id });
    return { status: 200, body: record };
  });
}

export async function PATCH(request: Request, route: RouteContext): Promise<NextResponse> {
  return mutate(request, route, async (auth, typeKey, id, body, idempotencyKey) => {
    const result = await updateApplicationRecord(context(auth, request), {
      typeKey, id, body, idempotencyKey,
    });
    return { status: result.status, body: result.result, replayed: result.replayed };
  });
}

export async function DELETE(request: Request, route: RouteContext): Promise<NextResponse> {
  return withAuth(request, route, async (auth, typeKey, id) => {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new ApplicationError("invalid_input", "Idempotency-Key header is required", 400);
    const result = await deleteApplicationRecord(context(auth, request), {
      typeKey, id, idempotencyKey,
    });
    return { status: result.status, body: result.result, replayed: result.replayed };
  });
}

type RouteContext = { params: Promise<{ typeKey: string; id: string }> };
type AdapterResult = { status: number; body: unknown; replayed?: boolean };

async function mutate(
  request: Request,
  route: RouteContext,
  operation: (
    auth: ApiKeyAuth,
    typeKey: string,
    id: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) => Promise<AdapterResult>,
): Promise<NextResponse> {
  return withAuth(request, route, async (auth, typeKey, id) => {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey) throw new ApplicationError("invalid_input", "Idempotency-Key header is required", 400);
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed as Record<string, unknown>;
    } catch {
      throw new ApplicationError("invalid_input", "invalid JSON body", 400);
    }
    return operation(auth, typeKey, id, body, idempotencyKey);
  });
}

async function withAuth(
  request: Request,
  route: RouteContext,
  operation: (auth: ApiKeyAuth, typeKey: string, id: string) => Promise<AdapterResult>,
): Promise<NextResponse> {
  const start = Date.now();
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth, request, start);
  if (limited) return limited;
  const { typeKey, id } = await route.params;
  try {
    const result = await operation(auth, typeKey, id);
    done(request, start, result.status, auth);
    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        ...(result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) }),
      },
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      done(request, start, error.status, auth, error.code);
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: error.status },
      );
    }
    console.error("[api/v1/records/:id] application operation failed", error);
    done(request, start, 500, auth, "internal_error");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function context(auth: ApiKeyAuth, request: Request) {
  return applicationContextFromApiKey(
    auth,
    "api",
    request.headers.get("x-request-id") || randomUUID(),
  );
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
