import { NextResponse } from "next/server";
import { AutomationContractError } from "@openbooks/engine/automations/triggers";
import {
  AutomationServiceError,
  AutomationVersionConflictError,
} from "@openbooks/engine/automations/services";
import { AutomationExecuteError } from "@openbooks/engine/automations/execute";
import { ActionReasonError } from "@openbooks/engine/automations/action-reasons";
import { EventVerbError } from "@openbooks/engine/hrm/change-event-actions";

/**
 * Shared error mapping for /api/automations/* and the HRM verb
 * routes. Engine refusals reach the caller with their message intact
 * (the remedy lives in the message) — never a success, never a bare
 * 'internal error' for a computed refusal.
 */
export function automationErrorResponse(e: unknown): NextResponse {
  // A save over a moved recipe is a conflict, never a validation failure:
  // the caller reloads the stored version and re-applies, so the response
  // carries it.
  if (e instanceof AutomationVersionConflictError) {
    return NextResponse.json(
      {
        error: e.message,
        code: "automation_stale_version",
        version: e.currentVersion,
      },
      { status: 409 },
    );
  }
  if (
    e instanceof AutomationContractError ||
    e instanceof AutomationServiceError ||
    e instanceof AutomationExecuteError ||
    e instanceof ActionReasonError ||
    e instanceof EventVerbError
  ) {
    const message = (e as Error).message;
    const status = /not found/i.test(message)
      ? 404
      : /requires the .* permission/i.test(message)
        ? 403
        : 422;
    return NextResponse.json({ error: message }, { status });
  }
  console.error("[automations] endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export const RUN_IDEMPOTENCY_KEY_MAX_LENGTH = 200;

export type RunInvocationKey = { ok: true; fingerprint: string } | { ok: false; error: string };

/**
 * Per-invocation identity for a run-now request. A caller that sends an
 * Idempotency-Key gets a run keyed by that value, so a retried or
 * double-submitted request collapses onto one run. A request without the
 * header is a new deliberate invocation and receives a fresh key, so it
 * always runs anew.
 */
export function resolveRunInvocationKey(
  headerValue: string | null,
  actorId: string,
): RunInvocationKey {
  if (headerValue === null) {
    return { ok: true, fingerprint: `manual:${crypto.randomUUID()}` };
  }
  const key = headerValue.trim();
  if (key.length === 0) {
    return {
      ok: false,
      error:
        "Idempotency-Key header is empty — send a non-empty key, or omit the header to run a new invocation",
    };
  }
  if (key.length > RUN_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: `Idempotency-Key header must be at most ${RUN_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    };
  }
  // Scoped to the caller: another user reusing a key never receives this
  // user's run.
  return { ok: true, fingerprint: `manual:${actorId}:${key}` };
}
