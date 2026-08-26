import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  resolveApiKeyAuth,
  type ApiKeyAuth,
} from "../../../../../../lib/api-auth";
import {
  insertApiKeyEvent,
  takeClaimedCommandEvidence,
  transportEvent,
} from "../../../../../../lib/application/api-key-audit";
import { applicationContextFromApiKey } from "../../../../../../lib/application/context";
import { ApplicationError } from "../../../../../../lib/application/errors";
import {
  deleteApplicationRecord,
  getRecord,
  updateApplicationRecord,
} from "../../../../../../lib/application/records";

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
    console.error("[api/v1/records/:id] execution evidence unavailable", cause);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

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
      const parsedBody = await parseJsonBody(request, jsonObject);
      if (!parsedBody.ok) return parsedBody.response;
      const parsed = parsedBody.data;
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
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
  if (limited) return limited;
  const { typeKey, id } = await route.params;
  try {
    const result = await operation(auth, typeKey, id);
    const tail = await emitExecutionEvent(result.status, auth);
    if (tail) return tail;
    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        ...(result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) }),
      },
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      const tail = await emitExecutionEvent(error.status, auth, error.code);
      return tail ?? NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: error.status },
      );
    }
    console.error("[api/v1/records/:id] application operation failed", error);
    const tail = await emitExecutionEvent(500, auth, "internal_error");
    return tail ?? NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

function context(auth: ApiKeyAuth, request: Request) {
  return applicationContextFromApiKey(
    auth,
    "api",
    request.headers.get("x-request-id") || randomUUID(),
  );
}
