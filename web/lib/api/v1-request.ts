import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { jsonObject, parseJsonBody } from "./json";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  resolveApiKeyAuth,
  type ApiKeyAuth,
} from "../api-auth";
import {
  insertApiKeyEvent,
  takeClaimedCommandEvidence,
  transportEvent,
} from "../application/api-key-audit";
import { applicationContextFromApiKey, type ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";

export type V1Result = {
  status: number;
  body: unknown;
  replayed?: boolean;
};

/**
 * Durably evidence one finished request attempt. Material commands already
 * committed their atomic event inside their claim transaction; every other
 * outcome writes its row here — awaited, so a failing audit write fails the
 * response closed instead of dropping the trail.
 */
export async function emitV1ExecutionEvent(
  label: string,
  status: number,
  auth: ApiKeyAuth,
  error?: string,
): Promise<NextResponse | null> {
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
    console.error(`[${label}] execution evidence unavailable`, cause);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export function v1ApplicationContext(auth: ApiKeyAuth, request: Request): ApplicationContext {
  return applicationContextFromApiKey(
    auth,
    "api",
    request.headers.get("x-request-id") || randomUUID(),
  );
}

export function requireV1IdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    throw new ApplicationError("invalid_input", "Idempotency-Key header is required", 400);
  }
  return key;
}

export async function readV1JsonObject(request: Request): Promise<Record<string, unknown>> {
  const parsedBody = await parseJsonBody(request, jsonObject);
  if (!parsedBody.ok) {
    throw new ApplicationError("invalid_input", "invalid request body", parsedBody.response.status);
  }
  const parsed = parsedBody.data;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApplicationError("invalid_input", "invalid JSON body", 400);
  }
  return parsed as Record<string, unknown>;
}

export function mapV1Error(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (error instanceof ZodError) {
    return new ApplicationError("invalid_input", "invalid request body", 422, {
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (error instanceof Error && error.message === "forbidden") {
    return new ApplicationError("forbidden", "forbidden", 403);
  }
  throw error;
}

/**
 * Shared API-key gate for every public v1 route: authenticate, require the
 * apiAccess feature, rate-limit, then evidence the outcome. New routes must
 * use this instead of copying the records adapters.
 */
export async function withV1Request(
  request: Request,
  label: string,
  operation: (auth: ApiKeyAuth, context: ApplicationContext) => Promise<V1Result>,
): Promise<NextResponse> {
  const auth = await resolveApiKeyAuth(request);
  if (!auth) return NextResponse.json({ error: "invalid or missing API key" }, { status: 401 });
  const featureGate = await guardApiKeyFeature(auth, "apiAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
  if (limited) return limited;
  try {
    const result = await operation(auth, v1ApplicationContext(auth, request));
    const tail = await emitV1ExecutionEvent(label, result.status, auth);
    if (tail) return tail;
    return NextResponse.json(result.body, {
      status: result.status,
      headers: {
        "cache-control": "no-store",
        ...(result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) }),
      },
    });
  } catch (error) {
    try {
      const mapped = mapV1Error(error);
      const tail = await emitV1ExecutionEvent(label, mapped.status, auth, mapped.code);
      return tail ?? NextResponse.json(
        { error: mapped.code, message: mapped.message, details: mapped.details },
        { status: mapped.status },
      );
    } catch (unmapped) {
      console.error(`[${label}] application operation failed`, unmapped);
      const tail = await emitV1ExecutionEvent(label, 500, auth, "internal_error");
      return tail ?? NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
  }
}
